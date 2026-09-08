# pi-match-rules

A pi extension that syncs Claude Code configuration into pi:

- Loads Markdown rules from global and project-local `.claude/rules` directories and injects the relevant rules into pi's system prompt.
- Injects subdirectory `AGENTS.md` / `CLAUDE.md` files that pi itself never loads, because pi only reads context files from the working directory and its ancestors.
- Runs Claude Code hooks from `~/.claude/settings.json` (and project-local `.claude/settings.json` / `.claude/settings.local.json`) on the matching pi events, so hooks like Orca telemetry or voice-lint work identically in both agents.

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

Rules are Markdown files with YAML-style frontmatter. Supported matching keys:

- `alwaysApply: true`
- `pattern` / `patterns`
- `path` / `paths`
- `glob` / `globs`

Example:

```markdown
---
globs:
  - "**/*.py"
  - "**/pyproject.toml"
---

# Python Rules

Use strict typing and pytest.
```

Rules with `alwaysApply: true` (or no frontmatter at all) are injected every turn. Conditional rules are injected when the user prompt mentions a path matching one of the frontmatter patterns. A rule that has frontmatter but no `alwaysApply` and no patterns is inactive.

Rules are loaded from both:

- Global: `~/.claude/rules/**/*.md` by default
- Local: `<project>/.claude/rules/**/*.md`

If a global and local rule share the same relative path under their rules directory, the local rule wins and the global one is not loaded. Only exact relative-path collisions override; `python/api.md`, `ts/api.md`, and `api.md` are all different rule names.

Symlinked rule files and directories are followed, so a rules directory entry can be a symlink into another tree (for example `.claude/rules/shared` pointing at Claude's rules directory). The rule's identity stays the symlink path under the rules directory. Broken symlinks are skipped, and directory cycles are cut by tracking the real paths already visited.

## Tool

The extension registers `load_claude_rules`, which the agent can call with file paths discovered during the task. It returns the matching rule contents plus `alwaysApply` rules by default. Tool output is truncated to 50KB or 2000 lines.

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
- `/claude-rules <path> [path...]` show the rules matching one or more paths.
- `/claude-hooks` list every synced hook with its event, matcher, source file, and command.
- `/claude-hooks reload` reload hooks from the settings files.

## Configuration

Environment variables, all optional:

- `PI_CLAUDE_RULES_DIR` overrides the global rules directory (default `~/.claude/rules`).
- `PI_CLAUDE_SETTINGS_FILE` overrides the global settings file for hooks (default `~/.claude/settings.json`).
- `PI_CLAUDE_HOOKS_ENABLED=0` disables hook syncing entirely.
- `PI_SUBDIR_AGENTS_MD=0` disables subdirectory `AGENTS.md` injection.

```bash
PI_CLAUDE_RULES_DIR=~/my-rules pi -e ./index.ts
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
