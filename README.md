# pi-match-rules

A pi extension that loads Markdown rules from global and project-local `.claude/rules` directories and injects the relevant rules into pi's system prompt.

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

Rules with `alwaysApply: true` are injected every turn. Conditional rules are injected when the user prompt mentions a path matching one of the frontmatter patterns.

Rules are loaded from both:

- Global: `~/.claude/rules/**/*.md` by default
- Local: `<project>/.claude/rules/**/*.md`

If a global and local rule share the same relative path under their rules directory, the local rule wins and the global one is not loaded. Only exact relative-path collisions override; `python/api.md`, `ts/api.md`, and `api.md` are all different rule names.

## Tool

The extension registers `load_claude_rules`, which the agent can call with file paths discovered during the task. It returns the matching rule contents plus `alwaysApply` rules by default. Tool output is truncated to 50KB or 2000 lines.

## Commands

- `/claude-rules` — show how many rules are loaded.
- `/claude-rules reload` — reload files from disk.
- `/claude-rules <path> [path...]` — show the rules matching one or more paths.

## Configuration

Set `PI_CLAUDE_RULES_DIR` to use a different global rules directory:

```bash
PI_CLAUDE_RULES_DIR=~/my-rules pi -e ./index.ts
```

## Glob support

The matcher supports `*`, `**`, `?`, brace extensions such as `*.{ts,tsx}`, and character classes such as `*[Tt]able*.tsx`.
