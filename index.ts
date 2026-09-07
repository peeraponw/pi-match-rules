import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type HookDecision,
	type HookDefinition,
	type LoadedHooks,
	type ToolResultContent,
	aggregateHookDecisions,
	buildHookPayload,
	claudeCompactTrigger,
	claudeSessionEndReason,
	claudeSessionStartSource,
	claudeToolName,
	describeHooks,
	fromClaudeToolInput,
	getHookSettingsFiles,
	hookMatcherMatches,
	interpretHookOutcome,
	loadHookSettings,
	runHookCommand,
	textOfContent,
	toClaudeToolInput,
	toClaudeToolResponse,
	toolNamesForHookMatcher,
} from "./hooks.ts";

type FrontmatterValue = boolean | string | string[];
type Frontmatter = Record<string, FrontmatterValue>;

type RuleSource = "global" | "local";

type Rule = {
	absolutePath: string;
	relativePath: string;
	source: RuleSource;
	sourceDir: string;
	frontmatter: Frontmatter;
	patterns: string[];
	alwaysApply: boolean;
	body: string;
};

type LoadedRules = {
	rules: Rule[];
	globalDir: string;
	localDir: string;
	overridden: string[];
};

type RuleDetail = {
	path: string;
	source: RuleSource;
	sourceDir: string;
	patterns: string[];
	alwaysApply: boolean;
};

type LoadClaudeRulesDetails = {
	paths: string[];
	truncated?: boolean;
	rules: RuleDetail[];
};

const DEFAULT_GLOBAL_RULES_DIR = "~/.claude/rules";
const PATTERN_KEYS = ["pattern", "patterns", "path", "paths", "glob", "globs"];
const MAX_TOOL_BYTES = 50 * 1024;
const MAX_TOOL_LINES = 2000;

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function normalizePathForMatch(input: string): string {
	return input
		.trim()
		.replace(/^@+/, "")
		.replace(/^~\//, "")
		.replace(/^\.\//, "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "");
}

function stripQuotes(input: string): string {
	const trimmed = input.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseScalar(value: string): FrontmatterValue {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map(stripQuotes)
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return stripQuotes(trimmed);
}

export function parseMarkdownRule(content: string): {
	frontmatter: Frontmatter;
	body: string;
	hasFrontmatter: boolean;
} {
	if (!content.startsWith("---\n")) {
		return { frontmatter: {}, body: content.trim(), hasFrontmatter: false };
	}

	const end = content.indexOf("\n---", 4);
	if (end === -1) {
		return { frontmatter: {}, body: content.trim(), hasFrontmatter: false };
	}

	const frontmatter: Frontmatter = {};
	const frontmatterText = content.slice(4, end).replace(/\r\n/g, "\n");
	const body = content.slice(end + "\n---".length).trim();
	let currentListKey: string | undefined;

	for (const line of frontmatterText.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;

		const listMatch = line.match(/^\s*-\s*(.+)$/);
		if (listMatch && currentListKey) {
			const existing = frontmatter[currentListKey];
			const values = Array.isArray(existing) ? existing : [];
			frontmatter[currentListKey] = [...values, stripQuotes(listMatch[1] ?? "")];
			continue;
		}

		const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!keyMatch) continue;

		const key = keyMatch[1] ?? "";
		const value = keyMatch[2] ?? "";
		if (value.trim() === "") {
			frontmatter[key] = [];
			currentListKey = key;
		} else {
			frontmatter[key] = parseScalar(value);
			currentListKey = undefined;
		}
	}

	return { frontmatter, body, hasFrontmatter: true };
}

function getStringValues(value: FrontmatterValue | undefined): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value;
	return [];
}

function frontmatterPatterns(frontmatter: Frontmatter): string[] {
	const patterns = new Set<string>();
	for (const key of PATTERN_KEYS) {
		for (const pattern of getStringValues(frontmatter[key])) {
			const normalized = normalizePathForMatch(pattern);
			if (normalized) patterns.add(normalized);
		}
	}
	return [...patterns];
}

function escapeRegexChar(char: string): string {
	return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegex(pattern: string): RegExp {
	let source = "^";
	let index = 0;

	while (index < pattern.length) {
		const char = pattern[index];
		const next = pattern[index + 1];

		if (char === "*" && next === "*") {
			const after = pattern[index + 2];
			if (after === "/") {
				source += "(?:.*/)?";
				index += 3;
			} else {
				source += ".*";
				index += 2;
			}
			continue;
		}

		if (char === "*") {
			source += "[^/]*";
			index += 1;
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}

		if (char === "[") {
			const close = pattern.indexOf("]", index + 1);
			if (close !== -1) {
				source += pattern.slice(index, close + 1);
				index = close + 1;
				continue;
			}
		}

		if (char === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close !== -1) {
				const alternatives = pattern
					.slice(index + 1, close)
					.split(",")
					.map((part) => part.split("").map(escapeRegexChar).join(""));
				source += `(?:${alternatives.join("|")})`;
				index = close + 1;
				continue;
			}
		}

		source += escapeRegexChar(char ?? "");
		index += 1;
	}

	return new RegExp(`${source}$`);
}

function matchesPattern(pattern: string, candidate: string): boolean {
	const normalizedPattern = normalizePathForMatch(pattern);
	const normalizedCandidate = normalizePathForMatch(candidate);
	if (!normalizedPattern || !normalizedCandidate) return false;

	const regex = globToRegex(normalizedPattern);
	if (regex.test(normalizedCandidate)) return true;

	if (!normalizedPattern.includes("/")) {
		return regex.test(path.posix.basename(normalizedCandidate));
	}

	return false;
}

function findMarkdownFiles(dir: string, basePath = ""): string[] {
	if (!fs.existsSync(dir)) return [];

	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
		const absolutePath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(absolutePath, relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(relativePath);
		}
	}

	return results.sort();
}

export function loadRules(rulesDir: string, source: RuleSource): Rule[] {
	return findMarkdownFiles(rulesDir).map((relativePath) => {
		const absolutePath = path.join(rulesDir, relativePath);
		const content = fs.readFileSync(absolutePath, "utf8");
		const { frontmatter, body, hasFrontmatter } = parseMarkdownRule(content);
		const alwaysApply = !hasFrontmatter || frontmatter.alwaysApply === true;

		return {
			absolutePath,
			relativePath,
			source,
			sourceDir: rulesDir,
			frontmatter,
			patterns: frontmatterPatterns(frontmatter),
			alwaysApply,
			body,
		};
	});
}

function getGlobalRulesDir(): string {
	return expandHome(process.env.PI_CLAUDE_RULES_DIR ?? DEFAULT_GLOBAL_RULES_DIR);
}

function getLocalRulesDir(cwd: string): string {
	return path.join(cwd, ".claude", "rules");
}

function loadMergedRules(cwd: string): LoadedRules {
	const globalDir = getGlobalRulesDir();
	const localDir = getLocalRulesDir(cwd);
	const byName = new Map<string, Rule>();
	const overridden: string[] = [];

	for (const rule of loadRules(globalDir, "global")) {
		byName.set(rule.relativePath, rule);
	}

	for (const rule of loadRules(localDir, "local")) {
		if (byName.has(rule.relativePath)) overridden.push(rule.relativePath);
		byName.set(rule.relativePath, rule);
	}

	const rules = [...byName.values()].sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath) || a.source.localeCompare(b.source),
	);

	return { rules, globalDir, localDir, overridden: overridden.sort() };
}

function extractPathCandidates(prompt: string): string[] {
	const candidates = new Set<string>();
	const pathLike = /(?:^|[\s("'`])(@?(?:\.{1,2}\/|~\/|\/)?[A-Za-z0-9._%+=:,/{}\[\]-]+\/[A-Za-z0-9._%+=:,/{}\[\]-]+|@?[A-Za-z0-9._%+=:,{}\[\]-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s)"'`,:;])/g;

	for (const match of prompt.matchAll(pathLike)) {
		const candidate = normalizePathForMatch(match[1] ?? "");
		if (candidate) candidates.add(candidate);
	}

	return [...candidates];
}

export function matchingRules(rules: Rule[], candidates: string[]): Rule[] {
	return rules.filter((rule) => {
		if (rule.alwaysApply) return true;
		if (rule.patterns.length === 0) return false;
		return candidates.some((candidate) =>
			rule.patterns.some((pattern) => matchesPattern(pattern, candidate)),
		);
	});
}

function formatRulesForPrompt(rules: Rule[], reason: string): string {
	const sections = rules.map((rule) => {
		const header = `### ${rule.absolutePath}`;
		const matchInfo = rule.alwaysApply
			? "alwaysApply: true"
			: `patterns: ${rule.patterns.join(", ")}`;
		return `${header}\nsource: ${rule.source}\n${matchInfo}\n\n${rule.body}`;
	});

	return `## Claude Rules\n\nLoaded rules (${reason}). Apply these rules as active instructions.\n\n${sections.join("\n\n---\n\n")}`;
}

function formatRuleIndex(rules: Rule[]): string {
	const conditional = rules.filter((rule) => !rule.alwaysApply && rule.patterns.length > 0);
	if (conditional.length === 0) return "";

	const rows = conditional.map(
		(rule) => `- ${rule.absolutePath} (${rule.source}) — ${rule.patterns.join(", ")}`,
	);

	return `\n\n## Conditional Claude Rules Index\n\nAdditional rules are available. If you later work with a file matching one of these patterns, read the matching rule file before making changes.\n\n${rows.join("\n")}`;
}

function describeRules(loaded: LoadedRules): string {
	const always = loaded.rules.filter((rule) => rule.alwaysApply).length;
	const conditional = loaded.rules.filter(
		(rule) => !rule.alwaysApply && rule.patterns.length > 0,
	).length;
	const inactive = loaded.rules.length - always - conditional;
	const overrides = loaded.overridden.length > 0
		? `, ${loaded.overridden.length} local override(s)`
		: "";
	return `Claude rules: ${loaded.rules.length} loaded from ${loaded.globalDir} and ${loaded.localDir} (${always} always, ${conditional} conditional, ${inactive} without patterns${overrides})`;
}

function truncateForTool(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const output: string[] = [];
	let bytes = 0;

	for (const line of lines) {
		if (output.length >= MAX_TOOL_LINES) break;

		const next = output.length === 0 ? line : `\n${line}`;
		const nextBytes = Buffer.byteLength(next, "utf8");
		if (bytes + nextBytes > MAX_TOOL_BYTES) break;

		output.push(line);
		bytes += nextBytes;
	}

	const truncated = output.length < lines.length || bytes < Buffer.byteLength(text, "utf8");
	const suffix = truncated
		? `\n\n[Output truncated to ${MAX_TOOL_LINES} lines / ${MAX_TOOL_BYTES} bytes. Narrow the path list or read the specific rule file for the full text.]`
		: "";

	return { text: output.join("\n") + suffix, truncated };
}

const AGENTS_CONTEXT_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];
const SUBDIR_CONTEXT_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

export function subdirAgentsEnabled(): boolean {
	const raw = process.env.PI_SUBDIR_AGENTS_MD;
	if (raw === undefined || raw === "") return true;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function firstContextFileInDir(dir: string): string | undefined {
	for (const name of AGENTS_CONTEXT_CANDIDATES) {
		const filePath = path.join(dir, name);
		try {
			if (fs.statSync(filePath).isFile()) return filePath;
		} catch {
			// Missing candidate, try the next name.
		}
	}
	return undefined;
}

/** Resolve through symlinks where the path exists, keeping the leaf for new files. */
function resolveForWalk(input: string, cwd: string): string {
	const absolute = path.resolve(cwd, input.trim());
	try {
		return fs.realpathSync(absolute);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
		} catch {
			return absolute;
		}
	}
}

/**
 * Context files pi itself does not load, namely the ones sitting in directories
 * strictly below cwd on the way to target, ordered from cwd outward.
 */
export function findSubdirContextFiles(cwd: string, target: string): string[] {
	const resolvedCwd = resolveForWalk(cwd, process.cwd());
	const resolvedTarget = resolveForWalk(target, resolvedCwd);
	const relative = path.relative(resolvedCwd, resolvedTarget);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return [];

	const segments = relative.split(path.sep);
	let dirCount = segments.length;
	try {
		if (!fs.statSync(resolvedTarget).isDirectory()) dirCount -= 1;
	} catch {
		dirCount -= 1;
	}

	const files: string[] = [];
	let current = resolvedCwd;
	for (const segment of segments.slice(0, dirCount)) {
		current = path.join(current, segment);
		const file = firstContextFileInDir(current);
		if (file !== undefined) files.push(file);
	}
	return files;
}

function formatSubdirContextFiles(entries: Array<{ path: string; body: string }>): string {
	const sections = entries.map((entry) => `### ${entry.path}\n\n${entry.body}`);
	return `## Subdirectory context files\n\npi does not load AGENTS.md from subdirectories at startup. These files govern the directories touched by the tool result above. Apply them as active instructions for files under their directory.\n\n${sections.join("\n\n---\n\n")}`;
}

export function buildSubdirContextAppendix(
	toolName: string,
	input: unknown,
	cwd: string,
	injected: Set<string>,
): string {
	if (!SUBDIR_CONTEXT_TOOLS.has(toolName)) return "";
	if (input === null || typeof input !== "object" || !("path" in input)) return "";
	const target = input.path;
	if (typeof target !== "string" || target.trim() === "") return "";

	const entries: Array<{ path: string; body: string }> = [];
	for (const file of findSubdirContextFiles(cwd, target)) {
		if (injected.has(file)) continue;
		injected.add(file);
		try {
			const body = fs.readFileSync(file, "utf8").trim();
			if (body !== "") entries.push({ path: file, body });
		} catch (error) {
			console.error(`pi-match-rules: failed to read ${file}: ${(error as Error).message}`);
		}
	}
	if (entries.length === 0) return "";
	return truncateForTool(formatSubdirContextFiles(entries)).text;
}

export default function claudeRuleMatcher(pi: ExtensionAPI) {
	let loadedRules: LoadedRules = {
		rules: [],
		globalDir: getGlobalRulesDir(),
		localDir: getLocalRulesDir(process.cwd()),
		overridden: [],
	};
	let rules: Rule[] = [];
	let loadedHooks: LoadedHooks = {
		hooks: [],
		sourceFiles: [],
		disabled: false,
		unmappedEvents: [],
		skippedHandlers: 0,
		errors: [],
	};
	// Context queued by SessionStart hooks, flushed into the first prompt.
	let sessionContextQueue: string[] = [];
	// PreToolUse additionalContext, appended to the matching tool result.
	const pendingToolContext = new Map<string, string>();
	// Subdirectory AGENTS.md files already appended this session, keyed by absolute path.
	const injectedSubdirContext = new Set<string>();

	type HookBridgeContext = {
		cwd: string;
		ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
		sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
	};

	function reloadRules(cwd: string): string {
		loadedRules = loadMergedRules(cwd);
		rules = loadedRules.rules;
		injectedSubdirContext.clear();
		return describeRules(loadedRules);
	}

	function reloadHooks(cwd: string): LoadedHooks {
		loadedHooks = loadHookSettings(getHookSettingsFiles(cwd));
		return loadedHooks;
	}

	function hooksFor(claudeEvent: string): HookDefinition[] {
		return loadedHooks.hooks.filter((hook) => hook.event === claudeEvent);
	}

	function surfaceDecision(
		decision: HookDecision,
		ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
		claudeEvent: string,
	): void {
		if (decision.systemMessage !== undefined) {
			ctx.ui.notify(decision.systemMessage, "warning");
		}
		for (const note of decision.notifications) {
			ctx.ui.notify(`claude-hooks ${claudeEvent}: ${note}`, "warning");
		}
	}

	async function runClaudeHookSet(
		definitions: HookDefinition[],
		claudeEvent: string,
		extra: Record<string, unknown>,
		ctx: HookBridgeContext,
	): Promise<HookDecision> {
		if (loadedHooks.disabled || definitions.length === 0) {
			return aggregateHookDecisions([]);
		}
		const payload = buildHookPayload(
			{
				sessionId: ctx.sessionManager.getSessionId(),
				transcriptPath: ctx.sessionManager.getSessionFile(),
				cwd: ctx.cwd,
			},
			claudeEvent,
			extra,
		);
		// Claude runs all matching hooks in parallel.
		const outcomes = await Promise.all(
			definitions.map((definition) => runHookCommand(definition.spec, payload, ctx.cwd)),
		);
		return aggregateHookDecisions(
			outcomes.map((outcome) => interpretHookOutcome(claudeEvent, outcome)),
		);
	}

	function lastAssistantText(messages: unknown[]): string {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index] as { role?: string; content?: unknown } | null;
			if (message === null || typeof message !== "object" || message.role !== "assistant") {
				continue;
			}
			const content = message.content;
			if (!Array.isArray(content)) return "";
			return textOfContent(content as ToolResultContent);
		}
		return "";
	}

	pi.on("session_start", async (event, ctx) => {
		try {
			const summary = reloadRules(ctx.cwd);
			ctx.ui.setStatus("claude-rules", `${rules.length} rules`);
			if (rules.length > 0) ctx.ui.notify(summary, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to load Claude rules: ${(error as Error).message}`, "error");
		}

		reloadHooks(ctx.cwd);
		ctx.ui.setStatus(
			"claude-hooks",
			loadedHooks.disabled ? "off" : `${loadedHooks.hooks.length} hooks`,
		);
		const source = claudeSessionStartSource(event.reason);
		const sessionDefs = hooksFor("SessionStart").filter((hook) =>
			hookMatcherMatches(hook.matcher, [source]),
		);
		if (sessionDefs.length > 0 && !loadedHooks.disabled) {
			try {
				const decision = await runClaudeHookSet(sessionDefs, "SessionStart", { source }, ctx);
				surfaceDecision(decision, ctx, "SessionStart");
				if (decision.contextText !== undefined) sessionContextQueue.push(decision.contextText);
			} catch (error) {
				ctx.ui.notify(`claude-hooks SessionStart failed: ${(error as Error).message}`, "error");
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let systemPrompt: string | undefined;
		if (rules.length > 0) {
			const candidates = extractPathCandidates(event.prompt);
			const activeRules = matchingRules(rules, candidates);
			if (activeRules.length > 0) {
				const reason = candidates.length > 0
					? `matched prompt paths: ${candidates.join(", ")}`
					: "alwaysApply rules";
				systemPrompt =
					event.systemPrompt +
					"\n\n" +
					formatRulesForPrompt(activeRules, reason) +
					formatRuleIndex(rules);
			}
		}

		// UserPromptSubmit hooks, plus context queued by SessionStart hooks.
		const contextParts = [...sessionContextQueue];
		sessionContextQueue = [];
		const promptDefs = hooksFor("UserPromptSubmit");
		if (promptDefs.length > 0 && !loadedHooks.disabled) {
			try {
				const decision = await runClaudeHookSet(
					promptDefs,
					"UserPromptSubmit",
					{ prompt: event.prompt },
					ctx,
				);
				surfaceDecision(decision, ctx, "UserPromptSubmit");
				if (decision.contextText !== undefined) contextParts.push(decision.contextText);
			} catch (error) {
				ctx.ui.notify(
					`claude-hooks UserPromptSubmit failed: ${(error as Error).message}`,
					"error",
				);
			}
		}
		const message =
			contextParts.length > 0
				? { customType: "claude-hooks", content: contextParts.join("\n\n"), display: false }
				: undefined;

		if (systemPrompt === undefined && message === undefined) return;
		return {
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			...(message !== undefined ? { message } : {}),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (loadedHooks.disabled) return;
		const defs = hooksFor("PreToolUse").filter((hook) =>
			hookMatcherMatches(hook.matcher, toolNamesForHookMatcher(event.toolName)),
		);
		if (defs.length === 0) return;

		let decision: HookDecision;
		try {
			decision = await runClaudeHookSet(
				defs,
				"PreToolUse",
				{
					tool_name: claudeToolName(event.toolName),
					tool_input: toClaudeToolInput(event.toolName, event.input as Record<string, unknown>),
					tool_use_id: event.toolCallId,
				},
				ctx,
			);
		} catch (error) {
			ctx.ui.notify(`claude-hooks PreToolUse failed: ${(error as Error).message}`, "error");
			return;
		}
		surfaceDecision(decision, ctx, "PreToolUse");

		if (
			decision.updatedInput !== undefined &&
			decision.blockReason === undefined &&
			decision.askReason === undefined
		) {
			const translated = fromClaudeToolInput(event.toolName, decision.updatedInput);
			const input = event.input as Record<string, unknown>;
			for (const key of Object.keys(input)) delete input[key];
			Object.assign(input, translated);
		}
		if (decision.resultAppendix !== undefined) {
			pendingToolContext.set(event.toolCallId, decision.resultAppendix);
		}
		if (decision.blockReason !== undefined) {
			return { block: true, reason: decision.blockReason };
		}
		if (decision.askReason !== undefined && ctx.hasUI) {
			const allowed = await ctx.ui.confirm(
				"Claude hook",
				`${decision.askReason}\n\nAllow this ${event.toolName} call?`,
			);
			if (!allowed) return { block: true, reason: decision.askReason };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const claudeEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
		const defs = loadedHooks.disabled
			? []
			: hooksFor(claudeEvent).filter((hook) =>
					hookMatcherMatches(hook.matcher, toolNamesForHookMatcher(event.toolName)),
			);
		const preToolContext = pendingToolContext.get(event.toolCallId);
		pendingToolContext.delete(event.toolCallId);
		const subdirContext = subdirAgentsEnabled()
			? buildSubdirContextAppendix(event.toolName, event.input, ctx.cwd, injectedSubdirContext)
			: "";
		if (defs.length === 0 && preToolContext === undefined && subdirContext === "") return;

		const input = event.input as Record<string, unknown>;
		const content = event.content;
		let hookAppendix = preToolContext ?? "";
		let markError = false;
		if (defs.length > 0) {
			const extra: Record<string, unknown> = {
				tool_name: claudeToolName(event.toolName),
				tool_input: toClaudeToolInput(event.toolName, input),
				tool_use_id: event.toolCallId,
			};
			if (event.isError) {
				extra.error = textOfContent(content);
				extra.is_interrupt = false;
			} else {
				extra.tool_response = toClaudeToolResponse(event.toolName, input, content, event.isError);
			}
			try {
				const decision = await runClaudeHookSet(defs, claudeEvent, extra, ctx);
				surfaceDecision(decision, ctx, claudeEvent);
				if (decision.resultAppendix !== undefined) {
					hookAppendix =
					hookAppendix === "" ? decision.resultAppendix : `${hookAppendix}\n\n${decision.resultAppendix}`;
				}
				markError = decision.markResultError;
			} catch (error) {
				ctx.ui.notify(`claude-hooks ${claudeEvent} failed: ${(error as Error).message}`, "error");
			}
		}
		const extraBlocks: Array<{ type: "text"; text: string }> = [];
		if (subdirContext !== "") {
			extraBlocks.push({ type: "text", text: `\n[Subdirectory AGENTS.md]\n${subdirContext}` });
		}
		if (hookAppendix !== "") {
			extraBlocks.push({ type: "text", text: `\n[Claude hook feedback]\n${hookAppendix}` });
		}
		if (extraBlocks.length === 0) return;
		return {
			content: [...content, ...extraBlocks],
			...(markError ? { isError: true } : {}),
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (loadedHooks.disabled) return;
		const defs = hooksFor("Stop");
		if (defs.length === 0) return;
		try {
			const decision = await runClaudeHookSet(
				defs,
				"Stop",
				{ stop_hook_active: false, last_assistant_message: lastAssistantText(event.messages) },
				ctx,
			);
			surfaceDecision(decision, ctx, "Stop");
		} catch (error) {
			ctx.ui.notify(`claude-hooks Stop failed: ${(error as Error).message}`, "error");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (loadedHooks.disabled) return;
		const defs = hooksFor("TeammateIdle");
		if (defs.length === 0) return;
		try {
			const decision = await runClaudeHookSet(defs, "TeammateIdle", {}, ctx);
			surfaceDecision(decision, ctx, "TeammateIdle");
		} catch (error) {
			ctx.ui.notify(`claude-hooks TeammateIdle failed: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		if (loadedHooks.disabled) return;
		const trigger = claudeCompactTrigger(event.reason);
		const defs = hooksFor("PostCompact").filter((hook) =>
			hookMatcherMatches(hook.matcher, [trigger]),
		);
		if (defs.length === 0) return;
		try {
			const decision = await runClaudeHookSet(
				defs,
				"PostCompact",
				{ trigger, compact_summary: event.compactionEntry.summary },
				ctx,
			);
			surfaceDecision(decision, ctx, "PostCompact");
		} catch (error) {
			ctx.ui.notify(`claude-hooks PostCompact failed: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (loadedHooks.disabled) return;
		const defs = hooksFor("SessionEnd");
		if (defs.length === 0) return;
		try {
			const decision = await runClaudeHookSet(
				defs,
				"SessionEnd",
				{ reason: claudeSessionEndReason(event.reason) },
				ctx,
			);
			surfaceDecision(decision, ctx, "SessionEnd");
		} catch (error) {
			ctx.ui.notify(`claude-hooks SessionEnd failed: ${(error as Error).message}`, "error");
		}
	});

	pi.registerTool({
		name: "load_claude_rules",
		label: "Load Claude Rules",
		description:
			"Load Markdown rules from global and local .claude/rules directories matching one or more file paths. Output is truncated to 50KB or 2000 lines.",
		promptSnippet: "Load global/local .claude/rules content matching file paths",
		promptGuidelines: [
			"Use load_claude_rules before editing or creating files when their paths may match conditional Claude rules.",
		],
		parameters: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Project-relative or absolute file paths to match against rule frontmatter patterns.",
				},
				includeAlways: {
					type: "boolean",
					description: "Include alwaysApply rules in addition to path-matched rules. Defaults to true.",
				},
			},
			required: ["paths"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params) {
			const input = params as { paths: string[]; includeAlways?: boolean };
			const candidates = input.paths.map(normalizePathForMatch).filter(Boolean);
			const includeAlways = input.includeAlways !== false;
			const activeRules = matchingRules(rules, candidates).filter(
				(rule) => includeAlways || !rule.alwaysApply,
			);

			const ruleDetails: RuleDetail[] = activeRules.map((rule) => ({
				path: rule.absolutePath,
				source: rule.source,
				sourceDir: rule.sourceDir,
				patterns: rule.patterns,
				alwaysApply: rule.alwaysApply,
			}));

			if (activeRules.length === 0) {
				const emptyDetails: LoadClaudeRulesDetails = { paths: candidates, rules: [] };
				return {
					content: [{ type: "text", text: `No Claude rules matched: ${candidates.join(", ")}` }],
					details: emptyDetails,
				};
			}

			const result = truncateForTool(
				formatRulesForPrompt(activeRules, `matched tool paths: ${candidates.join(", ")}`),
			);

			const details: LoadClaudeRulesDetails = {
				paths: candidates,
				truncated: result.truncated,
				rules: ruleDetails,
			};

			return {
				content: [{ type: "text", text: result.text }],
				details,
			};
		},
	});

	pi.registerCommand("claude-hooks", {
		description: "Show or reload Claude settings.json hooks synced to pi events",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "reload") {
				loadedHooks = loadHookSettings(getHookSettingsFiles(ctx.cwd));
				ctx.ui.setStatus(
					"claude-hooks",
					loadedHooks.disabled ? "off" : `${loadedHooks.hooks.length} hooks`,
				);
				ctx.ui.notify(describeHooks(loadedHooks), "info");
				return;
			}

			const lines: string[] = [describeHooks(loadedHooks), ""];
			for (const hook of loadedHooks.hooks) {
				const matcher = hook.matcher === undefined ? "" : ` [${hook.matcher}]`;
				const command = hook.spec.command ?? "";
				const preview = command.length > 80 ? `${command.slice(0, 80)}...` : command;
				lines.push(`- ${hook.event}${matcher} (${path.basename(hook.sourceFile)}): ${preview}`);
			}
			pi.sendMessage({
				customType: "claude-hooks",
			content: lines.join("\n"),
			display: true,
		});
		},
	});

	pi.registerCommand("claude-rules", {
		description: "Show or reload global/local .claude/rules frontmatter-driven rules",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "reload") {
				const summary = reloadRules(ctx.cwd);
				ctx.ui.setStatus("claude-rules", `${rules.length} rules`);
				ctx.ui.notify(summary, "info");
				return;
			}

			if (trimmed) {
				const candidates = trimmed.split(/\s+/).filter(Boolean);
				const activeRules = matchingRules(rules, candidates);
				const content = activeRules.length > 0
					? formatRulesForPrompt(activeRules, `matched command paths: ${candidates.join(", ")}`)
					: `No Claude rules matched: ${candidates.join(", ")}`;
				pi.sendMessage({
					customType: "claude-rules",
					content,
					display: true,
				});
				return;
			}

			ctx.ui.notify(describeRules(loadedRules), "info");
		},
	});
}
