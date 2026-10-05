---
name: flow-resume
description: Resume an interrupted FlowForge pipeline from its last recorded state
argument-hint: "[--gates=auto|terminal|dashboard|ai] [--speed=fast|balanced|quality] [--headless=acp|cli]"
triggers:
  - user
---

Resume the FlowForge pipeline recorded in `.workbench/state.json` of the current project. **You ARE the orchestrator for this run:** follow the `flow` skill's procedure (`WORKBENCH/skills/flow/SKILL.md`, read once) and never invoke another skill. Your job is to continue exactly where the run stopped — never redo finished work, never reset its history.

State changes go through the state engine exactly as in the `flow` skill: `node "WORKBENCH/scripts/state.mjs" "PROJECT" <command> [+ <command> ...]` — never edit state.json by hand.

1. First action, ONE call: `state.mjs PROJECT inbox + show`. The `INBOX:` part is what the user left while the flow was stopped — treat it as direct user instructions (they may change or cancel the resume); the `show` part is where the run stands. (If it fails with "no state.json", there is nothing to resume - say so and stop.)
2. If the run's status is `done`, tell the user there is nothing to resume (show the final summary) and stop.
3. Reload the flow definition it names from `WORKBENCH/flows/<flow>.json` (WORKBENCH = the `workbench` field of `flowforge.json` in Devin's config directory: `$DEVIN_CONFIG_DIR`, else `%APPDATA%\devin` on Windows, `~/Library/Application Support/devin` on macOS, `~/.config/devin` or `~/.devin` on Linux) and re-read `.workbench/knowledge.json` and recent artifacts as needed to re-establish context — do NOT redo completed stages.
   If the stage ids in state.json no longer match the flow file (it was edited since), reconcile by id: keep the recorded status of stages that still exist, add new ones as `pending` in flow order, drop removed ones, and log `flow changed: added <ids>, removed <ids>`.
4. Determine the resume point:
   - A stage with status `running` or `waiting_gate` → restart THAT stage (its artifact may be partial; the stage agent overwrites it).
   - Otherwise → the first `pending` stage in flow order (respecting `runOnlyWhenJumpedTo`).
   - If the previous run `failed` at a stage, resume at that stage, feeding the failure note from the log into the stage prompt.
   - If the resume stage belongs to a `parallel` group, restart only the group's unfinished members (not `done`), together, per the `flow` skill's parallel rules; finished members keep their artifacts.
5. Apply a `--gates` override if the user passed one; otherwise keep the recorded gateMode. `--speed` works as in the `flow` skill. `--headless=acp|cli` means the dashboard started this resume and nobody reads the conversation: follow the `flow` skill's headless gate rules exactly (over `acp`, end your turn at a gate and wait for `GATE_DECISION`; never ask in the chat).
6. A stage that was `waiting_gate` when the run stopped keeps its artifact if the artifact exists and its done-criteria still hold - do not redo the work, just ask the gate again (per the effective gate mode) and continue. Only a `running` stage is restarted.
7. Bring the run back to life and start the resume stage in ONE call: `state.mjs PROJECT flow running + stage <resume-stage> running --log "resumed at <stage> (<reason: stopped|failed>)"` (add `+ set gateMode <mode>` when a `--gates` override applies). Keep the recorded `loops` counters — never reset them: a resumed test/debug loop still counts against `maxLoops`. Then continue executing exactly per the `flow` skill's orchestration procedure (same state contract, gates, verdict routing, inbox draining) until the flow completes.
