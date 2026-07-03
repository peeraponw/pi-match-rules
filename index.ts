import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function parseMarkdownRule(content: string): { frontmatter: Frontmatter; body: string } {
	if (!content.startsWith("---\n")) {
		return { frontmatter: {}, body: content.trim() };
	}

	const end = content.indexOf("\n---", 4);
	if (end === -1) {
		return { frontmatter: {}, body: content.trim() };
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

	return { frontmatter, body };
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

function loadRules(rulesDir: string, source: RuleSource): Rule[] {
	return findMarkdownFiles(rulesDir).map((relativePath) => {
		const absolutePath = path.join(rulesDir, relativePath);
		const content = fs.readFileSync(absolutePath, "utf8");
		const { frontmatter, body } = parseMarkdownRule(content);
		const alwaysApply = frontmatter.alwaysApply === true;

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

function matchingRules(rules: Rule[], candidates: string[]): Rule[] {
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

export default function claudeRuleMatcher(pi: ExtensionAPI) {
	let loadedRules: LoadedRules = {
		rules: [],
		globalDir: getGlobalRulesDir(),
		localDir: getLocalRulesDir(process.cwd()),
		overridden: [],
	};
	let rules: Rule[] = [];

	function reloadRules(cwd: string): string {
		loadedRules = loadMergedRules(cwd);
		rules = loadedRules.rules;
		return describeRules(loadedRules);
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const summary = reloadRules(ctx.cwd);
			ctx.ui.setStatus("claude-rules", `${rules.length} rules`);
			if (rules.length > 0) ctx.ui.notify(summary, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to load Claude rules: ${(error as Error).message}`, "error");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (rules.length === 0) return;

		const candidates = extractPathCandidates(event.prompt);
		const activeRules = matchingRules(rules, candidates);
		if (activeRules.length === 0) return;

		const reason = candidates.length > 0
			? `matched prompt paths: ${candidates.join(", ")}`
			: "alwaysApply rules";

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n" +
				formatRulesForPrompt(activeRules, reason) +
				formatRuleIndex(rules),
		};
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
