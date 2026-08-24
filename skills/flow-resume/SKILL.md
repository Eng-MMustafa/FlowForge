---
name: flow-resume
description: Resume an interrupted FlowForge pipeline from its last recorded state
argument-hint: "[--gates=auto|terminal|dashboard]"
triggers:
  - user
---

Resume the FlowForge pipeline recorded in `.workbench/state.json` of the current project.

1. Read `.workbench/state.json`. If missing, or `status` is `done`, tell the user there is nothing to resume (show the final summary if done) and stop.
2. Reload the flow definition it names from `WORKBENCH\flows\<flow>.json` (WORKBENCH = the `workbench` field of `%APPDATA%\devin\flowforge.json`) and re-read `.workbench/knowledge.json` and recent artifacts as needed to re-establish context — do NOT redo completed stages.
3. Determine the resume point:
   - A stage with status `running` or `waiting_gate` → restart THAT stage (its artifact may be partial; the stage agent overwrites it).
   - Otherwise → the first `pending` stage in flow order (respecting `runOnlyWhenJumpedTo`).
   - If the previous run `failed` at a stage, resume at that stage, feeding the failure note from the log into the stage prompt.
4. Apply a `--gates` override if the user passed one; otherwise keep the recorded gateMode.
5. Continue executing exactly per the `flow` skill's orchestration procedure (same state contract, gates, verdict routing, inbox draining) until the flow completes.
6. First action before resuming any stage: drain `.workbench/inbox.md` — the user may have left instructions while the flow was stopped.
