import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMarkdownRule, loadRules, matchingRules } from "./index.ts";

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
