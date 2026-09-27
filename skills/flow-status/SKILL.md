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

Report the current FlowForge state for the project (current working directory unless the user names another path). **Your responsibility is a read-only report:** you only read `.workbench/` — never write state, never resume or start a run, never invoke another skill.

1. Read `.workbench/state.json`. If it does not exist, say no flow has run here and suggest `/understand` or `/flow task "..."`.
2. Present a compact status:
   - Flow, task, overall status, effective gate mode, started/updated times.
   - A stage table: id — title — status — one-line note. Mark the current stage clearly; if several stages are `running` at once, they are a parallel group — mark each.
   - Loop counters if any stage looped (e.g. test/debug rounds).
   - If status is `waiting_gate`: say exactly which stage waits and where to answer (terminal or dashboard).
   - If the gate mode is `ai`: no human answers — the critic reviews while the stage stays `running`; report the latest `ai review round` log line.
   - The last 5 log entries.
3. List every file in `.workbench/artifacts/` (glob), with sizes when the tool reports them.
4. Suggest `/flow-resume` when the status is `failed` or `stopped`, or when it is `running` but `updatedAt` is stale (no update for a long time suggests the session died).
5. Do NOT modify anything. This is a read-only report.
