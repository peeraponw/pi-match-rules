import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Claude Code hooks bridge.
//
// Reads hook definitions from Claude settings files (~/.claude/settings.json
// plus project-local .claude/settings.json and .claude/settings.local.json),
// runs them when the matching pi extension event fires, and translates between
// Claude's hook protocol (JSON on stdin, exit codes + JSON on stdout) and pi's
// extension event results.
//
// Protocol reference: https://code.claude.com/docs/en/hooks

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

export type HookHandlerSpec = {
	type?: string;
	command?: string;
	args?: string[];
	shell?: string;
	timeout?: number;
	if?: string;
	async?: boolean;
};

export type HookGroupSpec = {
	matcher?: string;
	hooks?: HookHandlerSpec[];
};

export type HookDefinition = {
	event: string;
	matcher: string | undefined;
	spec: HookHandlerSpec;
	sourceFile: string;
};

export type LoadedHooks = {
	hooks: HookDefinition[];
	sourceFiles: string[];
	disabled: boolean;
	unmappedEvents: string[];
	skippedHandlers: number;
	errors: string[];
};

export const DEFAULT_GLOBAL_SETTINGS_FILE = "~/.claude/settings.json";
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
const MAX_CAPTURE_BYTES = 100 * 1024;
const MAX_CONTEXT_CHARS = 10_000;

// Claude hook event -> pi extension event that triggers it.
export const PI_EVENT_BY_CLAUDE_EVENT: Record<string, string> = {
	SessionStart: "session_start",
	UserPromptSubmit: "before_agent_start",
	PreToolUse: "tool_call",
	PostToolUse: "tool_result",
	PostToolUseFailure: "tool_result",
	Stop: "agent_end",
	TeammateIdle: "agent_settled",
	PostCompact: "session_compact",
	SessionEnd: "session_shutdown",
};

// Claude events whose matcher filters the tool name. SessionStart filters its
// source value, PostCompact its trigger value; the rest ignore matchers.
const TOOL_NAME_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

export function getGlobalSettingsFile(): string {
	return expandHome(process.env.PI_CLAUDE_SETTINGS_FILE ?? DEFAULT_GLOBAL_SETTINGS_FILE);
}

export function getHookSettingsFiles(cwd: string): string[] {
	return [
		getGlobalSettingsFile(),
		path.join(cwd, ".claude", "settings.json"),
		path.join(cwd, ".claude", "settings.local.json"),
	];
}

export function parseHookSettings(content: string): Record<string, HookGroupSpec[]> {
	const parsed = JSON.parse(content) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("settings root is not a JSON object");
	}
	const hooks = (parsed as Record<string, unknown>).hooks;
	if (hooks === undefined || hooks === null) return {};
	if (typeof hooks !== "object" || Array.isArray(hooks)) {
		throw new Error("settings.hooks is not an object");
	}
	const result: Record<string, HookGroupSpec[]> = {};
	for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
		if (!Array.isArray(groups)) continue;
		const parsedGroups = groups
			.filter((group): group is Record<string, unknown> => group !== null && typeof group === "object")
			.map((group) => ({
				matcher: typeof group.matcher === "string" ? group.matcher : undefined,
				hooks: Array.isArray(group.hooks)
					? group.hooks.filter(
							(handler): handler is Record<string, unknown> =>
								handler !== null && typeof handler === "object",
						)
					: [],
			}));
		if (parsedGroups.length > 0) result[event] = parsedGroups;
	}
	return result;
}

export function hooksEnabled(): boolean {
	const raw = process.env.PI_CLAUDE_HOOKS_ENABLED;
	if (raw === undefined || raw === "") return true;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function loadHookSettings(files: string[]): LoadedHooks {
	const result: LoadedHooks = {
		hooks: [],
		sourceFiles: [],
		disabled: !hooksEnabled(),
		unmappedEvents: [],
		skippedHandlers: 0,
		errors: [],
	};
	const seen = new Set<string>();
	const unmapped = new Set<string>();

	for (const file of files) {
		let content: string;
		try {
			if (!fs.existsSync(file)) continue;
			content = fs.readFileSync(file, "utf8");
		} catch (error) {
			result.errors.push(`${file}: ${(error as Error).message}`);
			continue;
		}
		result.sourceFiles.push(file);

		let settings: Record<string, HookGroupSpec[]>;
		try {
			settings = parseHookSettings(content);
		} catch (error) {
			result.errors.push(`${file}: ${(error as Error).message}`);
			continue;
		}

		if ((JSON.parse(content) as { disableAllHooks?: unknown }).disableAllHooks === true) {
			result.disabled = true;
		}

		for (const [event, groups] of Object.entries(settings)) {
			if (!(event in PI_EVENT_BY_CLAUDE_EVENT)) {
				unmapped.add(event);
				continue;
			}
			for (const group of groups) {
				for (const spec of group.hooks ?? []) {
					if (spec.type !== undefined && spec.type !== "command") {
						result.skippedHandlers += 1;
						continue;
					}
					if (spec.if !== undefined) {
						// `if` permission-rule filtering has no pi equivalent;
						// skip rather than run the hook more often than Claude would.
						result.skippedHandlers += 1;
						continue;
					}
					if (typeof spec.command !== "string" || spec.command.trim() === "") {
						result.skippedHandlers += 1;
						continue;
					}
					const dedupeKey = JSON.stringify([event, group.matcher, spec.command, spec.args]);
					if (seen.has(dedupeKey)) continue;
					seen.add(dedupeKey);
					result.hooks.push({ event, matcher: group.matcher, spec, sourceFile: file });
				}
			}
		}
	}

	result.unmappedEvents = [...unmapped].sort();
	return result;
}

// ---------------------------------------------------------------------------
// Matcher evaluation (Claude semantics)
// ---------------------------------------------------------------------------

// pi tool name -> Claude tool names a matcher may use for it.
const CLAUDE_TOOL_NAMES: Record<string, string[]> = {
	bash: ["Bash"],
	powershell: ["Bash", "PowerShell"],
	read: ["Read"],
	write: ["Write"],
	edit: ["Edit", "MultiEdit"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
};

export function claudeToolName(piToolName: string): string {
	return CLAUDE_TOOL_NAMES[piToolName]?.[0] ?? piToolName;
}

export function toolNamesForHookMatcher(piToolName: string): string[] {
	return [piToolName, ...(CLAUDE_TOOL_NAMES[piToolName] ?? [])];
}

// Claude matcher evaluation: "*", "", or omitted matches everything; a value
// containing only word characters, spaces, commas, and pipes is an exact-name
// list; anything else is an unanchored regex.
export function hookMatcherMatches(matcher: string | undefined, values: string[]): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	if (/^[\w,| -]*$/.test(matcher)) {
		return matcher
			.split(/[|,]/)
			.map((part) => part.trim())
			.filter(Boolean)
			.some((part) => values.includes(part));
	}
	try {
		const regex = new RegExp(matcher);
		return values.some((value) => regex.test(value));
	} catch {
		return false;
	}
}

export function isToolNameEvent(claudeEvent: string): boolean {
	return TOOL_NAME_EVENTS.has(claudeEvent);
}

// ---------------------------------------------------------------------------
// Tool input / response translation
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

export function toClaudeToolInput(piToolName: string, input: UnknownRecord): UnknownRecord {
	const out: UnknownRecord = { ...input };
	if (typeof out.path === "string") {
		out.file_path = out.path;
		delete out.path;
	}
	if (piToolName === "edit" && Array.isArray(out.edits)) {
		out.edits = out.edits.map((edit) =>
			edit !== null && typeof edit === "object"
				? { old_string: (edit as UnknownRecord).oldText, new_string: (edit as UnknownRecord).newText }
				: edit,
		);
	}
	return out;
}

export function fromClaudeToolInput(piToolName: string, input: UnknownRecord): UnknownRecord {
	const out: UnknownRecord = { ...input };
	if (typeof out.file_path === "string") {
		out.path = out.file_path;
		delete out.file_path;
	}
	if (piToolName === "edit" && Array.isArray(out.edits)) {
		out.edits = out.edits.map((edit) =>
			edit !== null && typeof edit === "object"
				? { oldText: (edit as UnknownRecord).old_string, newText: (edit as UnknownRecord).new_string }
				: edit,
		);
	}
	return out;
}

export type ToolResultContent = { type: string; text?: string }[];

export function textOfContent(content: ToolResultContent): string {
	return content
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

// Approximation of Claude's per-tool tool_response shapes.
export function toClaudeToolResponse(
	piToolName: string,
	input: UnknownRecord,
	content: ToolResultContent,
	isError: boolean,
): UnknownRecord {
	const text = textOfContent(content);
	switch (piToolName) {
		case "bash":
		case "powershell":
			return { stdout: text, stderr: "", interrupted: false, isImage: false };
		case "write":
		case "edit":
		case "read":
			return { filePath: typeof input.path === "string" ? input.path : "", success: !isError };
		default:
			return { output: text };
	}
}

// ---------------------------------------------------------------------------
// Hook payload
// ---------------------------------------------------------------------------

export type HookPayloadContext = {
	sessionId: string;
	transcriptPath: string | undefined;
	cwd: string;
};

export function buildHookPayload(
	payloadContext: HookPayloadContext,
	claudeEvent: string,
	extra: UnknownRecord = {},
): UnknownRecord {
	const payload: UnknownRecord = {
		session_id: payloadContext.sessionId,
		transcript_path: payloadContext.transcriptPath ?? "",
		cwd: payloadContext.cwd,
		permission_mode: "default",
		hook_event_name: claudeEvent,
	};
	for (const [key, value] of Object.entries(extra)) {
		payload[key] = value;
	}
	return payload;
}

// pi session_start reason -> Claude SessionStart source.
export function claudeSessionStartSource(piReason: string): string {
	switch (piReason) {
		case "new":
			return "clear";
		case "resume":
			return "resume";
		case "fork":
			return "fork";
		default:
			return "startup";
	}
}

// pi session_shutdown reason -> Claude SessionEnd reason.
export function claudeSessionEndReason(piReason: string): string {
	switch (piReason) {
		case "new":
			return "clear";
		case "resume":
			return "resume";
		default:
			return "other";
	}
}

// pi session_compact reason -> Claude PostCompact trigger.
export function claudeCompactTrigger(piReason: string): string {
	return piReason === "manual" ? "manual" : "auto";
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export type HookRunOutcome = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnFailed: boolean;
	errorMessage: string | undefined;
};

function shellFor(spec: HookHandlerSpec): string {
	return spec.shell === "bash" ? "bash" : "sh";
}

export function runHookCommand(
	spec: HookHandlerSpec,
	payload: UnknownRecord,
	cwd: string,
): Promise<HookRunOutcome> {
	return new Promise((resolve) => {
		const timeoutSeconds =
			typeof spec.timeout === "number" && spec.timeout > 0
				? spec.timeout
				: DEFAULT_HOOK_TIMEOUT_SECONDS;
		const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
		const command = spec.command ?? "";

		let child;
		try {
			child = Array.isArray(spec.args)
				? spawn(command, spec.args as string[], { cwd, env })
				: spawn(shellFor(spec), ["-c", command], { cwd, env });
		} catch (error) {
			resolve({
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				spawnFailed: true,
				errorMessage: (error as Error).message,
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (exitCode: number | null, errorMessage?: string) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			resolve({
				exitCode,
				stdout,
				stderr,
				timedOut,
				spawnFailed: errorMessage !== undefined,
				errorMessage,
			});
		};

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
		}, timeoutSeconds * 1000);

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => finish(null, error.message));
		child.on("close", (code) => finish(code));

		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {
			// stdin write races the process exiting; nothing to do.
		}
	});
}

// ---------------------------------------------------------------------------
// Output interpretation
// ---------------------------------------------------------------------------

export type HookDecision = {
	// PreToolUse: block the tool call with this reason.
	blockReason: string | undefined;
	// PreToolUse permissionDecision "ask": confirm with the user first.
	askReason: string | undefined;
	// PreToolUse updatedInput (Claude field names), applied to the tool input.
	updatedInput: UnknownRecord | undefined;
	// PostToolUse/PostToolUseFailure: text appended to the tool result.
	resultAppendix: string | undefined;
	// PostToolUse/PostToolUseFailure exit 2: also mark the result as an error.
	markResultError: boolean;
	// UserPromptSubmit/SessionStart: text to inject into the conversation.
	contextText: string | undefined;
	// systemMessage: user-facing warning.
	systemMessage: string | undefined;
	// Non-blocking errors and limitation notices.
	notifications: string[];
};

export function emptyHookDecision(): HookDecision {
	return {
		blockReason: undefined,
		askReason: undefined,
		updatedInput: undefined,
		resultAppendix: undefined,
		markResultError: false,
		contextText: undefined,
		systemMessage: undefined,
		notifications: [],
	};
}

function truncateContext(text: string): string {
	if (text.length <= MAX_CONTEXT_CHARS) return text;
	return `${text.slice(0, MAX_CONTEXT_CHARS)}\n[claude-hooks: output truncated at ${MAX_CONTEXT_CHARS} characters]`;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.slice(0, 200);
}

function asRecord(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function interpretHookOutcome(claudeEvent: string, outcome: HookRunOutcome): HookDecision {
	const decision = emptyHookDecision();
	const note = (message: string) => decision.notifications.push(message);

	if (outcome.spawnFailed) {
		note(`hook failed to start: ${outcome.errorMessage ?? "unknown error"}`);
		return decision;
	}
	if (outcome.timedOut) {
		// Claude discards output from a timed-out hook; it renders no decision.
		note("hook timed out; output discarded");
		return decision;
	}

	const stdoutText = outcome.stdout.trim();
	let json: UnknownRecord | undefined;
	if (stdoutText.startsWith("{") && stdoutText.endsWith("}")) {
		try {
			json = asRecord(JSON.parse(stdoutText));
			if (json === undefined) note("hook stdout parsed to a non-object; ignoring it");
		} catch {
			note(`hook stdout is not valid JSON: ${firstLine(stdoutText)}`);
		}
	}

	const hookSpecific = asRecord(json?.hookSpecificOutput);
	const permissionDecision =
		asString(hookSpecific?.permissionDecision) ?? asString(json?.permissionDecision);
	const permissionDecisionReason =
		asString(hookSpecific?.permissionDecisionReason) ?? asString(json?.permissionDecisionReason);
	const additionalContext = asString(hookSpecific?.additionalContext);
	const updatedInput = asRecord(hookSpecific?.updatedInput) ?? asRecord(json?.updatedInput);
	const decisionBlock = json?.decision === "block";
	const reason = asString(json?.reason);
	const systemMessage = asString(json?.systemMessage);
	const stopProcessing = json?.continue === false;
	const stopReason = asString(json?.stopReason);
	const plainStdoutContext =
		json === undefined &&
		stdoutText !== "" &&
		(claudeEvent === "UserPromptSubmit" || claudeEvent === "SessionStart")
			? stdoutText
			: undefined;

	if (systemMessage !== undefined) decision.systemMessage = systemMessage;

	if (additionalContext !== undefined) {
		const context = truncateContext(additionalContext);
		switch (claudeEvent) {
			case "UserPromptSubmit":
			case "SessionStart":
				decision.contextText = context;
				break;
			case "PreToolUse":
			case "PostToolUse":
			case "PostToolUseFailure":
				decision.resultAppendix = context;
				break;
			default:
				note(`hook additionalContext (pi cannot inject context here): ${firstLine(context)}`);
		}
	}

	if (plainStdoutContext !== undefined) {
		const context = truncateContext(plainStdoutContext);
		decision.contextText =
			decision.contextText === undefined ? context : `${decision.contextText}\n\n${context}`;
	}

	if (claudeEvent === "PreToolUse") {
		if (permissionDecision === "deny" && decision.blockReason === undefined) {
			decision.blockReason = permissionDecisionReason ?? "denied by Claude hook";
		} else if (permissionDecision === "ask" && decision.askReason === undefined) {
			decision.askReason = permissionDecisionReason ?? "Claude hook asked for confirmation";
		}
		if (updatedInput !== undefined) decision.updatedInput = updatedInput;
	}

	// Exit 2 blocks on every event that can block, and on PreToolUse so does a
	// JSON blocking decision. The blocking message prefers the JSON reason
	// over stderr, matching Claude.
	const jsonBlocksTool = claudeEvent === "PreToolUse" && (decisionBlock || stopProcessing);
	if (outcome.exitCode === 2 || jsonBlocksTool) {
		const rawStderr = outcome.stderr.trim();
		const message =
			reason ??
			stopReason ??
			permissionDecisionReason ??
			(rawStderr !== "" ? rawStderr : "blocked by Claude hook");
		switch (claudeEvent) {
			case "PreToolUse":
				decision.blockReason = truncateContext(message);
				break;
			case "UserPromptSubmit":
				// pi's before_agent_start cannot erase a submitted prompt.
				note(`hook blocked the prompt, but pi cannot cancel it: ${firstLine(message)}`);
				break;
			case "PostToolUse":
			case "PostToolUseFailure":
				// Claude feeds the full stderr back to the model on these events.
				decision.resultAppendix = truncateContext(message);
				decision.markResultError = true;
				break;
			case "Stop":
			case "TeammateIdle":
				note(`hook prevented stopping, but pi cannot resume a finished run: ${firstLine(message)}`);
				break;
			default:
				note(`hook blocking error: ${firstLine(message)}`);
		}
	} else if (decisionBlock) {
		// decision block on events that cannot block: feed the reason back
		switch (claudeEvent) {
			case "PostToolUse":
			case "PostToolUseFailure":
				decision.resultAppendix = truncateContext(reason ?? "blocked by Claude hook");
				break;
			case "Stop":
			case "TeammateIdle":
				note(`hook blocked stopping, but pi cannot resume a finished run: ${reason ?? ""}`);
				break;
			default:
				note(`hook decision block: ${reason ?? ""}`);
		}
	} else if (stopProcessing) {
		note(`hook set continue:false: ${stopReason ?? "processing stopped"}`);
	}

	if (outcome.exitCode !== 0 && outcome.exitCode !== 2 && json === undefined) {
		const detail = outcome.stderr.trim() !== "" ? firstLine(outcome.stderr) : firstLine(stdoutText);
		note(
			detail !== ""
				? `hook failed with exit code ${outcome.exitCode}: ${detail}`
				: `hook failed with exit code ${outcome.exitCode}`,
		);
	}

	return decision;
}

export function aggregateHookDecisions(decisions: HookDecision[]): HookDecision {
	const combined = emptyHookDecision();
	const resultAppendices: string[] = [];
	const contextTexts: string[] = [];
	const notes: string[] = [];

	for (const decision of decisions) {
		if (decision.blockReason !== undefined && combined.blockReason === undefined) {
			combined.blockReason = decision.blockReason;
		}
		if (decision.askReason !== undefined && combined.askReason === undefined) {
			combined.askReason = decision.askReason;
		}
		if (decision.updatedInput !== undefined) combined.updatedInput = decision.updatedInput;
		if (decision.resultAppendix !== undefined) resultAppendices.push(decision.resultAppendix);
		if (decision.markResultError) combined.markResultError = true;
		if (decision.contextText !== undefined) contextTexts.push(decision.contextText);
		if (decision.systemMessage !== undefined) {
			if (combined.systemMessage === undefined) {
				combined.systemMessage = decision.systemMessage;
			} else {
				notes.push(decision.systemMessage);
			}
		}
		notes.push(...decision.notifications);
	}

	if (resultAppendices.length > 0) combined.resultAppendix = resultAppendices.join("\n\n");
	if (contextTexts.length > 0) combined.contextText = contextTexts.join("\n\n");
	combined.notifications = notes;
	// Claude precedence: deny > defer > ask > allow.
	if (combined.blockReason !== undefined) combined.askReason = undefined;
	return combined;
}

export function describeHooks(loaded: LoadedHooks): string {
	if (loaded.disabled) {
		return `Claude hooks disabled (${loaded.sourceFiles.length} settings file(s) found)`;
	}
	const byEvent = new Map<string, number>();
	for (const hook of loaded.hooks) {
		byEvent.set(hook.event, (byEvent.get(hook.event) ?? 0) + 1);
	}
	const summary = [...byEvent.entries()].sort().map(([event, count]) => `${event}: ${count}`);
	const details = [
		`Claude hooks: ${loaded.hooks.length} loaded from ${loaded.sourceFiles.length} settings file(s)`,
	];
	if (summary.length > 0) details.push(summary.join(", "));
	if (loaded.unmappedEvents.length > 0) {
		details.push(`no pi event for: ${loaded.unmappedEvents.join(", ")}`);
	}
	if (loaded.skippedHandlers > 0) {
		details.push(
			`${loaded.skippedHandlers} handler(s) skipped (unsupported type, \`if\` filter, or empty command)`,
		);
	}
	if (loaded.errors.length > 0) {
		details.push(loaded.errors.map((error) => `error: ${error}`).join("; "));
	}
	return details.join(" | ");
}
