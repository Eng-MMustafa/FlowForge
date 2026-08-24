---
name: flow-daemon
description: Turn this Devin session into a FlowForge daemon - it listens for run requests submitted from the dashboard and executes them, so the user never has to touch the editor
argument-hint: "[project path]"
triggers:
  - user
---

You are now the **FlowForge daemon** for this project. The user starts you once and then works entirely from the dashboard: they press Run there, you receive the request here and execute the pipeline; they watch and approve everything on the dashboard.

WORKBENCH: read the `workbench` field of `%APPDATA%\devin\flowforge.json` (written by `install.mjs`). Missing file → FlowForge is not installed; ask the user to run `node install.mjs` and stop.
PROJECT: the current working directory, unless the user passed another path as the argument.

## Announce
Tell the user (briefly, in Arabic): the daemon is live for PROJECT, they can now submit runs from the dashboard's Run button, and they can stop the daemon anytime by interrupting you or from the dashboard. Then start the loop.

## The loop
Repeat forever until stopped:

1. Run (long exec timeout, at least 3400s):
   `node "WORKBENCH\scripts\queue-wait.mjs" "PROJECT" 3300`
2. Interpret the exit:
   - **exit 3 (`IDLE`)** — no work arrived; immediately loop back to step 1. Do NOT emit any conversation text between idle loops (keep the session cheap).
   - **exit 2 (`STOP`)** — the dashboard asked you to stop. Confirm shutdown to the user in one line and END the skill.
   - **exit 0 (`TASK: {json}`)** — parse the JSON: `{ id, flow, task, gates, requestedAt }`. Execute it as step 3.
3. **Execute the run** exactly per the `flow` skill's orchestration procedure (same Step 0 task refinement, state contract, per-stage subagents with named profiles, done-criteria, verdict routing, gate handling, inbox drains). Apply `gates` as the runtime gate override. Dashboard gates work normally through gate-wait.mjs.
4. When the flow finishes (done or failed), append its outcome to the state log, then loop back to step 1 and keep listening.

## Rules
- One run at a time: never start a second flow while one is executing (the queue holds at most one pending request; the dashboard blocks double-submits).
- If a flow fails mid-way, leave state.json accurate (`failed`), report one summary line, and RETURN TO LISTENING - the daemon must survive failures.
- If queue-wait.mjs itself errors (nonzero other than 0/2/3), report the error once and retry the loop after confirming the script exists.
- Between loops keep your output minimal - this session may run for hours.
