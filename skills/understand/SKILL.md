---
name: understand
description: Understand the current project like an engineer (architecture, conventions) and generate its rules (AGENTS.md draft + knowledge.json) via the FlowForge understand flow
argument-hint: "[optional focus area]"
triggers:
  - user
---

Run the FlowForge **understand** flow on the current project.

Follow the orchestration procedure defined in the `flow` skill (same state contract, gates, subagents, scripts) with:
- flow-name = `understand` (flow file: `WORKBENCH\flows\understand.json`, WORKBENCH = the `workbench` field of `%APPDATA%\devin\flowforge.json`)
- {TASK} = the user's optional focus area argument, or "full project understanding" if none given.

Notes specific to this flow:
- After the final gated stage is approved, copy `.workbench/artifacts/agents-draft.md` into the project root as `AGENTS.md` — but if an `AGENTS.md` already exists, MERGE: preserve the user's existing content and append/update a clearly marked `## Project knowledge (FlowForge)` section instead of overwriting.
- `knowledge.json` stays in `.workbench/` and is consumed by later task flows (commands for run-checks.ps1, conventions for the roles).
- Suggest the user run `/flow task "<their next task>"` when done.
