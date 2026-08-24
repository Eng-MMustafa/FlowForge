<div align="center">

# FlowForge ⚙

**Turn one rough sentence into a staged engineering pipeline — planned, analysed, implemented, tested, debugged and shipped by specialised AI subagents, with a live dashboard you actually control.**

[![npm](https://img.shields.io/npm/v/flowforge-cli?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/flowforge-cli)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-3ecc6b?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-6fb8ff)](#zero-dependencies)
[![Tests](https://img.shields.io/badge/tests-255%20passing-3ecc6b)](#tests)
[![License](https://img.shields.io/badge/license-MIT-f0a92e)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-6fb8ff)](#requirements)

[Arabic README →](docs/README.ar.md) · [Install](#install-in-one-command) · [Dashboard tour](#the-dashboard--a-guided-tour) · [Flow format](#flow-files--the-schema) · [API](#http-api)

</div>

## Install in one command

```powershell
iwr -useb https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/get.mjs -o "$env:TEMP\ff.mjs"; node "$env:TEMP\ff.mjs"
```

That is the whole setup. It downloads FlowForge, wires it into Devin if Devin is on the machine, and opens the dashboard. **No npm install, no dependencies, no config file.** Run the same command again any time to update.

<div align="center">

![FlowForge dashboard](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/01-overview.png)

</div>

---

## Table of contents

- [Why FlowForge](#why-flowforge)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Other ways to install](#other-ways-to-install)
- [The `flowforge` command](#the-flowforge-command)
- [Quick start](#quick-start)
- [The dashboard — a guided tour](#the-dashboard--a-guided-tour)
  - [1. Run bar & prompt generator](#1-run-bar--prompt-generator)
  - [2. Pipeline view](#2-pipeline-view)
  - [3. Live activity](#3-live-activity)
  - [4. Artifacts & export](#4-artifacts--export)
  - [5. Visual flow editor](#5-visual-flow-editor)
  - [6. Agents](#6-agents)
  - [7. Skills](#7-skills)
  - [8. Executors — who does the work](#8-executors--who-does-the-work)
  - [9. Studio — the wordless builder](#9-studio--the-wordless-builder)
  - [10. Themes and language](#10-themes-and-language)
- [Flow files — the schema](#flow-files--the-schema)
- [Built-in flows](#built-in-flows)
- [Agent roles](#agent-roles)
- [Skills (chat commands)](#skills-chat-commands)
- [Quality gates](#quality-gates)
- [Document conversion library](#document-conversion-library)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Design principles](#design-principles)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why FlowForge

Asking an AI coding agent to "fix the bug" gives you one long, unreviewable turn: it plans, edits and declares victory in a single breath, and you only find out what it actually did afterwards.

FlowForge splits that into **stages with different specialists, and stops between them**:

| Without FlowForge | With FlowForge |
|---|---|
| One agent, one prompt, one model | Six roles, each with its own contract, model and thinking level |
| You review the diff at the end | You approve at every gate, before the next stage starts |
| "It works" is the agent's opinion | A dedicated tester must emit `VERDICT: PASS` — a `FAIL` jumps back to a debugger |
| Reasoning disappears into chat | Every stage writes a markdown artifact you can read, export and keep |
| A run is a black box | A live dashboard shows the stage, model, output tail, file changes and log |

Nothing here is a wrapper around a hosted service: it is a folder of markdown role contracts, JSON flow definitions and Node scripts, plus a single-file HTTP dashboard.

---

## How it works

```
  /flow task "add rate limiting to the API"
             │
             ▼
   ┌───────────────────┐   refines the sentence into a precise task statement
   │   orchestrator    │   reads flows/task.json and runs the stages in order
   └───────────────────┘
             │
   ┌─────────┴──────────────────────────────────────────────────────┐
   ▼            ▼            ▼            ▼            ▼            ▼
 thinker  →  analyst   →   coder    →   tester   →  debugger  →  shipper
 plan.md    analysis.md  code-notes.md  review.md   debug.md    ship.md
   │            │            │            │  │         │
   └── gate ────┴── gate ────┴── gate ────┘  └─ FAIL ──┘ (loops back, max N)
        │                                        PASS ──────────► ship
        ▼
  approve / reject  ← terminal prompt, dashboard button, or auto
```

- **Stages** are defined in a JSON flow file — order, agent, model, prompt, artifact, gate and failure jump are all data, not code.
- **Subagents** are markdown role contracts in `agents/`. Each one only writes its own artifact and stays in its lane.
- **Gates** pause the run and wait for you (terminal or dashboard) or pass automatically, per stage.
- **Artifacts** land in `<project>/.workbench/artifacts/` and are rendered live in the dashboard.
- **State** lives in `<project>/.workbench/state.json`, which the dashboard polls — so the UI never has to be in the same process as the run.

---

## Requirements

| | |
|---|---|
| **OS** | Windows (paths, junctions and terminal handling are Windows-specific) |
| **Node.js** | 18 or newer (20+ recommended; the screenshot tooling uses Node 22 features) |
| **Executor** | [Devin CLI](https://devin.ai) — the only executor that can *run* a flow today |
| **Optional** | GitHub CLI (`gh`) for Copilot account detection, Cursor / Trae for module detection |
| **Dependencies** | **None.** The `package.json` exists only to expose the CLI — it declares no dependencies and there is no lockfile |

---

## Other ways to install

**Run it without installing anything** — npx fetches the package and starts the dashboard on the folder you are in:

```powershell
npx flowforge-cli
```

**Straight from GitHub**, if you want the newest commit rather than the last release:

```powershell
npx github:Eng-MMustafa/FlowForge
```

**From source**, if you want to hack on it:

```powershell
git clone https://github.com/Eng-MMustafa/FlowForge.git
cd FlowForge
node install.mjs
node start.mjs
```

**What the installer actually does** (no admin rights, nothing outside these three):

1. Writes a **locator** at `%APPDATA%\devin\flowforge.json` pointing at your copy, so it can live anywhere.
2. Creates **directory junctions** `%APPDATA%\devin\skills` → `skills/` and `%APPDATA%\devin\agents` → `agents/`, so edits apply live with no reinstall.
3. Strips any machine-specific absolute path an older copy may have baked into a skill file.

Start a **new** agent session afterwards so the skills are picked up. To undo it all (junctions and locator only — your projects are never touched):

```powershell
node uninstall.mjs
```

---

## The `flowforge` command

Installed globally, the CLI works from any folder — the folder you are standing in becomes the project:

```powershell
npm i -g flowforge-cli
```

| Command | Does |
|---|---|
| `flowforge` | Starts the dashboard on the current folder |
| `flowforge C:\path\to\project` | Starts it on that project |
| `flowforge install` / `uninstall` | Wires (or unwires) the skills and agents |
| `flowforge test` | Runs the test suite |
| `flowforge where` | Prints the install folder |
| `flowforge --port=5000 --no-open` | Flags are passed through to the dashboard |

`ff` is a shorter alias for the same command.

---

## Quick start

**From the chat, using a skill:**

```
/flow task "add rate limiting to the public API"
/flow bugfix "uploads over 5MB fail silently"
/understand                       ← learn the project and draft its rules
/flow-status                      ← read-only report of the current run
/flow-resume                      ← continue an interrupted pipeline
```

**From the dashboard:**

```powershell
flowforge                                        # opens http://127.0.0.1:4820
flowforge "C:\path\to\your\project"              # start on a specific project
flowforge --port=5000 --no-open                  # custom port, no browser
flowforge --check                                # health check and exit
```

(From a source checkout the same flags work with `node start.mjs`.)

Pick a flow, type what you want in any language, press **Run now**.

---

## The dashboard — a guided tour

Every screenshot below is the real UI, captured from a running instance.

### 1. Run bar & prompt generator

![Run bar](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/13-runbar.png)

The composer is deliberately one screen: **who** executes, **which** flow, **what** you want, and **how** it should behave.

- **Executor** — Devin / Copilot / Cursor / Trae. Switching filters the flow list, the model catalogue and the module detection. Only Devin can execute.
- **Task box** — an auto-growing textarea. Write in any language; Arabic is fine.
- **✨ Generate** turns a rough line into a full English task statement (adds the outcome and acceptance criteria).
- **⚡ Optimize** sharpens a prompt you already wrote *without* inventing scope. Both keep an **Undo** of your original text.
- **Gates** — override the flow's gate mode for this run: default / terminal / dashboard / auto.
- **Speed** — `fast` (lightning models, minimal thinking) → `quality` (max thinking on every stage), overriding the pinned models for one run.
- The grey line underneath is the exact CLI command, ready to copy if you would rather paste it into a chat.

The prompt generator tries your existing Devin login first, then any OpenAI-compatible endpoint you configure (Groq, OpenRouter, Gemini, local Ollama), then an offline template — so it still works with no key at all.

### 2. Pipeline view

![Pipeline](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/14-pipeline.png)

The live spine of a run: refined task on top (with the raw text you typed underneath), then one row per stage showing the role, the pinned **model** and **thinking level**, the status colour, a per-stage note and the retry counter. Beside it sits the tail of the artifact currently being written, an inbox to send the agent a mid-run instruction, the file-change feed and the log.

### 3. Live activity

![Activity](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/02-activity.png)

A filesystem watcher on the active project (build noise excluded), plus real Git state: current branch, changed files, the diffstat, and a click-to-open unified diff — so you can watch exactly what the agent is touching while it works.

### 4. Artifacts & export

![Artifacts](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/03-artifacts.png)

Every stage output rendered as markdown, with `VERDICT: PASS/FAIL` lines and checkboxes styled as badges, and a raw toggle. The **Export as** control converts any artifact into **PDF, Word, Excel, CSV, HTML, TXT, Markdown or JSON** and writes it to `<project>/.workbench/exports/` — using the project's own converter, with no external library.

### 5. Visual flow editor

![Flow canvas](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/04-flows-canvas.png)

A flow is a JSON file, but you never have to write one. Drag labelled icon nodes onto a canvas and wire them:

![Palette](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/06-flow-palette.png)

- **Agent steps** — the six roles, plus analytics and performance specialists.
- **Understand steps** — architecture, conventions and rules extraction.
- **Script & custom** — `scan`, `checks` and `script` nodes have no agent at all: their pre-scripts *are* the work.

Wiring rules: the **blue port on the right** is the next stage; the **amber port at the bottom** is the on-failure jump (with its own retry count); clicking a wire deletes it; the gate button on a node cycles auto → dashboard → terminal → default; the green dot marks the entry step.

![Step inspector](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/05-flow-inspector.png)

Selecting a node opens the **step inspector** — labelled dropdowns only, no free typing: model family, thinking level, gate mode, retry loops, pre-script toggles and the artifact name. The same overrides appear as chips on the node itself. Node positions round-trip through the flow file and are ignored by the orchestrator.

### 6. Agents

![Agents](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/07-agents.png)

Role contracts are markdown with front-matter, and you get three ways to edit them: a **visual** editor (presets, model, tools, artifact, sections and rules as toggles), a **form** view, and the **raw** file. The preview underneath shows exactly what will be written to disk.

### 7. Skills

![Skills](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/08-skills.png)

The same three-way editing for the chat commands (`/flow`, `/understand`, `/flow-status`, …), including which flow a skill launches and its default gate mode.

### 8. Executors — who does the work

![Executors](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/10-providers.png)

One card per tool, built entirely from what is really on the machine:

- **installed** means *that tool*, not its host — Copilot is an extension, so its `github.copilot-*` folder must exist; VS Code plus `gh` alone is **not** Copilot.
- **connected** is read live: `devin auth status` / `gh auth status` for CLI-owned accounts, and for in-app tools the editor's own store — Trae's plain-JSON session is read (including the plan label, e.g. `Pro`), while Cursor keeps its session in a SQLite file that this project will not add a dependency to parse, so it honestly reports *sign-in state not readable* rather than guessing "logged out".
- **Sign in** opens a real terminal on the tool's own login command — your password or token never passes through the dashboard, and only key *presence* is ever read, never a token value.
- **Use this one** switches the executor, which filters flows and models, and retargets the models pinned on the canvas to the closest model the new tool actually has.

### 9. Studio — the wordless builder

![Studio](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/12-studio.png)

A second screen at `/studio` with **no text at all** — only icons, sliders, toggles and drag handles. Build a pipeline, set quality and gates, and hit play. It emits ordinary flow JSON, so anything built here opens in the normal editor.

### 10. Themes and language

![Light theme](https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/docs/screenshots/11-overview-light.png)

Dark and light themes, and a full **Arabic ⇄ English** UI (RTL included) that switches instantly — every string is covered by a test that fails if a key is missing in either language.

---

## Flow files — the schema

A flow is one JSON file in `flows/`. Everything the orchestrator does is data:

```json
{
  "name": "task",
  "title": "Task pipeline - think, analyze, code, test, debug, ship",
  "description": "Full engineering pipeline for one task.",
  "defaultGate": "terminal",
  "providers": ["devin"],
  "stages": [
    {
      "id": "think",
      "title": "Think & plan",
      "titleAr": "التفكير والتخطيط",
      "agent": "thinker",
      "model": "claude-opus-5-high",
      "effort": "high",
      "prompt": "Task: {TASK}\n\nWrite the plan to .workbench/artifacts/plan.md in {PROJECT}.",
      "pre": ["scripts/collect-context.mjs"],
      "post": [],
      "gate": "default",
      "gateQuestion": "Review plan.md — proceed?",
      "gateQuestionAr": "راجع الخطة — نكمل؟",
      "artifact": "plan.md",
      "done": ["plan.md exists and contains all required sections"],
      "onFail": "debug",
      "maxLoops": 3
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Flow id, must match the file name |
| `title` / `titleAr` | Bilingual display name |
| `defaultGate` | `terminal` \| `dashboard` \| `auto` — used by stages whose gate is `default` |
| `providers` | *Optional.* Restricts the flow to these executors. Absent = available to all |
| `stages[].id` | Unique stage id, also the node id on the canvas |
| `stages[].agent` | Role file in `agents/`, or `null` for a script-only stage |
| `stages[].model` | *Optional.* Any model id the executor supports; beats the role default |
| `stages[].effort` | *Optional.* `none`…`max` — becomes the subagent's thinking level |
| `stages[].prompt` | Task text. `{TASK}` and `{PROJECT}` are substituted |
| `stages[].pre` / `post` | Node scripts run before/after the subagent |
| `stages[].gate` | `default` \| `auto` \| `dashboard` \| `terminal` |
| `stages[].artifact` | File written under `.workbench/artifacts/` |
| `stages[].done` | Done-criteria the orchestrator checks before moving on |
| `stages[].onFail` | Stage to jump to on failure |
| `stages[].maxLoops` | Cap on that failure loop |
| `stages[].runOnlyWhenJumpedTo` | Stage is skipped in the linear order and only entered via a jump |

Create one from a template with `node scripts/new-flow.mjs my-flow`, or just draw it on the canvas.

---

## Built-in flows

| Flow | What it is for |
|---|---|
| `task` | The full pipeline: think → analyze → code → test → debug → ship |
| `understand` | Learn an unfamiliar project and draft its `AGENTS.md` + knowledge file |
| `bugfix` | Reproduce → root-cause → fix → regression test → prove |
| `tests` | Map coverage, write the missing tests, prove they fail before the fix |
| `perf` | Baseline → hotspot → optimize → prove the delta |
| `quality` | Deepest thinking on every stage, for work you cannot get wrong |
| `cheap` | The full pipeline on low-cost models |
| `fast` | Code → verify → ship, no gates |
| `design` | Research, options and a decision record — no code |
| `analytics` | Business/data analysis: measure, interpret, recommend — no code |

---

## Agent roles

Each role is a markdown contract in `agents/` with a strict scope and exactly one artifact.

| Role | Produces | Rule it must obey |
|---|---|---|
| **thinker** | `plan.md` | Plans only — never touches project code |
| **analyst** | `analysis.md` | Reads and maps the codebase; flags plan corrections |
| **coder** | `code-notes.md` | The only role allowed to modify project files |
| **tester** | `review.md` | Must lead its reply with `VERDICT: PASS` or `VERDICT: FAIL` |
| **debugger** | `debug.md` | Reproduce first, fix root causes only, then re-verify |
| **shipper** | `ship.md` | Packages and delivers the change |
| **researcher** | `report.md` | External/domain research for the analytics and design flows |
| **optimizer** | `perf.md` | Baselines and optimises, must prove the delta |

---

## Skills (chat commands)

| Skill | Does |
|---|---|
| `/flow <flow> "<task>"` | Runs a pipeline end to end |
| `/understand` | Studies the project and drafts its rules |
| `/flow-status` | Read-only report: stages, gates, loops, artifacts |
| `/flow-resume` | Resumes an interrupted pipeline from its recorded state |
| `/flow-daemon` | Turns the session into a worker that executes runs launched from the dashboard |
| `/export` | Converts an artifact or document to PDF / Word / Excel / … |

---

## Quality gates

A gate is a stop between stages. The mode is resolved in this order:

1. `--gates` on the run (or the dashboard's **Gates** dropdown)
2. a non-`default` gate on the stage itself
3. `gateMode` in the project's `.workbench/settings.json`
4. the flow's `defaultGate`

| Mode | Behaviour |
|---|---|
| `terminal` | The orchestrator asks in the chat/terminal and waits |
| `dashboard` | An **approve / reject** card appears in the dashboard; the run blocks until you press one. You can attach a note that is handed to the agent |
| `auto` | No stop — the pipeline runs straight through |

Rejecting sends the stage back with your note instead of aborting the run.

---

## Document conversion library

One converter, zero dependencies, three front doors:

```powershell
node scripts\convert-doc.mjs .workbench\artifacts\review.md --to pdf
node scripts\convert-doc.mjs report.md --to docx --title "Q3 report"
node scripts\convert-doc.mjs data.md   --to xlsx
node scripts\convert-doc.mjs .workbench\artifacts --to pdf --out C:\deliverables
node scripts\convert-doc.mjs --help
```

- **CLI** — the command above.
- **Skill** — `/export review.md to pdf` inside a chat.
- **Dashboard** — the Export control on the Artifacts tab.

| Format | Notes |
|---|---|
| `pdf` | Headless Edge/Chrome by default (handles Arabic/RTL); a builtin core-font writer as fallback |
| `docx` | Real OOXML package, built with an in-repo ZIP writer |
| `xlsx` | Markdown tables become sheets |
| `csv`, `html`, `txt`, `md`, `json` | Direct writers |

---

## Scripts

| Script | Purpose |
|---|---|
| `start.mjs` | Starts the dashboard, registers the project, opens the browser |
| `install.mjs` / `uninstall.mjs` | Wire (or unwire) the workbench into the agent's global config |
| `scripts/collect-context.mjs` | Gathers Git state and a bounded file tree into `context.md` |
| `scripts/run-checks.mjs` | Runs the project's own build/lint/test and writes a `RESULT:` verdict |
| `scripts/gate-wait.mjs` | Blocks a run on a dashboard gate (exit 0 approve / 2 reject / 3 timeout) |
| `scripts/queue-wait.mjs` | Daemon mode: waits for a run request from the dashboard |
| `scripts/new-flow.mjs` | Scaffolds a new flow file |
| `scripts/convert-doc.mjs` | The document converter |

---

## Configuration

**Per project** — `<project>/.workbench/settings.json`, written by the dashboard:

| Key | Meaning |
|---|---|
| `gateMode` | Default gate behaviour for this project |
| `executorProvider` | Which tool is selected |
| `refineProvider` | `auto` \| `acp` \| `cli` \| `http` \| `local` for the prompt generator |
| `refineApiBase`, `refineModel`, `refineApiKey` | OpenAI-compatible endpoint for prompt generation. The key is stored server-side and **never** sent back to the browser |

**Environment variables:**

| Variable | Effect |
|---|---|
| `DEVIN_CLI` | Explicit path to the Devin CLI |
| `DEVIN_BROWSER` / `CHROME_PATH` | Browser used for PDF rendering |
| `FF_PROVIDER_HOME_<ID>` | Overrides where a provider is looked for (used by the test suite) |

---

## HTTP API

The dashboard is a plain `node:http` server; every screen is built on this API, so scripting it is trivial.

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Everything the UI polls: run state, stages, gate, flows, projects |
| `GET /api/activity` · `/api/changes` · `/api/diff` | File watcher feed and Git state |
| `GET /api/artifact` · `POST /api/export` · `GET /api/formats` | Read and convert artifacts |
| `GET/POST/DELETE /api/flow` | Flow CRUD (the list ships inside `/api/state`) |
| `GET/POST/DELETE /api/agent` · `/api/skill` | Role and skill CRUD |
| `POST /api/run` · `POST /api/run/stop` · `GET /api/run` | Start, stop and stream a run |
| `POST /api/command` | Answer a gate (approve / reject with a note) |
| `POST /api/inbox` | Send a mid-run instruction to the agent |
| `POST /api/refine` | Generate or optimise a task statement |
| `GET /api/providers` · `/api/provider` · `/api/provider-auth` · `POST /api/provider/login` | Executor detection, live login state and login |
| `GET /api/models` · `POST /api/retarget-models` · `POST /api/retarget-flows` | Model catalogue and cross-executor retargeting |
| `GET/POST /api/settings` · `/api/projects` | Settings and the project registry |

---

## Tests

```powershell
node dashboard\test\run-tests.mjs
```

**255 checks, no test framework.** The suite spawns its own server on a spare port with a temporary scratch project, and restores your registry afterwards. It covers UI script syntax, complete bilingual i18n key coverage, the Studio's text-free guarantee, the flow↔graph round trip and cycle rejection, every API endpoint, the watcher feed, the gate protocol, provider detection/auth/model mapping, path-traversal guards, and the document converter (real PDF bytes, and `.docx`/`.xlsx` opened with Windows' own ZIP reader).

---

## Project layout

```
FlowForge/
├── agents/              role contracts (thinker, analyst, coder, tester, …)
├── flows/               pipeline definitions (JSON)
├── skills/              chat commands (/flow, /understand, /export, …)
├── scripts/             context, checks, gates, queue, converter
│   └── lib/             zero-dep pdf / docx / xlsx / html / markdown / zip writers
├── dashboard/
│   ├── server.mjs       the whole HTTP API (node:http only)
│   ├── providers.mjs    executor registry: detection, auth, model catalogues
│   ├── acp-client.mjs   Devin ACP session client
│   ├── ui/index.html    the dashboard (single file)
│   ├── ui/studio.html   the wordless builder
│   └── test/            the 255-check suite
├── docs/screenshots/    the images in this README
├── bin/flowforge.mjs     the global CLI
├── get.mjs               the one-command installer
├── install.mjs · uninstall.mjs · start.mjs
```

Runtime state lives in each **target project** under `.workbench/` — never in this repo.

---

## Design principles

<a name="zero-dependencies"></a>

1. **Zero external dependencies.** No npm packages, no lockfile, no supply chain — a test fails the build if an import is not a Node builtin or a local file. Everything, including the installer, is Node builtins.
2. **No PowerShell script files.** Group Policy on the target machine is `AllSigned`, so every executable piece is a `.mjs` file.
3. **Data over code.** Flows, roles and skills are files you can read and edit; the orchestrator interprets them.
4. **Honest UI.** If a state cannot be read, it says *unknown* — it never guesses on your behalf. Buttons that could only fail are not rendered.
5. **Your credentials stay yours.** Logins run in a real terminal against the vendor's own CLI; the dashboard never handles a token.
6. **Bilingual by construction.** Every user-facing string exists in English and Arabic, enforced by a test.

---

## Troubleshooting

**The skills do not appear in the chat.** Run `node install.mjs`, then start a *new* session — skills are read at session start.

**`devin` is not found.** Set `DEVIN_CLI` to the executable path, or make sure it is on `PATH`. The dashboard shows the resolved path on the Settings tab.

**A run is stuck at a gate.** Check the gate mode: with `terminal` the orchestrator waits in the chat window, not in the dashboard. Switch to `dashboard` in Settings to answer from the browser.

**PDF export prints `?` for Arabic.** The builtin PDF writer is Latin-only. Install Edge or Chrome, or set `DEVIN_BROWSER` — the browser engine handles RTL correctly.

**The dashboard shows an old project.** Switch it from the picker in the header; the active project is stored per browser.

---

## License

[MIT](LICENSE) © Mohammed Mustafa
