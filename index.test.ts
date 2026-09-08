import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSubdirContextAppendix,
	default as claudeRuleMatcher,
	findSubdirContextFiles,
	matchingRules,
	parseMarkdownRule,
	loadRules,
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

test("loadRules: no-frontmatter file is treated as alwaysApply", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-"));
	try {
		fs.writeFileSync(path.join(dir, "plain.md"), "# Plain\n\nNo frontmatter.");
		fs.writeFileSync(path.join(dir, "always.md"), "---\nalwaysApply: true\n---\n\nalways");
		fs.writeFileSync(path.join(dir, "cond.md"), '---\npatterns:\n  - "**/*.py"\n---\n\ncond');
		fs.writeFileSync(path.join(dir, "false.md"), "---\nalwaysApply: false\n---\n\nexplicit false");

		const byName = Object.fromEntries(
			loadRules(dir, "global").map((rule) => [rule.relativePath, rule]),
		);

		assert.equal(byName["plain.md"]?.alwaysApply, true, "no frontmatter => always");
		assert.equal(byName["always.md"]?.alwaysApply, true);
		assert.equal(byName["cond.md"]?.alwaysApply, false);
		assert.equal(
			byName["false.md"]?.alwaysApply,
			false,
			"explicit alwaysApply:false must NOT be always",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
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
