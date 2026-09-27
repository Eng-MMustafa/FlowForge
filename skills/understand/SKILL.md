---
name: understand
description: Understand the current project like an engineer (architecture, conventions) and generate its rules (AGENTS.md draft + knowledge.json) via the FlowForge understand flow
argument-hint: "[optional focus area]"
triggers:
  - user
---

Run the FlowForge **understand** flow on the current project. **You ARE the orchestrator for the understand flow:** read `WORKBENCH/skills/flow/SKILL.md` once and follow it; do not invoke another skill. Your job is routing, state, gates and the final AGENTS.md merge — the analyst and thinker stages do the analysis.

Follow the orchestration procedure defined in the `flow` skill (same state contract, gates, subagents, scripts) with:
- flow-name = `understand` (flow file: `WORKBENCH/flows/understand.json`, WORKBENCH = the `workbench` field of `flowforge.json` in Devin's config directory: `$DEVIN_CONFIG_DIR`, else `%APPDATA%\devin` on Windows, `~/Library/Application Support/devin` on macOS, `~/.config/devin` or `~/.devin` on Linux)
- {TASK} = the user's optional focus area argument, or "full project understanding" if none given.

Notes specific to this flow:
- After the final gated stage is approved, copy `.workbench/artifacts/agents-draft.md` into the project root as `AGENTS.md` — but if an `AGENTS.md` already exists, MERGE: preserve the user's existing content and append/update a clearly marked `## Project knowledge (FlowForge)` section instead of overwriting. If that section already exists, replace it in place — never append a duplicate.
- `knowledge.json` stays in `.workbench/` and is consumed by later task flows (commands for `scripts/run-checks.mjs`, conventions for the roles).
- Before reporting done, confirm `.workbench/knowledge.json` parses as JSON (`node -e "JSON.parse(require('fs').readFileSync('.workbench/knowledge.json','utf8'))"`). If it does not, re-run the rules stage once with the parse error appended; if it still fails, report it instead of claiming success.
- Suggest the user run `/flow task "<their next task>"` when done.
