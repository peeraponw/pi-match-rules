# AGENTS.md (pi-match-rules)

## Project
- **Language**: TypeScript pi extension
- **Entry point**: `index.ts`
- **Modules**: `index.ts` (rules loading, system prompt injection, subdirectory AGENTS.md injection on tool results, hook event wiring), `hooks.ts` (Claude hook protocol bridge)

## Commands
```bash
pi -e ./index.ts   # run pi with this extension loaded
npm run check      # tsc --noEmit
npm test           # node --test index.test.ts hooks.test.ts
```

## Notes
- The extension is dependency-free at runtime besides pi's extension APIs and Node built-ins.
- Rules are loaded from global `~/.claude/rules/**/*.md` and local `.claude/rules/**/*.md`.
- `PI_CLAUDE_RULES_DIR` overrides the global rules directory.
- Local rules override global rules with the same relative path under the rules directory.
- Hooks are synced from `~/.claude/settings.json` plus `.claude/settings.json` and `.claude/settings.local.json`; `hooks.ts` holds the Claude hook bridge and `index.ts` wires it to pi events.
- pi loads AGENTS.md only from the session cwd and its ancestors, so `index.ts` also appends subdirectory `AGENTS.md`/`CLAUDE.md` files to tool results when a tool touches paths below them, once per file per session.
- `PI_CLAUDE_SETTINGS_FILE` overrides the global settings file; `PI_CLAUDE_HOOKS_ENABLED=0` disables hook syncing; `PI_SUBDIR_AGENTS_MD=0` disables subdirectory AGENTS.md injection.
