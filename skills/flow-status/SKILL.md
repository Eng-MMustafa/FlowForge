---
name: flow-status
description: Show the current FlowForge pipeline state for this project (stages, gates, loops, artifacts)
allowed-tools:
  - read
  - glob
triggers:
  - user
  - model
---

Report the current FlowForge state for the project (current working directory unless the user names another path).

1. Read `.workbench/state.json`. If it does not exist, say no flow has run here and suggest `/understand` or `/flow task "..."`.
2. Present a compact status:
   - Flow, task, overall status, effective gate mode, started/updated times.
   - A stage table: id — title — status — one-line note. Mark the current stage clearly.
   - Loop counters if any stage looped (e.g. test/debug rounds).
   - If status is `waiting_gate`: say exactly which stage waits and where to answer (terminal or dashboard).
   - The last 5 log entries.
3. List which artifacts exist in `.workbench/artifacts/` with their sizes (plan.md, analysis.md, code-notes.md, review.md, debug.md, ship.md, context.md, checks.md, understanding.md).
4. Do NOT modify anything. This is a read-only report.
