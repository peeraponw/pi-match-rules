# AGENTS.md — pi-match-rules

## Project
- **Language**: TypeScript pi extension
- **Entry point**: `index.ts`

## Commands
```bash
pi -e ./index.ts
```

## Notes
- The extension is dependency-free at runtime besides pi's extension APIs and Node built-ins.
- Rules are loaded from global `~/.claude/rules/**/*.md` and local `.claude/rules/**/*.md`.
- `PI_CLAUDE_RULES_DIR` overrides the global rules directory.
- Local rules override global rules with the same relative path under the rules directory.
