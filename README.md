# pi-match-rules

A pi extension that syncs Claude Code configuration into pi:

- Loads Markdown rules from global and project-local `.claude/rules` and `.agents/rules` directories and injects the relevant rules into pi's system prompt.
- Injects subdirectory `AGENTS.md` / `CLAUDE.md` files that pi itself never loads, because pi only reads context files from the working directory and its ancestors.
- Runs Claude Code hooks from `~/.claude/settings.json` (and project-local `.claude/settings.json` / `.claude/settings.local.json`) on the matching pi events, so hooks like Orca telemetry or voice-lint work identically in both agents.

## Why

This is probably a bloated extension (sorry for that). Let me briefly explain the default behavior of pi:

- pi only reads `~/.pi/agent/AGENTS.md` for user-scope rules
- pi only reads `./AGENTS.md` for repo-scope rules
- pi cannot read subdirectory `AGENTS.md`
- pi cannot apply path-based conditional rule loading (Claude Code, gh copilot, and opencode do)
- pi cannot apply model-decision-based conditional rule loading (antigravity does)

This extension allows pi to:

1. Read `~/.claude/rules/**/*.md`, `~/.agents/rules/**/*.md`, and `~/.pi/agent/rules/**/*.md` for user-scope rules, as well as `.claude/rules/**/*.md` and `.agents/rules/**/*.md` for repo-scope rules. So you have a single source of truth for pi, Claude Code, and other agents for rules. In addition, humans can categorize rules easily.
2. Read `./**/AGENTS.md` when pi reads or writes in a subdirectory of your repo.
3. Apply frontmatter patterns for conditional rule loading. For example, you can write `~/.claude/rules/python/testing.md`:

   ```markdown
   ---
   paths:
     - "**/test_*.py"
   ---

   # Pytest rules

   - Write tests to cover happy path and edge cases
   - Avoid writing tautology tests
   ```

   This rule is injected to pi only when it reads or writes `**/test_*.py`. The supported keywords are any of `pattern`, `patterns`, `path`, `paths`, `glob`, `globs` (for compatibility with Claude Code, gh copilot, and opencode, each of which supports different keywords). Without one of these frontmatter keywords, the rule is always loaded.

4. Load conditional rules lazily. For example, you can write `~/.claude/rules/migrations.md`:

   ```markdown
   ---
   pattern:
     - "migrations/**"
     - "schema.sql"
   description_to_model:
     - "Database migration safety rules, zero-downtime column drops, and idempotent SQL scripts"
   ---

   # Database Migration Rules

   Never drop a column in the same release it is removed from code.
   All migrations must be backward-compatible with the previous application version.
   ```

   This rule will never appear to pi unless it touches files matching the provided pattern. Once touched, only the `description_to_model` content appears. Pi can decide whether its current task is relevant to this rule; if yes, it further loads the rule's body. `pattern` (and friends) and `description_to_model` can be used independently.

This sounds like a skill, but I would rather keep skill as a set of actions to perform a task, while a rule is simply suggestions for the agent's current action or task.

## Install

This repository is a pi package. Install it from this checkout for all pi sessions:

```bash
pi install ./
```

Or from npm once published:

```bash
pi install npm:pi-match-rules
```

Use this checkout directly without installing (good while developing):

```bash
pi -e ./index.ts
```

## Rule format

Rules are Markdown files with YAML-style frontmatter. Supported keys:

- `alwaysApply: true`
- `pattern` / `patterns`
- `path` / `paths`
- `glob` / `globs`
- `description_to_model` (a list of strings, switches the rule to lazy delivery)

Example of an eagerly injected rule:

```markdown
---
globs:
  - "**/*.py"
  - "**/pyproject.toml"
---

# Python Rules

Use strict typing and pytest.
```

Example of a lazily delivered rule:

```markdown
---
globs:
  - "**/*.py"
description_to_model:
  - "Python standards, strict typing and pytest conventions"
---

# Python Rules

Use strict typing and pytest.
```

Rules carry two independent axes. Patterns are the gate and decide when a rule becomes visible at all. `description_to_model` is the delivery mode and switches from eager body injection to lazy loading, where the model sees a one-line description and pulls the full body through the `load_claude_rules` tool when the task needs it.

| Frontmatter | Gate | Delivery |
|------|------|------|
| Patterns only | Path match | Body injected on match |
| Patterns plus `description_to_model` | Path match | Description on match, body loaded through the tool |
| `description_to_model` only | None, always visible | Description in the index, body loaded through the tool |
| Neither key, without `alwaysApply: false` | None | Body injected every turn |
| `alwaysApply: true` | None, override | Body injected every turn, even with a description |
| `alwaysApply: false` without patterns | Disabled | Disabled |
| No frontmatter | None | Body injected every turn |

Topic rules (a description without patterns) are listed in a Claude rules index appended to the system prompt whenever they exist, even when the prompt mentions no file paths. Pattern-gated lazy rules stay invisible until a matching path shows up in the prompt, and then only their descriptions are shown, with a directive to load the rule before editing the matching files. Index descriptions are truncated to about 160 characters. Since the model decides from the description alone whether to load a rule, write descriptions that state when the rule applies.

Rules are loaded from five directories, in increasing precedence:

- Global: `~/.claude/rules/**/*.md` by default
- Global: `~/.agents/rules/**/*.md` by default
- Global: `$PI_CODING_AGENT_DIR/rules/**/*.md` (default `~/.pi/agent/rules`), the pi agent directory, so pi-specific rules live next to your other pi configuration
- Local: `<project>/.claude/rules/**/*.md`
- Local: `<project>/.agents/rules/**/*.md`

If two directories hold a rule with the same relative path, the directory later in that list wins and the earlier rule is not loaded. Only exact relative-path collisions override; `python/api.md`, `ts/api.md`, and `api.md` are all different rule names. A file reachable from two locations, for example when `~/.agents/rules` is a symlink to `~/.claude/rules`, is loaded once.

Symlinked rule files and directories are followed, so a rules directory entry can be a symlink into another tree (for example `.claude/rules/shared` pointing at Claude's rules directory). The rule's identity stays the symlink path under the rules directory. Broken symlinks are skipped, and directory cycles are cut by tracking the real paths already visited.

## Tool

The extension registers `load_claude_rules`, which the agent can call with file paths discovered during the task, or with rule names taken from the Claude rules index.

- `paths` selects rules by frontmatter path patterns and returns full bodies. A pattern-gated lazy rule matched this way returns its body too, since the call is an explicit request.
- `rules` selects rules by name (relative path like `shared/security.md`, basename like `security.md`, or stem like `security`) and bypasses path gating, so topic and deferred rules load on demand.
- Always-injected rules are included by default and can be excluded with `includeAlways: false`.

Tool output is truncated to 50KB or 2000 lines.

## Subdirectory AGENTS.md

pi loads `AGENTS.md` (or `CLAUDE.md`) only from the working directory and its ancestors, so context files in subdirectories never reach the session. This extension fills that gap. When a tool touches a path under a subdirectory that has its own context file, the file's content is appended to that tool's result, once per file per session.

- Candidates per directory, in priority order, match pi's own list (`AGENTS.override.md`, then `AGENTS.md` / `AGENTS.MD`, then `CLAUDE.md` / `CLAUDE.MD`), and only the first present file in a directory is used.
- Applies to `read`, `write`, `edit`, `ls`, `find`, and `grep` calls that carry a `path` input under the session cwd. `bash` commands are not inspected, since their working directories cannot be resolved reliably.
- Paths outside the session cwd are ignored. The cwd's own context file is skipped because pi already loaded it at startup.
- A chain of nested files is injected together, ordered from the directory closest to the cwd outward.
- Appended output is truncated to 50KB or 2000 lines. `/claude-rules reload` clears the injected set, so edited files can inject again later in the session.

## Commands

- `/claude-rules` show how many rules are loaded.
- `/claude-rules reload` reload rule files from disk.
- `/claude-rules <path-or-name> [...]` show the rules matching paths, or load named rules directly to preview any rule, lazy ones included.
- `/claude-hooks` list every synced hook with its event, matcher, source file, and command.
- `/claude-hooks reload` reload hooks from the settings files.

## Configuration

Environment variables, all optional:

- `PI_CLAUDE_RULES_DIR` overrides the global Claude rules directory (default `~/.claude/rules`).
- `PI_AGENTS_RULES_DIR` overrides the global agents rules directory (default `~/.agents/rules`).
- `PI_CODING_AGENT_DIR` overrides the pi agent directory, whose `rules/` subdirectory is read as another global rules source (default `~/.pi/agent`). This is the same variable pi itself uses for its configuration directory.
- `PI_CLAUDE_SETTINGS_FILE` overrides the global settings file for hooks (default `~/.claude/settings.json`).
- `PI_CLAUDE_HOOKS_ENABLED=0` disables hook syncing entirely.
- `PI_SUBDIR_AGENTS_MD=0` disables subdirectory `AGENTS.md` injection.

```bash
PI_CLAUDE_RULES_DIR=~/my-rules pi -e ./index.ts
PI_AGENTS_RULES_DIR=~/my-agents-rules pi -e ./index.ts
PI_CODING_AGENT_DIR=~/.custom-pi/agent pi -e ./index.ts
PI_CLAUDE_SETTINGS_FILE=~/my-settings.json pi -e ./index.ts
PI_CLAUDE_HOOKS_ENABLED=0 pi -e ./index.ts
PI_SUBDIR_AGENTS_MD=0 pi -e ./index.ts
```

## Glob support

The matcher supports `*`, `**`, `?`, brace extensions such as `*.{ts,tsx}`, and character classes such as `*[Tt]able*.tsx`.

## Hooks

The extension also syncs Claude Code hooks into pi. It reads the `hooks` key from these settings files, in order:

- Global: `~/.claude/settings.json`
- Project: `<project>/.claude/settings.json`
- Local: `<project>/.claude/settings.local.json`

Hooks from all files run (identical handlers are deduplicated), matching Claude's merge behavior. Only `type: "command"` hooks run; `http`, `mcp_tool`, `prompt`, and `agent` handlers are skipped, as are handlers using the `if` permission-rule filter. A `disableAllHooks: true` setting in any loaded file disables them.

### Event mapping

| Claude event | pi event | Notes |
|------|------|------|
| `SessionStart` | `session_start` | `source` mapped from pi's reason (`new` to `clear`, `reload` to `startup`, others verbatim); matcher filters the source |
| `UserPromptSubmit` | `before_agent_start` | sends `prompt` |
| `PreToolUse` | `tool_call` | can block or patch the tool input |
| `PostToolUse` | `tool_result` | only when the tool succeeded |
| `PostToolUseFailure` | `tool_result` | only when the tool errored, with `error` text |
| `Stop` | `agent_end` | sends `stop_hook_active: false` and `last_assistant_message` |
| `TeammateIdle` | `agent_settled` | |
| `PostCompact` | `session_compact` | `trigger` is `manual` or `auto`; sends `compact_summary` |
| `SessionEnd` | `session_shutdown` | reason mapped to `clear`, `resume`, or `other` |

Other Claude events (Notification, SubagentStart, PermissionRequest, FileChanged, and the rest) have no pi equivalent and are skipped; `/claude-hooks` lists them.

### Payload and tool translation

Each hook receives Claude's JSON input on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus event fields). `transcript_path` is pi's session file, and `session_id` is pi's session id. `CLAUDE_PROJECT_DIR` is set to the session cwd.

pi tool names and inputs are translated to Claude's shapes so existing hooks work unchanged:

- `write` becomes `Write` with `file_path`; `edit` becomes `Edit`/`MultiEdit` with `old_string`/`new_string`; `read` becomes `Read`; `bash` becomes `Bash`. Matchers are tested against both the pi and Claude tool names, so `"matcher": "Write|Edit|MultiEdit"` matches pi's `edit` tool.
- `tool_response` approximates Claude's shapes (`{stdout, ...}` for bash, `{filePath, success}` for file tools).

### Output handling

Hook stdout and exit codes follow Claude's protocol:

- Exit 2 on `PreToolUse` blocks the tool call; `permissionDecision: "deny"` blocks and `"ask"` prompts the user before running the tool; `updatedInput` rewrites the arguments.
- Exit 2 or `decision: "block"` on `PostToolUse`/`PostToolUseFailure` appends the reason or stderr to the tool result so the model can react (this is how voice-lint exit-2 feedback works).
- `additionalContext` (and plain stdout for `SessionStart`/`UserPromptSubmit`) is injected into the conversation; on tool events it is appended next to the result.
- `systemMessage` is shown as a warning.

Limitations where pi has no equivalent: a `UserPromptSubmit` block cannot erase an already submitted prompt, and a `Stop` block cannot resume a finished run; both surface a warning instead. Timed-out hooks discard their output, matching Claude.
