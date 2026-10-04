import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSubdirContextAppendix,
	default as claudeRuleMatcher,
	deferredMatches,
	findSubdirContextFiles,
	matchingRules,
	mergeRules,
	parseMarkdownRule,
	loadRules,
	ruleMatchesName,
	subdirAgentsEnabled,
} from "./index.ts";

test("parseMarkdownRule: no frontmatter block sets hasFrontmatter false", () => {
	const content = "# Just a title\n\nSome body text.";
	const result = parseMarkdownRule(content);
	assert.equal(result.hasFrontmatter, false);
	assert.deepEqual(result.frontmatter, {});
	assert.equal(result.body, content);
});

test("parseMarkdownRule: frontmatter block sets hasFrontmatter true", () => {
	const result = parseMarkdownRule("---\nalwaysApply: true\n---\n\nbody");
	assert.equal(result.hasFrontmatter, true);
	assert.equal(result.frontmatter.alwaysApply, true);
});

test("loadRules: classification table across frontmatter states", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	try {
		const cases: Array<[name: string, content: string, kind: string]> = [
			["patterns-only.md", '---\npatterns:\n  - "**/*.py"\n---\n\nbody', "conditional"],
			[
				"patterns-desc.md",
				'---\npatterns:\n  - "**/*.py"\ndescription_to_model:\n  - "Python standards"\n---\n\nbody',
				"deferred",
			],
			["desc-only.md", '---\ndescription_to_model:\n  - "Topic guidance"\n---\n\nbody', "topic"],
			["unrelated-key.md", "---\ntitle: hello\n---\n\nbody", "always"],
			[
				"always-true-desc.md",
				'---\nalwaysApply: true\ndescription_to_model:\n  - "override"\n---\n\nbody',
				"always",
			],
			["always-false.md", "---\nalwaysApply: false\n---\n\nbody", "disabled"],
			[
				"always-false-patterns.md",
				'---\nalwaysApply: false\npatterns:\n  - "**/*.py"\n---\n\nbody',
				"conditional",
			],
			["plain.md", "# no frontmatter", "always"],
		];
		for (const [name, content] of cases) fs.writeFileSync(path.join(dir, name), content);

		const all = loadRules(dir, "global");
		const byName = Object.fromEntries(all.map((rule) => [rule.relativePath, rule]));
		for (const [name, , kind] of cases) {
			assert.equal(byName[name]?.kind, kind, `${name} should classify as ${kind}`);
		}
		assert.deepEqual(byName["patterns-desc.md"]?.descriptionToModel, ["Python standards"]);
		assert.deepEqual(byName["desc-only.md"]?.descriptionToModel, ["Topic guidance"]);
		assert.deepEqual(byName["plain.md"]?.descriptionToModel, []);

		// Frontmatter with neither gate nor description is no longer inert.
		const noCandidates = matchingRules(all, []).map((rule) => rule.relativePath).sort();
		assert.deepEqual(noCandidates, ["always-true-desc.md", "plain.md", "unrelated-key.md"]);

		// Deferred rules never auto-inject their bodies, even on pattern match.
		const pyMatch = matchingRules(all, ["src/app/main.py"])
			.map((rule) => rule.relativePath)
			.sort();
		assert.deepEqual(pyMatch, [
			"always-false-patterns.md",
			"always-true-desc.md",
			"patterns-only.md",
			"plain.md",
			"unrelated-key.md",
		]);
		assert.deepEqual(
			deferredMatches(all, ["src/app/main.py"]).map((rule) => rule.relativePath),
			["patterns-desc.md"],
		);
		assert.deepEqual(deferredMatches(all, ["src/app/main.rs"]), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("parseMarkdownRule: description_to_model accepts list, inline array, and scalar forms", () => {
	const list = parseMarkdownRule('---\ndescription_to_model:\n  - "a"\n  - "b"\n---\n\nbody');
	assert.deepEqual(list.frontmatter.description_to_model, ["a", "b"]);
	const inline = parseMarkdownRule('---\ndescription_to_model: ["a", "b"]\n---\n\nbody');
	assert.deepEqual(inline.frontmatter.description_to_model, ["a", "b"]);
	const scalar = parseMarkdownRule("---\ndescription_to_model: one line\n---\n\nbody");
	assert.equal(scalar.frontmatter.description_to_model, "one line");
});

function makeRule(relativePath: string): Parameters<typeof ruleMatchesName>[0] {
	return {
		absolutePath: `/rules/${relativePath}`,
		relativePath,
		source: "global",
		sourceDir: "/rules",
		frontmatter: {},
		patterns: [],
		descriptionToModel: [],
		kind: "topic",
		body: "",
	};
}

test("ruleMatchesName: matches relative path, basename, and stem", () => {
	const rule = makeRule("shared/security.md");
	assert.equal(ruleMatchesName(rule, "shared/security.md"), true, "exact relative path");
	assert.equal(ruleMatchesName(rule, "security.md"), true, "basename");
	assert.equal(ruleMatchesName(rule, "security"), true, "stem");
	assert.equal(ruleMatchesName(rule, "shared/security"), true, "directory plus stem");
	assert.equal(ruleMatchesName(rule, "api/security.md"), true, "basename matches across directories");
	assert.equal(ruleMatchesName(rule, "shared/other.md"), false);
	assert.equal(ruleMatchesName(rule, "other"), false);
	assert.equal(ruleMatchesName(rule, "security.ts"), false, "foreign extension is not the rule");
	assert.equal(ruleMatchesName(rule, " "), false, "blank name never matches");
});

test("matchingRules: no-frontmatter and always rules load even with no path candidates", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	try {
		fs.writeFileSync(path.join(dir, "plain.md"), "# Plain");
		fs.writeFileSync(path.join(dir, "always.md"), "---\nalwaysApply: true\n---\n\nalways");
		fs.writeFileSync(path.join(dir, "cond.md"), '---\npatterns:\n  - "**/*.py"\n---\n\ncond');

		const rules = loadRules(dir, "global");
		const matched = matchingRules(rules, [])
			.map((rule) => rule.relativePath)
			.sort();
		assert.deepEqual(matched, ["always.md", "plain.md"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("matchingRules: conditional rule still loads only on matching path", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	try {
		fs.writeFileSync(path.join(dir, "plain.md"), "# Plain");
		fs.writeFileSync(path.join(dir, "cond.md"), '---\npatterns:\n  - "**/*.py"\n---\n\ncond');

		const rules = loadRules(dir, "global");
		const matched = matchingRules(rules, ["src/app/main.py"])
			.map((rule) => rule.relativePath)
			.sort();
		assert.deepEqual(matched, ["cond.md", "plain.md"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("mergeRules: later locations override the same relative path across claude and agents dirs", () => {
	const claudeGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-cg-"));
	const agentsGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-ag-"));
	const claudeLocal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-cl-"));
	const agentsLocal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-al-"));
	try {
		fs.writeFileSync(path.join(claudeGlobal, "shared.md"), "---\nalwaysApply: true\n---\n\n\nclaude global");
		fs.writeFileSync(path.join(claudeGlobal, "claude-only.md"), "# claude only");
		fs.writeFileSync(path.join(agentsGlobal, "agents-only.md"), "# agents only");
		fs.writeFileSync(path.join(claudeLocal, "shared.md"), "---\nalwaysApply: true\n---\n\n\nclaude local");
		fs.writeFileSync(path.join(agentsLocal, "shared.md"), "---\nalwaysApply: true\n---\n\n\nagents local");

		const loaded = mergeRules([
			{ dir: claudeGlobal, source: "global" },
			{ dir: agentsGlobal, source: "global" },
			{ dir: claudeLocal, source: "local" },
			{ dir: agentsLocal, source: "local" },
		]);

		const byName = Object.fromEntries(loaded.rules.map((rule) => [rule.relativePath, rule]));
		assert.equal(loaded.rules.length, 3, "four dirs, two rules share one relative path");
		assert.equal(byName["shared.md"]?.body, "agents local", "highest-precedence location wins");
		assert.equal(byName["shared.md"]?.sourceDir, agentsLocal);
		assert.ok(byName["claude-only.md"], "claude global rule loads");
		assert.ok(byName["agents-only.md"], "agents global rule loads");
		assert.deepEqual(loaded.overridden, ["shared.md"], "chained overrides are deduped");
	} finally {
		for (const dir of [claudeGlobal, agentsGlobal, claudeLocal, agentsLocal]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("mergeRules: the same real file reachable from two locations loads once", () => {
	const claudeGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-cg-"));
	const agentsGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-ag-"));
	try {
		fs.writeFileSync(path.join(claudeGlobal, "voice.md"), "# voice");
		fs.symlinkSync(path.join(claudeGlobal, "voice.md"), path.join(agentsGlobal, "mirror.md"));

		const loaded = mergeRules([
			{ dir: claudeGlobal, source: "global" },
			{ dir: agentsGlobal, source: "global" },
		]);

		assert.equal(loaded.rules.length, 1, "mirrored file is not injected twice");
		assert.equal(loaded.rules[0]?.relativePath, "voice.md", "earlier location is kept");
		assert.deepEqual(loaded.overridden, [], "a mirrored file is not an override");
	} finally {
		fs.rmSync(claudeGlobal, { recursive: true, force: true });
		fs.rmSync(agentsGlobal, { recursive: true, force: true });
	}
});

test("mergeRules: a whole rules directory symlinked as another location adds no duplicates", () => {
	const claudeGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-cg-"));
	const agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-ah-"));
	try {
		fs.mkdirSync(path.join(claudeGlobal, "nested"));
		fs.writeFileSync(path.join(claudeGlobal, "voice.md"), "# voice");
		fs.writeFileSync(path.join(claudeGlobal, "nested", "deep.md"), "# deep");
		// Simulates ~/.agents/rules -> ~/.claude/rules.
		fs.symlinkSync(claudeGlobal, path.join(agentsHome, "rules"));

		const loaded = mergeRules([
			{ dir: claudeGlobal, source: "global" },
			{ dir: path.join(agentsHome, "rules"), source: "global" },
		]);

		assert.deepEqual(
			loaded.rules.map((rule) => rule.relativePath),
		["nested/deep.md", "voice.md"],
		"each rule appears exactly once",
		);
		assert.deepEqual(loaded.overridden, []);
	} finally {
		fs.rmSync(claudeGlobal, { recursive: true, force: true });
		fs.rmSync(agentsHome, { recursive: true, force: true });
	}
});

test("loadRules: follows symlinked rule files and directories", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	const target = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-target-"));
	try {
		fs.mkdirSync(path.join(target, "nested"));
		fs.writeFileSync(path.join(target, "linked.md"), "---\nalwaysApply: true\n---\n\nlinked body");
		fs.writeFileSync(path.join(target, "nested", "deep.md"), "# Deep");
		fs.writeFileSync(path.join(dir, "plain.md"), "# Plain");
		fs.symlinkSync(path.join(target, "linked.md"), path.join(dir, "linked.md"));
		fs.symlinkSync(target, path.join(dir, "shared"));

		const byName = Object.fromEntries(
			loadRules(dir, "global").map((rule) => [rule.relativePath, rule]),
		);

		assert.ok(byName["linked.md"], "symlinked .md file is loaded");
		assert.equal(byName["linked.md"]?.body, "linked body", "reads the target content");
		assert.equal(byName["linked.md"]?.absolutePath, path.join(dir, "linked.md"));
		assert.ok(byName["shared/linked.md"], "symlinked directory is traversed");
		assert.ok(byName["shared/nested/deep.md"], "nested dirs under symlink are traversed");
		assert.ok(byName["plain.md"], "regular files still load");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(target, { recursive: true, force: true });
	}
});

test("loadRules: broken symlink and directory cycle do not hang or throw", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	try {
		fs.writeFileSync(path.join(dir, "plain.md"), "# Plain");
		fs.symlinkSync(path.join(dir, "missing.md"), path.join(dir, "broken.md"));
		fs.symlinkSync(dir, path.join(dir, "self"));

		const names = loadRules(dir, "global").map((rule) => rule.relativePath);

		assert.deepEqual(names, ["plain.md"], "broken link and cycle are skipped, plain loads");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeContextTree(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
	fs.writeFileSync(path.join(root, "AGENTS.md"), "# root context\n");
	fs.mkdirSync(path.join(root, "sub"), { recursive: true });
	fs.writeFileSync(path.join(root, "sub", "AGENTS.md"), "# sub context\n");
	fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
	fs.writeFileSync(path.join(root, "sub", "deep", "CLAUDE.md"), "# deep context\n");
	return root;
}

test("findSubdirContextFiles: walks down from cwd, skipping cwd's own file", () => {
	const root = makeContextTree();
	try {
		const files = findSubdirContextFiles(root, path.join("sub", "deep", "file.ts"));
		assert.deepEqual(files, [
			path.join(root, "sub", "AGENTS.md"),
			path.join(root, "sub", "deep", "CLAUDE.md"),
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("findSubdirContextFiles: target at cwd root yields nothing", () => {
	const root = makeContextTree();
	try {
		assert.deepEqual(findSubdirContextFiles(root, "file.ts"), []);
		assert.deepEqual(findSubdirContextFiles(root, "."), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("findSubdirContextFiles: paths outside cwd yield nothing", () => {
	const root = makeContextTree();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-out-"));
	try {
		assert.deepEqual(findSubdirContextFiles(root, path.join(outside, "file.ts")), []);
		assert.deepEqual(findSubdirContextFiles(root, path.join("..", "sibling.ts")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("findSubdirContextFiles: AGENTS.override.md wins over the other candidates", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
	try {
		fs.mkdirSync(path.join(root, "pkg"));
		for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]) {
			fs.writeFileSync(path.join(root, "pkg", name), `# ${name}\n`);
		}
		const files = findSubdirContextFiles(root, path.join("pkg", "file.ts"));
		assert.deepEqual(files, [path.join(root, "pkg", "AGENTS.override.md")]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("findSubdirContextFiles: directory target includes the directory itself", () => {
	const root = makeContextTree();
	try {
		const files = findSubdirContextFiles(root, "sub");
		assert.deepEqual(files, [path.join(root, "sub", "AGENTS.md")]);
		// Nonexistent targets are treated as files, so only their parent chain counts.
		const missing = findSubdirContextFiles(root, path.join("sub", "deep", "new.ts"));
		assert.deepEqual(missing, [
			path.join(root, "sub", "AGENTS.md"),
			path.join(root, "sub", "deep", "CLAUDE.md"),
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("buildSubdirContextAppendix: formats content and dedupes per session", () => {
	const root = makeContextTree();
	try {
		const injected = new Set<string>();
		const input = { path: path.join("sub", "deep", "file.ts") };

		const first = buildSubdirContextAppendix("read", input, root, injected);
		assert.ok(first.includes(`### ${path.join(root, "sub", "AGENTS.md")}`), "lists sub AGENTS.md");
		assert.ok(first.includes("# sub context"), "includes sub body");
		assert.ok(first.includes("# deep context"), "includes deep body");
		assert.ok(!first.includes("# root context"), "must not re-include cwd context");

		assert.equal(buildSubdirContextAppendix("read", input, root, injected), "", "second touch is deduped");
		assert.equal(
			buildSubdirContextAppendix("edit", { path: path.join("sub", "other.ts") }, root, injected),
			"",
			"sub already injected",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("buildSubdirContextAppendix: gates on tool name and path input", () => {
	const root = makeContextTree();
	try {
		const injected = new Set<string>();
		assert.equal(
			buildSubdirContextAppendix("bash", { command: "ls sub" }, root, injected),
			"",
			"bash carries no resolvable path",
		);
		assert.equal(buildSubdirContextAppendix("read", {}, root, injected), "", "no path field");
		assert.equal(buildSubdirContextAppendix("read", null, root, injected), "", "null input");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("subdirAgentsEnabled: PI_SUBDIR_AGENTS_MD=0 disables, default enables", () => {
	const previous = process.env.PI_SUBDIR_AGENTS_MD;
	try {
		delete process.env.PI_SUBDIR_AGENTS_MD;
		assert.equal(subdirAgentsEnabled(), true);
		for (const off of ["0", "false", "no", "off"]) {
			process.env.PI_SUBDIR_AGENTS_MD = off;
			assert.equal(subdirAgentsEnabled(), false, `${off} disables`);
		}
		process.env.PI_SUBDIR_AGENTS_MD = "1";
		assert.equal(subdirAgentsEnabled(), true);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBDIR_AGENTS_MD;
		else process.env.PI_SUBDIR_AGENTS_MD = previous;
	}
});

test("extension injects agents-dir rules alongside claude-dir rules", async () => {
	const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-claude-"));
	const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-agents-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-project-"));
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	const fake = {
		on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
			handlers[name] = handler as (event: unknown, ctx: unknown) => Promise<unknown>;
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
		sendMessage: () => undefined,
	};
	const previousClaudeDir = process.env.PI_CLAUDE_RULES_DIR;
	const previousAgentsDir = process.env.PI_AGENTS_RULES_DIR;
	const previousHooksEnabled = process.env.PI_CLAUDE_HOOKS_ENABLED;
	try {
		process.env.PI_CLAUDE_RULES_DIR = claudeDir;
		process.env.PI_AGENTS_RULES_DIR = agentsDir;
		// Keep the machine's real settings.json hooks out of the test run.
		process.env.PI_CLAUDE_HOOKS_ENABLED = "0";
		fs.writeFileSync(
			path.join(claudeDir, "claude.md"),
			"---\nalwaysApply: true\n---\n\n\nclaude rule body",
		);
		fs.writeFileSync(
			path.join(agentsDir, "agents.md"),
			'---\npatterns:\n  - "**/*.rs"\n---\n\n\nagents rule body',
		);

		claudeRuleMatcher(fake as unknown as Parameters<typeof claudeRuleMatcher>[0]);
		const ctx = {
			cwd: project,
			ui: { notify: () => undefined, setStatus: () => undefined },
			sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		};
		await handlers["session_start"]?.({ reason: "new" }, ctx);
		const result = (await handlers["before_agent_start"]?.(
			{ prompt: "please edit src/main.rs", systemPrompt: "base" },
			ctx,
		)) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt, "returns a patched system prompt");
		assert.match(result.systemPrompt ?? "", /claude rule body/);
		assert.match(result.systemPrompt ?? "", /agents rule body/, "agents dir rule is injected");
		assert.ok(
			(result.systemPrompt ?? "").includes(`### ${path.join(agentsDir, "agents.md")}`),
			"agents rule is attributed to its own directory",
		);
	} finally {
		if (previousClaudeDir === undefined) delete process.env.PI_CLAUDE_RULES_DIR;
		else process.env.PI_CLAUDE_RULES_DIR = previousClaudeDir;
		if (previousAgentsDir === undefined) delete process.env.PI_AGENTS_RULES_DIR;
		else process.env.PI_AGENTS_RULES_DIR = previousAgentsDir;
		if (previousHooksEnabled === undefined) delete process.env.PI_CLAUDE_HOOKS_ENABLED;
		else process.env.PI_CLAUDE_HOOKS_ENABLED = previousHooksEnabled;
		fs.rmSync(claudeDir, { recursive: true, force: true });
		fs.rmSync(agentsDir, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("extension appends subdirectory AGENTS.md to tool results once per file", async () => {
	const root = makeContextTree();
	try {
		let onToolResult:
			| ((event: unknown, ctx: unknown) => Promise<unknown>)
			| undefined;
		const fake = {
			on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
				if (name === "tool_result") {
					// Test double implements the four ExtensionAPI members the extension calls.
					onToolResult = handler as (event: unknown, ctx: unknown) => Promise<unknown>;
				}
			},
			registerTool: () => undefined,
			registerCommand: () => undefined,
			sendMessage: () => undefined,
		};
		// Test double implements the four ExtensionAPI members the extension calls.
		claudeRuleMatcher(fake as unknown as Parameters<typeof claudeRuleMatcher>[0]);
		assert.ok(onToolResult !== undefined, "extension subscribes to tool_result");

		const ctx = {
			cwd: root,
			ui: { notify: () => undefined, setStatus: () => undefined },
			sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		};
		const event = {
			type: "tool_result",
			toolName: "read",
			toolCallId: "t1",
			input: { path: path.join(root, "sub", "deep", "file.ts") },
			content: [{ type: "text", text: "file body" }],
			isError: false,
			details: undefined,
		};

		const first = (await onToolResult(event, ctx)) as
			| { content: Array<{ type: string; text?: string }> }
			| undefined;
		assert.ok(first, "returns a content patch");
		assert.equal(first.content.length, 2, "original content plus one appendix block");
		assert.match(first.content[1]?.text ?? "", /\[Subdirectory AGENTS\.md\]/);
		assert.match(first.content[1]?.text ?? "", /# sub context/);
		assert.match(first.content[1]?.text ?? "", /# deep context/);

		const second = await onToolResult({ ...event, toolCallId: "t2" }, ctx);
		assert.equal(second, undefined, "already injected this session");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("extension: model-decision rules defer bodies and load on demand", async () => {
	const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-claude-"));
	const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-agents-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-project-"));
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	type LoadTool = {
		name: string;
		execute: (toolCallId: string, params: unknown) => Promise<unknown>;
	};
	const tools: LoadTool[] = [];
	const fake = {
		on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
			handlers[name] = handler as (event: unknown, ctx: unknown) => Promise<unknown>;
		},
		registerTool(tool: LoadTool) {
			tools.push(tool);
		},
		registerCommand: () => undefined,
		sendMessage: () => undefined,
	};
	const previousClaudeDir = process.env.PI_CLAUDE_RULES_DIR;
	const previousAgentsDir = process.env.PI_AGENTS_RULES_DIR;
	const previousHooksEnabled = process.env.PI_CLAUDE_HOOKS_ENABLED;
	try {
		process.env.PI_CLAUDE_RULES_DIR = claudeDir;
		process.env.PI_AGENTS_RULES_DIR = agentsDir;
		process.env.PI_CLAUDE_HOOKS_ENABLED = "0";
		fs.writeFileSync(
			path.join(claudeDir, "topic.md"),
			'---\ndescription_to_model:\n  - "Guards commit message formatting"\n---\n\nTOPIC BODY',
		);
		fs.writeFileSync(
			path.join(claudeDir, "py-deferred.md"),
			'---\npatterns:\n  - "**/*.py"\ndescription_to_model:\n  - "Python coding standards"\n---\n\nDEFERRED BODY',
		);
		fs.writeFileSync(
			path.join(claudeDir, "rs-eager.md"),
			'---\npatterns:\n  - "**/*.rs"\n---\n\nEAGER BODY',
		);

		claudeRuleMatcher(fake as unknown as Parameters<typeof claudeRuleMatcher>[0]);
		const loadTool = tools.find((tool) => tool.name === "load_claude_rules");
		assert.ok(loadTool, "extension registers load_claude_rules");
		const ctx = {
			cwd: project,
			ui: { notify: () => undefined, setStatus: () => undefined },
			sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		};
		await handlers["session_start"]?.({ reason: "new" }, ctx);

		const runPrompt = async (prompt: string): Promise<string> => {
			const result = (await handlers["before_agent_start"]?.(
				{ prompt, systemPrompt: "base" },
			ctx,
			)) as { systemPrompt?: string } | undefined;
			return result?.systemPrompt ?? "";
		};
		const runTool = async (params: unknown): Promise<string> => {
			const result = (await loadTool?.execute("call", params)) as {
				content?: Array<{ type: string; text?: string }>;
			} | undefined;
			return result?.content?.[0]?.text ?? "";
		};

		// A fileless prompt still sees the index, with descriptions only.
		const fileless = await runPrompt("hello there");
		assert.ok(fileless !== "", "fileless prompt patches the system prompt");
		assert.match(fileless, /Claude Rules Index/);
		assert.match(fileless, /Guards commit message formatting/, "topic rule is listed");
		assert.match(fileless, /Python coding standards/, "pattern rule lists its description");
		assert.ok(!fileless.includes("TOPIC BODY"), "topic body stays out");
		assert.ok(!fileless.includes("DEFERRED BODY"), "deferred body stays out");
		assert.ok(!fileless.includes("EAGER BODY"), "unmatched eager rule stays out");

		// A path match surfaces the deferred description, never the body.
		const pyPrompt = await runPrompt("please edit src/main.py now");
		assert.match(pyPrompt, /Deferred Claude Rules/);
		assert.match(pyPrompt, /Python coding standards/);
		assert.ok(!pyPrompt.includes("DEFERRED BODY"), "deferred body is not auto-injected");
		assert.ok(!pyPrompt.includes("EAGER BODY"), "unmatched pattern rule stays out");

		// Pattern-only rules keep eager body injection.
		const rsPrompt = await runPrompt("refactor src/lib.rs please");
		assert.match(rsPrompt, /EAGER BODY/);
		assert.ok(!rsPrompt.includes("DEFERRED BODY"));

		// The tool returns full bodies, by name and by path.
		assert.match(await runTool({ rules: ["py-deferred"] }), /DEFERRED BODY/);
		assert.match(await runTool({ rules: ["topic"] }), /TOPIC BODY/);
		const byPath = await runTool({ paths: ["src/main.py"] });
		assert.match(byPath, /DEFERRED BODY/, "explicit path request returns the full body");
		assert.ok(!byPath.includes("TOPIC BODY"), "paths do not pull topic bodies in");
		assert.match(await runTool({ rules: ["nope"] }), /No Claude rules matched/);
	} finally {
		if (previousClaudeDir === undefined) delete process.env.PI_CLAUDE_RULES_DIR;
		else process.env.PI_CLAUDE_RULES_DIR = previousClaudeDir;
		if (previousAgentsDir === undefined) delete process.env.PI_AGENTS_RULES_DIR;
		else process.env.PI_AGENTS_RULES_DIR = previousAgentsDir;
		if (previousHooksEnabled === undefined) delete process.env.PI_CLAUDE_HOOKS_ENABLED;
		else process.env.PI_CLAUDE_HOOKS_ENABLED = previousHooksEnabled;
		fs.rmSync(claudeDir, { recursive: true, force: true });
		fs.rmSync(agentsDir, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});
