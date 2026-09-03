import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type HookHandlerSpec,
	type HookRunOutcome,
	aggregateHookDecisions,
	buildHookPayload,
	claudeCompactTrigger,
	claudeSessionEndReason,
	claudeSessionStartSource,
	claudeToolName,
	describeHooks,
	emptyHookDecision,
	fromClaudeToolInput,
	getGlobalSettingsFile,
	hookMatcherMatches,
	interpretHookOutcome,
	loadHookSettings,
	parseHookSettings,
	runHookCommand,
	toClaudeToolInput,
	toClaudeToolResponse,
	toolNamesForHookMatcher,
} from "./hooks.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-hooks-"));
}

function writeSettings(dir: string, name: string, content: unknown): string {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(content));
	return file;
}

function outcome(partial: Partial<HookRunOutcome>): HookRunOutcome {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		spawnFailed: false,
		errorMessage: undefined,
		...partial,
	};
}

function run(spec: HookHandlerSpec, payload: Record<string, unknown> = {}, cwd = process.cwd()) {
	return runHookCommand(spec, payload, cwd);
}

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

test("parseHookSettings: returns empty object when hooks key is absent", () => {
	assert.deepEqual(parseHookSettings("{}"), {});
	assert.deepEqual(parseHookSettings('{"model": "opus"}'), {});
});

test("parseHookSettings: parses matcher groups and handlers", () => {
	const settings = parseHookSettings(
		JSON.stringify({
			hooks: {
				PostToolUse: [
					{
						matcher: "Write|Edit|MultiEdit",
						hooks: [{ type: "command", command: "lint.sh", timeout: 10 }],
					},
				],
				Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
			},
		}),
	);
	assert.deepEqual(settings["PostToolUse"]?.[0]?.matcher, "Write|Edit|MultiEdit");
	assert.equal(settings["PostToolUse"]?.[0]?.hooks?.[0]?.command, "lint.sh");
	assert.equal(settings["PostToolUse"]?.[0]?.hooks?.[0]?.timeout, 10);
	assert.equal(settings["Stop"]?.[0]?.matcher, undefined);
	assert.equal(settings["Stop"]?.[0]?.hooks?.[0]?.command, "stop.sh");
});

test("parseHookSettings: invalid JSON throws", () => {
	assert.throws(() => parseHookSettings("{nope"));
});

test("parseHookSettings: non-array groups are dropped, null handlers filtered", () => {
	const settings = parseHookSettings(
		JSON.stringify({
			hooks: {
				Stop: "not-an-array",
				PreToolUse: [{ matcher: "Bash", hooks: [null, { command: "x.sh" }] }],
			},
		}),
	);
	assert.equal(settings["Stop"], undefined);
	assert.equal(settings["PreToolUse"]?.[0]?.hooks?.length, 1);
});

test("loadHookSettings: merges global and local files, records unmapped events", () => {
	const dir = tempDir();
	try {
		const globalFile = writeSettings(dir, "global.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "global-stop.sh" }] }] },
		});
		const localFile = writeSettings(path.join(dir, "proj", ".claude"), "settings.json", {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "local-stop.sh" }] }],
				Notification: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
			},
		});

		const loaded = loadHookSettings([globalFile, localFile]);
		assert.deepEqual(loaded.sourceFiles, [globalFile, localFile]);
		assert.deepEqual(
			loaded.hooks.filter((hook) => hook.event === "Stop").map((hook) => hook.spec.command),
			["global-stop.sh", "local-stop.sh"],
		);
		assert.deepEqual(loaded.unmappedEvents, ["Notification"]);
		assert.equal(loaded.disabled, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loadHookSettings: dedupes identical handlers across settings files", () => {
	const dir = tempDir();
	try {
		const a = writeSettings(dir, "a.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "same.sh" }] }] },
		});
		const b = writeSettings(dir, "b.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "same.sh" }] }] },
		});
		const loaded = loadHookSettings([a, b]);
		assert.equal(loaded.hooks.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loadHookSettings: skips non-command handlers and `if` filters", () => {
	const dir = tempDir();
	try {
		const file = writeSettings(dir, "settings.json", {
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{ type: "http", url: "http://localhost" },
							{ type: "command", command: "a.sh", if: "Bash(git *)" },
							{ type: "command", command: "" },
							{ command: "b.sh" },
						],
					},
				],
			},
		});
		const loaded = loadHookSettings([file]);
		assert.equal(loaded.hooks.length, 1);
		assert.equal(loaded.hooks[0]?.spec.command, "b.sh");
		assert.equal(loaded.skippedHandlers, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loadHookSettings: disableAllHooks disables hooks", () => {
	const dir = tempDir();
	try {
		const file = writeSettings(dir, "settings.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }] },
			disableAllHooks: true,
		});
		const loaded = loadHookSettings([file]);
		assert.equal(loaded.disabled, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loadHookSettings: broken JSON records an error and continues", () => {
	const dir = tempDir();
	try {
		const broken = path.join(dir, "broken.json");
		fs.writeFileSync(broken, "{invalid");
		const good = writeSettings(dir, "good.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }] },
		});
		const loaded = loadHookSettings([broken, good]);
		assert.equal(loaded.hooks.length, 1);
		assert.equal(loaded.errors.length, 1);
		assert.match(loaded.errors[0] ?? "", /broken\.json/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("PI_CLAUDE_HOOKS_ENABLED=0 disables hooks and PI_CLAUDE_SETTINGS_FILE overrides the global file", () => {
	const dir = tempDir();
	const previousEnabled = process.env.PI_CLAUDE_HOOKS_ENABLED;
	const previousFile = process.env.PI_CLAUDE_SETTINGS_FILE;
	try {
		const file = writeSettings(dir, "custom-settings.json", {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }] },
		});
		process.env.PI_CLAUDE_SETTINGS_FILE = file;
		assert.equal(getGlobalSettingsFile(), file);

		const loaded = loadHookSettings([file]);
		assert.equal(loaded.disabled, false);

		process.env.PI_CLAUDE_HOOKS_ENABLED = "0";
		assert.equal(loadHookSettings([file]).disabled, true);
	} finally {
		if (previousEnabled === undefined) delete process.env.PI_CLAUDE_HOOKS_ENABLED;
		else process.env.PI_CLAUDE_HOOKS_ENABLED = previousEnabled;
		if (previousFile === undefined) delete process.env.PI_CLAUDE_SETTINGS_FILE;
		else process.env.PI_CLAUDE_SETTINGS_FILE = previousFile;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Matcher evaluation
// ---------------------------------------------------------------------------

test("hookMatcherMatches: empty, omitted, and * match everything", () => {
	for (const matcher of [undefined, "", "*"]) {
		assert.equal(hookMatcherMatches(matcher, ["Bash"]), true);
		assert.equal(hookMatcherMatches(matcher, []), true);
	}
});

test("hookMatcherMatches: exact list form with | and , separators", () => {
	assert.equal(hookMatcherMatches("Write|Edit|MultiEdit", ["Write"]), true);
	assert.equal(hookMatcherMatches("Write|Edit|MultiEdit", ["Bash"]), false);
	assert.equal(hookMatcherMatches("Edit, Write", ["Write"]), true);
	assert.equal(hookMatcherMatches("Edit, Write", ["Read"]), false);
});

test("hookMatcherMatches: regex form for values with other characters", () => {
	assert.equal(hookMatcherMatches("^Notebook", ["NotebookEdit"]), true);
	assert.equal(hookMatcherMatches("^Notebook", ["Edit"]), false);
	assert.equal(hookMatcherMatches("mcp__memory__.*", ["mcp__memory__create"]), true);
	assert.equal(hookMatcherMatches("[invalid", ["Bash"]), false);
});

test("toolNamesForHookMatcher: pi edit maps to Edit and MultiEdit", () => {
	assert.deepEqual(toolNamesForHookMatcher("edit"), ["edit", "Edit", "MultiEdit"]);
	assert.equal(hookMatcherMatches("Write|Edit|MultiEdit", toolNamesForHookMatcher("edit")), true);
	assert.equal(hookMatcherMatches("Write|Edit|MultiEdit", toolNamesForHookMatcher("write")), true);
	assert.equal(hookMatcherMatches("Write|Edit|MultiEdit", toolNamesForHookMatcher("bash")), false);
	assert.equal(claudeToolName("edit"), "Edit");
	assert.equal(claudeToolName("bash"), "Bash");
	assert.equal(claudeToolName("custom_tool"), "custom_tool");
});

// ---------------------------------------------------------------------------
// Tool input / response translation
// ---------------------------------------------------------------------------

test("toClaudeToolInput and fromClaudeToolInput round-trip file tool fields", () => {
	const writeInput = toClaudeToolInput("write", { path: "/tmp/a.txt", content: "x" });
	assert.deepEqual(writeInput, { file_path: "/tmp/a.txt", content: "x" });

	const editInput = toClaudeToolInput("edit", {
		path: "/tmp/a.ts",
		edits: [{ oldText: "a", newText: "b" }],
	});
	assert.deepEqual(editInput, {
		file_path: "/tmp/a.ts",
		edits: [{ old_string: "a", new_string: "b" }],
	});

	const roundTrip = fromClaudeToolInput("edit", editInput);
	assert.deepEqual(roundTrip, {
		path: "/tmp/a.ts",
		edits: [{ oldText: "a", newText: "b" }],
	});

	const bashInput = toClaudeToolInput("bash", { command: "ls", timeout: 5 });
	assert.deepEqual(bashInput, { command: "ls", timeout: 5 });
});

test("toClaudeToolResponse: approximates Claude per-tool shapes", () => {
	assert.deepEqual(toClaudeToolResponse("bash", {}, [{ type: "text", text: "out" }], false), {
		stdout: "out",
		stderr: "",
		interrupted: false,
		isImage: false,
	});
	assert.deepEqual(
		toClaudeToolResponse("write", { path: "/tmp/a.txt" }, [{ type: "text", text: "done" }], false),
		{ filePath: "/tmp/a.txt", success: true },
	);
	assert.deepEqual(
		toClaudeToolResponse("my_tool", {}, [{ type: "text", text: "hi" }], true),
		{ output: "hi" },
	);
});

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

test("buildHookPayload: common fields plus event-specific extras", () => {
	const payload = buildHookPayload(
		{ sessionId: "s1", transcriptPath: "/tmp/session.jsonl", cwd: "/tmp/proj" },
		"UserPromptSubmit",
		{ prompt: "hello" },
	);
	assert.equal(payload.session_id, "s1");
	assert.equal(payload.transcript_path, "/tmp/session.jsonl");
	assert.equal(payload.cwd, "/tmp/proj");
	assert.equal(payload.hook_event_name, "UserPromptSubmit");
	assert.equal(payload.prompt, "hello");

	const empty = buildHookPayload(
		{ sessionId: "s1", transcriptPath: undefined, cwd: "/tmp" },
		"TeammateIdle",
	);
	assert.equal(empty.transcript_path, "");
	assert.equal(empty.hook_event_name, "TeammateIdle");
});

test("reason mapping helpers translate pi event reasons to Claude values", () => {
	assert.equal(claudeSessionStartSource("startup"), "startup");
	assert.equal(claudeSessionStartSource("reload"), "startup");
	assert.equal(claudeSessionStartSource("new"), "clear");
	assert.equal(claudeSessionStartSource("resume"), "resume");
	assert.equal(claudeSessionStartSource("fork"), "fork");
	assert.equal(claudeSessionEndReason("quit"), "other");
	assert.equal(claudeSessionEndReason("new"), "clear");
	assert.equal(claudeSessionEndReason("resume"), "resume");
	assert.equal(claudeCompactTrigger("manual"), "manual");
	assert.equal(claudeCompactTrigger("threshold"), "auto");
	assert.equal(claudeCompactTrigger("overflow"), "auto");
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

test("runHookCommand: passes payload JSON on stdin and returns stdout", async () => {
	const result = await run({ type: "command", command: "cat" }, { hello: "world" });
	assert.equal(result.exitCode, 0);
	assert.equal(JSON.parse(result.stdout).hello, "world");
});

test("runHookCommand: exit 2 captures stderr", async () => {
	const result = await run({ type: "command", command: "echo blocked >&2; exit 2" });
	assert.equal(result.exitCode, 2);
	assert.equal(result.stderr.trim(), "blocked");
});

test("runHookCommand: sets CLAUDE_PROJECT_DIR to the cwd", async () => {
	const dir = tempDir();
	try {
		const result = await run({ type: "command", command: 'printf %s "$CLAUDE_PROJECT_DIR"' }, {}, dir);
		assert.equal(result.stdout, dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runHookCommand: exec form spawns command with args, no shell", async () => {
	const result = await run({ type: "command", command: "printf", args: ["%s", "hello"] });
	assert.equal(result.stdout, "hello");
});

test("runHookCommand: timeout kills the process and discards output", async () => {
	const result = await run({ type: "command", command: "echo started; sleep 5", timeout: 0.3 });
	assert.equal(result.timedOut, true);
	const decision = interpretHookOutcome("PreToolUse", result);
	assert.equal(decision.blockReason, undefined);
	assert.equal(decision.notifications.length, 1);
});

// ---------------------------------------------------------------------------
// Output interpretation
// ---------------------------------------------------------------------------

test("interpretHookOutcome: exit 0 with no output produces no decision", () => {
	const decision = interpretHookOutcome("PreToolUse", outcome({}));
	assert.deepEqual(decision, emptyHookDecision());
});

test("interpretHookOutcome: PreToolUse deny blocks with the hook's reason", () => {
	const decision = interpretHookOutcome(
		"PreToolUse",
		outcome({
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: "not allowed",
				},
			}),
		}),
	);
	assert.equal(decision.blockReason, "not allowed");
	assert.equal(decision.askReason, undefined);
});

test("interpretHookOutcome: PreToolUse ask surfaces a confirmation reason", () => {
	const decision = interpretHookOutcome(
		"PreToolUse",
		outcome({
			stdout: JSON.stringify({
				hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check?" },
			}),
		}),
	);
	assert.equal(decision.askReason, "check?");
	assert.equal(decision.blockReason, undefined);
});

test("interpretHookOutcome: PreToolUse updatedInput is captured", () => {
	const decision = interpretHookOutcome(
		"PreToolUse",
		outcome({
			stdout: JSON.stringify({
				hookSpecificOutput: {
					permissionDecision: "allow",
					updatedInput: { file_path: "/tmp/other.txt" },
				},
			}),
		}),
	);
	assert.deepEqual(decision.updatedInput, { file_path: "/tmp/other.txt" });
});

test("interpretHookOutcome: PreToolUse exit 2 blocks with stderr reason", () => {
	const decision = interpretHookOutcome("PreToolUse", outcome({ exitCode: 2, stderr: "nope\n" }));
	assert.equal(decision.blockReason, "nope");
});

test("interpretHookOutcome: PreToolUse exit 2 prefers a JSON reason over stderr", () => {
	const decision = interpretHookOutcome(
		"PreToolUse",
		outcome({
			exitCode: 2,
			stderr: "stderr reason",
			stdout: JSON.stringify({ decision: "block", reason: "json reason" }),
		}),
	);
	assert.equal(decision.blockReason, "json reason");
});

test("interpretHookOutcome: PostToolUse exit 2 appends stderr to the result and marks it an error", () => {
	const decision = interpretHookOutcome(
		"PostToolUse",
		outcome({ exitCode: 2, stderr: "voice-lint: fix these lines\nline 5\n" }),
	);
	assert.equal(decision.resultAppendix, "voice-lint: fix these lines\nline 5");
	assert.equal(decision.markResultError, true);
});

test("interpretHookOutcome: PostToolUse decision block appends the reason without failing the result", () => {
	const decision = interpretHookOutcome(
		"PostToolUse",
		outcome({ stdout: JSON.stringify({ decision: "block", reason: "regenerate instead" }) }),
	);
	assert.equal(decision.resultAppendix, "regenerate instead");
	assert.equal(decision.markResultError, false);
});

test("interpretHookOutcome: PostToolUseFailure exit 2 feeds stderr back", () => {
	const decision = interpretHookOutcome(
		"PostToolUseFailure",
		outcome({ exitCode: 2, stderr: "alert sent" }),
	);
	assert.equal(decision.resultAppendix, "alert sent");
	assert.equal(decision.markResultError, true);
});

test("interpretHookOutcome: UserPromptSubmit additionalContext becomes context text", () => {
	const decision = interpretHookOutcome(
		"UserPromptSubmit",
		outcome({
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "branch: main",
				},
			}),
		}),
	);
	assert.equal(decision.contextText, "branch: main");
});

test("interpretHookOutcome: UserPromptSubmit plain stdout becomes context text", () => {
	const decision = interpretHookOutcome("UserPromptSubmit", outcome({ stdout: "plain context\n" }));
	assert.equal(decision.contextText, "plain context");
});

test("interpretHookOutcome: SessionStart plain stdout becomes context text", () => {
	const decision = interpretHookOutcome("SessionStart", outcome({ stdout: "loaded env" }));
	assert.equal(decision.contextText, "loaded env");
});

test("interpretHookOutcome: PreToolUse additionalContext becomes a result appendix", () => {
	const decision = interpretHookOutcome(
		"PreToolUse",
		outcome({
			stdout: JSON.stringify({
				hookSpecificOutput: { additionalContext: "staging database" },
			}),
		}),
	);
	assert.equal(decision.resultAppendix, "staging database");
});

test("interpretHookOutcome: UserPromptSubmit exit 2 cannot cancel the prompt in pi", () => {
	const decision = interpretHookOutcome(
		"UserPromptSubmit",
		outcome({ exitCode: 2, stderr: "blocked" }),
	);
	assert.equal(decision.blockReason, undefined);
	assert.equal(decision.notifications.length, 1);
	assert.match(decision.notifications[0] ?? "", /cannot cancel/);
});

test("interpretHookOutcome: Stop exit 2 reports the limitation instead of resuming", () => {
	const decision = interpretHookOutcome("Stop", outcome({ exitCode: 2, stderr: "keep going" }));
	assert.equal(decision.blockReason, undefined);
	assert.equal(decision.notifications.length, 1);
	assert.match(decision.notifications[0] ?? "", /cannot resume/);
});

test("interpretHookOutcome: systemMessage is surfaced", () => {
	const decision = interpretHookOutcome(
		"Stop",
		outcome({ stdout: JSON.stringify({ systemMessage: "watch out" }) }),
	);
	assert.equal(decision.systemMessage, "watch out");
});

test("interpretHookOutcome: continue false blocks PreToolUse, notifies elsewhere", () => {
	const preTool = interpretHookOutcome(
		"PreToolUse",
		outcome({ stdout: JSON.stringify({ continue: false, stopReason: "halt" }) }),
	);
	assert.equal(preTool.blockReason, "halt");

	const stop = interpretHookOutcome(
		"Stop",
		outcome({ stdout: JSON.stringify({ continue: false, stopReason: "halt" }) }),
	);
	assert.equal(stop.blockReason, undefined);
	assert.match(stop.notifications[0] ?? "", /continue:false/);
});

test("interpretHookOutcome: non-2 failure exit code is a non-blocking error", () => {
	const decision = interpretHookOutcome("Stop", outcome({ exitCode: 1, stderr: "boom" }));
	assert.equal(decision.blockReason, undefined);
	assert.match(decision.notifications[0] ?? "", /exit code 1: boom/);
});

test("interpretHookOutcome: stdout shaped like JSON that fails to parse is reported", () => {
	const decision = interpretHookOutcome("Stop", outcome({ stdout: "{broken}" }));
	assert.match(decision.notifications[0] ?? "", /not valid JSON/);
});

test("interpretHookOutcome: stdout starting with { but not ending with } is plain text", () => {
	// Claude treats this as plain text: no parse error, and Stop adds no context.
	const decision = interpretHookOutcome("Stop", outcome({ stdout: "{broken" }));
	assert.deepEqual(decision.notifications, []);
	assert.equal(decision.contextText, undefined);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test("aggregateHookDecisions: deny wins over ask, appendices join", () => {
	const deny = emptyHookDecision();
	deny.blockReason = "denied";
	const ask = emptyHookDecision();
	ask.askReason = "ask me";
	const feedback = emptyHookDecision();
	feedback.resultAppendix = "first";
	feedback.markResultError = true;
	const feedback2 = emptyHookDecision();
	feedback2.resultAppendix = "second";

	const combined = aggregateHookDecisions([ask, deny, feedback, feedback2]);
	assert.equal(combined.blockReason, "denied");
	assert.equal(combined.askReason, undefined);
	assert.equal(combined.resultAppendix, "first\n\nsecond");
	assert.equal(combined.markResultError, true);
});

test("aggregateHookDecisions: context texts join and notifications merge", () => {
	const a = emptyHookDecision();
	a.contextText = "one";
	a.systemMessage = "warn";
	const b = emptyHookDecision();
	b.contextText = "two";
	b.notifications = ["note"];

	const combined = aggregateHookDecisions([a, b]);
	assert.equal(combined.contextText, "one\n\ntwo");
	assert.equal(combined.systemMessage, "warn");
	assert.deepEqual(combined.notifications, ["note"]);
});

test("describeHooks: summarizes loaded hooks, unmapped events, and skips", () => {
	const dir = tempDir();
	try {
		const file = writeSettings(dir, "settings.json", {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
				Notification: [{ hooks: [{ type: "command", command: "n.sh" }] }],
				PreToolUse: [{ hooks: [{ type: "http", url: "http://x" }] }],
			},
		});
		const text = describeHooks(loadHookSettings([file]));
		assert.match(text, /1 loaded from 1 settings file/);
		assert.match(text, /Stop: 1/);
		assert.match(text, /no pi event for: Notification/);
		assert.match(text, /1 handler\(s\) skipped/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
