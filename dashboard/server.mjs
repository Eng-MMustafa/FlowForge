// FlowForge dashboard server - zero dependencies (node builtins only).
//
// Usage: node server.mjs ["C:\path\to\project"] [port]
//   - The project argument is optional: projects are managed in a registry file
//     (dashboard/projects.local.json, gitignored) and can be added/switched from the UI.
//   - If a project argument is given it is added to the registry and activated.
//
// Serves the UI plus a small JSON API over the active project's .workbench/ files,
// a recursive file-watcher feed (live activity), and git change summaries.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAcp, readStoredKey } from './acp-client.mjs';
// The dashboard exports artifacts through the very same library the CLI and the
// /export skill use - one converter, three front doors.
import { convert as convertDoc } from '../scripts/convert-doc.mjs';
import { FORMATS, FORMAT_IDS, extensionFor } from '../scripts/lib/formats.mjs';
// Every OS difference (paths, openers, terminals, kill) lives in one place.
import {
  openAppCommand, terminalCommand, killTreeCommand, loginScriptFormat, loginScriptLines,
  devinCliCandidates, stateDir, samePath,
} from '../scripts/lib/platform.mjs';
// Executor providers (Devin, Copilot, Cursor, Trae) live in one registry file.
import {
  PROVIDER_IDS, DEFAULT_PROVIDER, detectProvider, buildFlowFromModules,
  providerModels, summarizeProviders, checkProviderAuth, invalidateProviderAuth,
  providerLoginScript, providerAuthKind, mapModelsToProvider,
  PRINT_PROVIDERS, providerPrintArgs,
} from './providers.mjs';
// Token estimates and real usage, read from Devin's own session log.
import {
  REFINE_MARK, readDevinSessions, readSessionUsage, findSessionFor, linkRuns,
  aggregateUsage, estimateRun, usageReportMarkdown, refreshPrices, dollarRate, totalTokens,
} from './usage.mjs';
// Every other AI tool's usage, read from the tool's own records.
import {
  TRACKERS, readAllSources, makePricer, refreshLiteLLM, refreshCopilotBilling, copilotBillingState,
  setCursorHook, cursorHookInstalled, setTrackedEnv, trackedEnvOn, setTrackingFlag, trackingFlag,
  resolveGh,
} from './usage-sources.mjs';
import { usageLogDir } from '../scripts/lib/platform.mjs';
import { JobStore, pickNext, nextRunAt } from './scheduler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH = path.resolve(__dirname, '..');
// argv: [project|'' , port]. Also accept --port= so the server can be started
// directly the same way the launcher and the CLI are.
const portFlag = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number((portFlag && portFlag.slice(7)) || process.argv[3] || 4820) || 4820;
// FF_REGISTRY lets a test server keep its own project list so it can never
// disturb the registry the real dashboard is using. Otherwise it sits next to
// the code - unless the install is not writable (a root-owned global install),
// in which case it moves to the per-user state directory.
const REGISTRY_FILE = process.env.FF_REGISTRY
  || path.join(stateDir(__dirname), 'projects.local.json');
const FLOWS_DIR = path.join(WORKBENCH, 'flows');
const AGENTS_DIR = path.join(WORKBENCH, 'agents');
const SKILLS_DIR = path.join(WORKBENCH, 'skills');
const UI_FILE = path.join(__dirname, 'ui', 'index.html');
const STUDIO_FILE = path.join(__dirname, 'ui', 'studio.html');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GATE_MODES = ['default', 'auto', 'terminal', 'dashboard', 'ai'];
// 'auto' walks Devin's own paths first, then EVERY print-capable provider CLI
// that is installed and connected on this machine, then a configured HTTP
// endpoint, then the offline template. Picking a provider id pins that one.
const REFINE_PROVIDERS = ['auto', 'acp', 'cli', 'http', 'local', ...PRINT_PROVIDERS];
// 'generate' writes the task statement from a rough idea; 'optimize' sharpens a
// prompt that already says what it wants, without widening its scope.
const REFINE_MODES = ['generate', 'optimize'];
// Run speed: 'flow' keeps every stage's own model/effort, the others tell the
// orchestrator to override them (see the mapping table in skills/flow/SKILL.md).
const SPEEDS = ['flow', 'fast', 'balanced', 'quality'];
const speedSuffix = (s) => (SPEEDS.includes(s) && s !== 'flow' ? ` --speed=${s}` : '');
let refining = false; // one prompt-refine request at a time

// ---------- registry ----------

function loadRegistry() {
  try {
    const reg = JSON.parse(fssync.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!Array.isArray(reg.projects)) reg.projects = [];
    return reg;
  } catch {
    return { active: null, projects: [] };
  }
}

async function saveRegistry(reg) {
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf8');
}

// Seed the registry from the optional CLI argument.
{
  const argProject = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
  if (argProject) {
    const p = path.resolve(argProject);
    if (!fssync.existsSync(p) || !fssync.statSync(p).isDirectory()) {
      console.error(`Project directory not found: ${p}`);
      process.exit(1);
    }
    const reg = loadRegistry();
    if (!reg.projects.some((x) => samePath(x, p))) reg.projects.push(p);
    reg.active = p;
    fssync.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf8');
  }
}

function activeProject() {
  const reg = loadRegistry();
  if (reg.active && fssync.existsSync(reg.active)) return reg.active;
  return null;
}

function projectPaths(project) {
  const wb = path.join(project, '.workbench');
  return {
    wb,
    artifacts: path.join(wb, 'artifacts'),
    state: path.join(wb, 'state.json'),
    commands: path.join(wb, 'commands.json'),
    inbox: path.join(wb, 'inbox.md'),
    knowledge: path.join(wb, 'knowledge.json'),
    settings: path.join(wb, 'settings.json'),
    queue: path.join(wb, 'queue.json'),
    daemon: path.join(wb, 'daemon.json'),
  };
}

// A daemon session is considered alive if its heartbeat is fresh.
async function daemonStatus(project) {
  const hb = await readJsonSafe(projectPaths(project).daemon);
  if (!hb || !hb.aliveAt) return { alive: false, status: null, aliveAt: null };
  const fresh = Date.now() - Date.parse(hb.aliveAt) < 15000;
  return { alive: fresh, status: hb.status || null, aliveAt: hb.aliveAt };
}

// ---------- headless runner ----------
// Runs flows directly from the dashboard by spawning the Devin CLI in
// non-interactive print mode. Everything the agent streams to stdout is
// buffered and served to the UI as a live console.

function resolveDevinCli() {
  if (process.env.DEVIN_CLI) return process.env.DEVIN_CLI;
  const known = devinCliCandidates().find((p) => fssync.existsSync(p));
  if (known) return known;
  return 'devin'; // hope it's on PATH
}
const DEVIN_CLI = resolveDevinCli();

const RUN_MAX_LINES = 3000;
// Every run the dashboard started, newest last. Projects run in parallel
// (each has its own state.json); within one project runs are sequential.
// { id, proc, pid, project, flow, task, gates, mode, startedAt, endedAt, exitCode, lines[], cmd, sessionId }
const RUNS = new Map();
const MAX_PARALLEL = Math.max(1, Number(process.env.FF_MAX_PARALLEL) || 3);
const sameProject = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
const allRuns = () => [...RUNS.values()];
const activeRuns = () => allRuns().filter((r) => r.exitCode === null);
const activeRunOf = (project) => activeRuns().find((r) => sameProject(r.project, project)) || null;
// The run the classic single-run endpoints talk about: this project's active
// run, else its most recent one.
const latestRunOf = (project) => activeRunOf(project) || allRuns().reverse().find((r) => sameProject(r.project, project)) || null;
function registerRun(r) {
  r.id = r.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  RUNS.set(r.id, r);
  // Keep memory bounded: finished runs beyond the last 40 are dropped.
  const finished = allRuns().filter((x) => x.exitCode !== null);
  for (const old of finished.slice(0, Math.max(0, finished.length - 40))) RUNS.delete(old.id);
  return r;
}

// Strip ANSI escape sequences (colors, cursor moves, mode toggles) so the
// browser console shows clean text.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')      // OSC sequences
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')             // CSI sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')                      // charset selection
    .replace(/\x1b[@-Z\\-_]/g, '');                        // other escapes
}

// ---------- usage ----------
// Devin's session log is the ground truth for tokens and ACUs; this small log
// adds what it cannot know - which sessions were FlowForge runs and how they
// ended. FF_USAGE_RUNS keeps a test server off the real file.
const RUNS_LOG = process.env.FF_USAGE_RUNS || path.join(stateDir(__dirname), 'usage-runs.local.json');

async function readRunsLog() {
  const v = await readJsonSafe(RUNS_LOG);
  return Array.isArray(v) ? v : [];
}

async function recordRun(r) {
  try {
    const sessionId = r.sessionId || await findSessionFor(r.project, Date.parse(r.startedAt));
    const list = await readRunsLog();
    list.push({
      sessionId: sessionId || null, flow: r.flow, task: r.task, project: r.project, mode: r.mode || 'cli',
      startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode,
    });
    await fs.writeFile(RUNS_LOG, JSON.stringify(list.slice(-500), null, 1), 'utf8');
  } catch { /* the usage page still reads Devin's own log */ }
}

async function usageSessions(force = false) {
  const log = await readDevinSessions({ force });
  // Shallow copies: linking must not stick run info onto the cached objects.
  return { log, sessions: linkRuns(log.sessions.map((s) => ({ ...s })), await readRunsLog()) };
}

// Devin's official per-token price list, cached for a day next to the other
// local state. A request waits at most 1.5s for a (re)download; otherwise it
// uses the cached list and the download finishes in the background.
const PRICE_CACHE = path.join(stateDir(__dirname), 'devin-prices.local.json');
async function priceList() {
  const state = await Promise.race([
    refreshPrices({ cacheFile: PRICE_CACHE }),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  return state && state.table ? state : null;
}
async function dollarsFor(sessions) {
  const pl = await priceList();
  return { ...dollarRate(sessions, pl ? pl.table : null), source: pl ? pl.source : null, fetchedAt: pl ? pl.fetchedAt : null };
}

// The other tools: priced from Devin's official list first (current frontier
// models at API list price), then LiteLLM's public table for everything else.
const LITELLM_CACHE = path.join(stateDir(__dirname), 'litellm-prices.local.json');
const billingCacheFile = () => path.join(usageLogDir(), 'copilot-billing.json');
async function otherToolSessions(month) {
  const pl = await priceList();
  const lite = await Promise.race([refreshLiteLLM({ cacheFile: LITELLM_CACHE }), new Promise((r) => setTimeout(r, 1500))]);
  let billingCache = null;
  if (trackingFlag('copilotBilling')) {
    // Refreshes in the background; this answer uses what is already cached.
    refreshCopilotBilling({ cacheFile: billingCacheFile(), month }).catch(() => {});
    billingCache = await readJsonSafe(billingCacheFile());
  }
  return readAllSources({ pricer: makePricer(pl ? pl.table : null, lite && lite.table), billingCache });
}

// What the Tracking panel shows for each tool: where the numbers come from,
// whether it is switched on, what was found.
async function trackingStatus(status = {}) {
  const billing = copilotBillingState();
  return TRACKERS.map((t) => ({
    tool: t.tool, label: t.label, kind: t.kind,
    enabled: t.tool === 'cursor' ? cursorHookInstalled()
      : t.tool === 'aider' ? trackedEnvOn('aider')
        : t.tool === 'copilot' ? trackedEnvOn('copilot') : null,
    billing: t.tool === 'copilot' ? { on: trackingFlag('copilotBilling'), status: billing.status, message: billing.message, login: billing.login, gh: !!resolveGh() } : undefined,
    ...(status[t.tool] || { found: false, sessions: 0, files: 0, lastSeen: null, unpriced: [], note: null }),
  }));
}

// The live counter of the run in progress. A CLI run never prints its session
// id, so it is looked up (at most every 5s) as the newest session Devin opened
// in the project since the run started.
async function runUsage(r) {
  if (!r || !r.project) return null;
  if (!r.sessionId && Date.now() - (r.sessionProbeAt || 0) > 5000) {
    r.sessionProbeAt = Date.now();
    r.sessionId = await findSessionFor(r.project, Date.parse(r.startedAt));
  }
  if (!r.sessionId) return null;
  if (r.liveUsage && Date.now() - r.liveUsage.at < 3000) return r.liveUsage.value;
  r.liveUsage = { at: Date.now(), value: await readSessionUsage(r.sessionId) };
  return r.liveUsage.value;
}

let stageCountCache = { at: 0, value: {} };
async function flowStageCounts() {
  if (Date.now() - stageCountCache.at < 30000) return stageCountCache.value;
  const value = {};
  try {
    for (const f of await fs.readdir(FLOWS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { value[f.slice(0, -5)] = (JSON.parse(await readTextSafe(path.join(FLOWS_DIR, f))).stages || []).length; } catch { /* skip a broken flow */ }
    }
  } catch { /* no flows dir */ }
  stageCountCache = { at: Date.now(), value };
  return value;
}

function runPush(r, text) {
  if (!r) return;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (line === '' && r.lines.length && r.lines[r.lines.length - 1] === '') continue;
    r.lines.push(line);
  }
  if (r.lines.length > RUN_MAX_LINES) r.lines.splice(0, r.lines.length - RUN_MAX_LINES);
}

// ---------- CLI status (auth) ----------
let cliInfo = null; // { found, path, version, authenticated, checkedAt }

function cliExec(args, timeout = 15000) {
  const viaNode = /\.(mjs|js)$/i.test(DEVIN_CLI);
  const cmd = viaNode ? process.execPath : DEVIN_CLI;
  const cmdArgs = viaNode ? [DEVIN_CLI, ...args] : args;
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}` }));
  });
}

async function checkCli(force = false) {
  if (!force && cliInfo && Date.now() - cliInfo.checkedAt < 60000) return cliInfo;
  const info = { found: false, path: DEVIN_CLI, version: null, authenticated: false, checkedAt: Date.now() };
  // A CLI is only "found" when --version exits 0 (error text is not a version).
  const ver = await cliExec(['--version'], 10000);
  if (!ver.err) {
    info.found = true;
    info.version = ver.out.split('\n')[0].trim() || null;
  }
  if (info.found) {
    // One auth verdict for the whole dashboard: checkProviderAuth keeps a
    // verified login through transient probe failures (sticky, persisted), and
    // only an explicit "not logged in" from the CLI itself clears it.
    const auth = await checkProviderAuth(DEFAULT_PROVIDER, { cliPath: DEVIN_CLI, installed: true }, force);
    info.authenticated = auth.loggedIn;
  }
  cliInfo = info;
  return info;
}

// ---------- model catalogue ----------
// `devin models list` prints families, their aliases and one line per variant:
//   Claude Opus 5 (claude-opus-5)
//     aliases: opus
//     claude-opus-5-high   Claude Opus 5 High  [1M context, ...]
// The dashboard turns that into a family picker + a level picker so a flow
// stage can pin any model the account actually has.
const FALLBACK_FAMILIES = [
  { slug: 'opus', label: 'Opus', aliases: [], variants: [] },
  { slug: 'sonnet', label: 'Sonnet', aliases: [], variants: [] },
  { slug: 'swe', label: 'SWE', aliases: [], variants: [] },
];
let modelCache = null; // { families, source, checkedAt }

function parseModelList(text) {
  const families = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const head = /^(\S.*?) \(([A-Za-z0-9._-]+)\)$/.exec(line);
    if (head) {
      current = { slug: head[2], label: head[1], aliases: [], variants: [] };
      families.push(current);
      continue;
    }
    if (!current) continue;
    const alias = /^\s+aliases:\s*(.+)$/.exec(line);
    if (alias) {
      current.aliases = alias[1].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const variant = /^\s+(\S+)\s{2,}(.+?)(?:\s+\[.*\])?$/.exec(line);
    if (variant) current.variants.push({ id: variant[1], label: variant[2].trim() });
  }
  return families;
}

async function listModels(force = false) {
  if (!force && modelCache && Date.now() - modelCache.checkedAt < 300000) return modelCache;
  const res = await cliExec(['models', 'list'], 20000);
  const families = parseModelList(res.out).filter((f) => f.variants.length || f.aliases.length);
  modelCache = families.length
    ? { families, source: 'cli', checkedAt: Date.now() }
    : { families: FALLBACK_FAMILIES, source: 'fallback', checkedAt: Date.now() };
  return modelCache;
}

// The catalogue a provider is actually judged against. Devin's comes from its
// CLI (40+ families); the static list in providers.mjs is only a last resort, so
// it is reported as untrusted and callers must refuse to rewrite anything.
async function providerCatalogue(id) {
  if (id !== DEFAULT_PROVIDER) return { families: providerModels(id), trusted: true };
  const live = await listModels();
  return { families: live.families, trusted: live.source !== 'fallback' };
}

// ---------- prompt refiner ----------
// Turns a rough, usually Arabic, one-liner into the precise English task
// statement the pipeline wants. Providers are tried in order and the answer is
// always plain text - no provider-specific formatting leaks into the task box.
const REFINER_INSTRUCTION = (raw, flow, mode = 'generate') => {
  const common = [
    '- Inspect the repository only if you need it to name the right component; do not modify anything.',
    '- Imperative mood, no bullet list, no markdown, no preamble.',
    '- Do not explain your reasoning. Your reply must END with one single line in exactly this form:',
    '  TASK: <the task statement>',
  ];
  const head = [
    REFINE_MARK,
    `The pipeline that will run it is "${flow}".`,
    '',
  ];
  const body = mode === 'optimize'
    ? [
      'The text below is already a task prompt. Optimize it for an engineering agent working in this repository.',
      'Rules:',
      '- Keep the SAME scope. Do not add features, files or steps the prompt does not already imply.',
      '- Remove vagueness: replace "improve/handle/some" with the concrete outcome that is being asked for.',
      '- Make the finish line testable - state how the result is verified when the prompt implies it.',
      '- Keep any constraint already stated (paths, formats, limits) word for word.',
      '- 1 to 5 sentences. If the prompt is already precise, return it nearly unchanged.',
      ...common,
      '',
      'Prompt to optimize:',
    ]
    : [
      'The user typed the request below (it may be Arabic, vague, or half a sentence).',
      'Rewrite it as ONE precise English task statement for an engineering agent working in this repository.',
      'Rules:',
      '- Keep the user\'s actual intent; never invent features they did not ask for.',
      '- Name the concrete outcome and, when the request implies them, the acceptance criteria.',
      '- 1 to 4 sentences.',
      ...common,
      '',
      'User request:',
    ];
  return [...head, ...body, raw].join('\n');
};

// Agents narrate while they work, so only the final `TASK:` line counts; other
// providers just answer, and those get the fence/quote/label cleanup.
function cleanRefined(text) {
  let s = String(text || '').trim();
  const fence = /```[a-z]*\n([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const marked = s.match(/TASK:\s*([\s\S]+)$/i);
  if (marked) s = marked[1];
  s = s.replace(/^\s*(task|prompt|statement)\s*:\s*/i, '');
  s = s.replace(/^["'«]+|["'»]+$/g, '');
  s = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  return s.trim();
}

async function refineViaAcp(project, instruction) {
  let text = '';
  const handle = startAcp({
    cwd: project, prompt: instruction, timeoutMs: 180000,
    onUpdate: (u) => {
      // Anything said before a tool call is commentary about the lookup, not
      // the answer - drop it and keep only the text of the final message.
      if (u.sessionUpdate === 'tool_call') { text = ''; return; }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
    },
  });
  await handle.promise;
  return cleanRefined(text);
}

// `devin -p` can drop into the interactive login screen (it also opens a browser
// tab) even when `auth status` claims a valid session. Refining must never do
// that behind the user's back, so the child is killed at the first login marker
// and the attempt reported as failed.
const CLI_LOGIN_MARKER = /how would you like to log in|not logged in|sign in to continue/i;

function refineViaCli(project, instruction) {
  const viaNode = /\.(mjs|js)$/i.test(DEVIN_CLI);
  const cmd = viaNode ? process.execPath : DEVIN_CLI;
  const args = ['--permission-mode', 'normal', '--respect-workspace-trust', 'false', '-p', instruction];
  const cmdArgs = viaNode ? [DEVIN_CLI, ...args] : args;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, {
      cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      // POSIX: lead a process group so the kill below reaches the CLI's
      // children too; on Windows taskkill /T does that job.
      detached: process.platform !== 'win32',
    });
    let out = '';
    let aborted = false;
    const kill = () => {
      const tree = killTreeCommand(proc.pid);
      try {
        if (tree) execFile(tree.cmd, tree.args, { windowsHide: true }, () => {});
        else { try { process.kill(-proc.pid, 'SIGTERM'); } catch { process.kill(proc.pid, 'SIGTERM'); } }
      } catch {}
    };
    const timer = setTimeout(() => { aborted = true; kill(); reject(httpError(504, 'cli timeout')); }, 120000);
    const take = (d) => {
      out += d;
      if (!aborted && CLI_LOGIN_MARKER.test(out)) {
        aborted = true;
        clearTimeout(timer);
        cliInfo = null; // the cached "authenticated" verdict was wrong
        kill();
        reject(httpError(503, 'cli wants interactive login'));
      }
    };
    proc.stdout.on('data', take);
    proc.stderr.on('data', take);
    proc.on('error', (e) => { if (!aborted) { aborted = true; clearTimeout(timer); reject(e); } });
    proc.on('exit', () => {
      if (aborted) return;
      clearTimeout(timer);
      resolve(cleanRefined(out));
    });
  });
}

// Any OpenAI-compatible chat endpoint: Groq, OpenRouter, Together, Gemini's
// compatibility layer, a local Ollama/LM Studio server - all free options.
// Runs a connected provider CLI in its one-shot print mode (claude -p,
// codex exec, gemini -p, opencode run, auggie --print, copilot -p). Returns
// null when the tool is missing or not logged in, so the chain moves on.
async function refineViaProviderCli(id, project, instruction) {
  const spec = providerPrintArgs(id);
  if (!spec) return null;
  const det = await detectProvider(id, project);
  if (!det.cliPath) return null;
  const auth = await checkProviderAuth(id, det);
  if (!auth.loggedIn) return null;
  const file = det.cliPath;
  const batch = /\.(cmd|bat)$/i.test(file);
  const viaNode = /\.(mjs|js|cjs)$/i.test(file);
  const cmd = batch ? (process.env.ComSpec || 'cmd.exe') : viaNode ? process.execPath : file;
  const argv = batch ? ['/c', file, ...spec, instruction] : viaNode ? [file, ...spec, instruction] : [...spec, instruction];
  const { err, stdout, stderr } = await new Promise((resolve) => {
    execFile(cmd, argv, {
      timeout: 120000, windowsHide: true, cwd: project,
      env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 4 << 20,
    }, (e, so, se) => resolve({ err: e, stdout: so, stderr: se }));
  });
  if (err) throw new Error(`${id}: ${String(stderr || err.message).slice(0, 120)}`);
  const text = cleanRefined(`${stdout || ''}\n${stderr || ''}`);
  return text || null;
}

async function refineViaHttp(cfg, instruction) {
  const base = String(cfg.refineApiBase || '').replace(/\/+$/, '');
  if (!base) throw httpError(400, 'refineApiBase is not set');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.refineApiKey ? { Authorization: `Bearer ${cfg.refineApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.refineModel || 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  if (!res.ok) throw httpError(502, `refine provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data && data.choices && data.choices[0]
    && (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
  if (!text) throw httpError(502, 'refine provider returned no text');
  return cleanRefined(text);
}

// No model available: still better than the raw line - it states the repo,
// the pipeline and asks for the acceptance criteria the flows expect.
function refineLocally(raw, flow, project, mode = 'generate') {
  const one = String(raw).trim().replace(/\s+/g, ' ');
  if (mode === 'optimize') {
    // No model available: keep the text as written (optimizing must never lose
    // the user's wording) and append only the missing precision.
    const tail = /acceptance criteria|verif/i.test(one) ? ''
      : ' State the acceptance criteria and how the result is verified.';
    return `${one.replace(/\s*\.?$/, '.')} Work in the repository at ${project}; name the files you change and keep the change minimal.${tail}`;
  }
  return `In the repository at ${project}: ${one}. `
    + `Deliver it as the ${flow} pipeline expects: name the files you change, keep the change minimal, `
    + 'and state the acceptance criteria that prove it works.';
}

function startRun(project, { flow, task, gates, speed, permissionMode }) {
  const safeTask = String(task || '').replace(/"/g, "'").trim();
  const gateMode = ['auto', 'terminal', 'dashboard', 'ai'].includes(gates) ? gates : 'dashboard';
  const speedFlag = speedSuffix(speed);
  // `--headless=cli`: nobody reads this terminal - the skill keeps waiting on
  // the dashboard gate instead of ever asking in the conversation.
  const prompt = flowPrompt(flow, safeTask, gateMode, speedFlag, 'cli');
  const mode = ['accept-edits', 'dangerous', 'normal', 'smart'].includes(permissionMode) ? permissionMode : 'dangerous';
  const args = ['--permission-mode', mode, '--respect-workspace-trust', 'false', '-p', prompt];
  // Test hook: a .mjs/.js DEVIN_CLI is executed through the current node binary.
  const viaNode = /\.(mjs|js)$/i.test(DEVIN_CLI);
  const cmd = viaNode ? process.execPath : DEVIN_CLI;
  const cmdArgs = viaNode ? [DEVIN_CLI, ...args] : args;
  const proc = spawn(cmd, cmdArgs, {
    cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    // POSIX: lead a process group so stopping the run kills the CLI's children
    // too. On Windows taskkill /T does that job and detaching would orphan it.
    detached: process.platform !== 'win32',
  });
  const thisRun = registerRun({
    proc, pid: proc.pid, flow, task: safeTask, gates: gateMode, project, mode: 'cli', sessionId: null,
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
    lines: [], cmd: `devin ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
  });
  runPush(thisRun, `[runner] ${thisRun.cmd}`);
  runPush(thisRun, `[runner] cwd: ${project}`);
  // If the CLI falls into its interactive login screen the run can never
  // proceed (stdin is closed) - kill it and tell the user what to do.
  const authTrap = (chunk) => {
    if (/how would you like to log in|not logged in/i.test(String(chunk))) {
      runPush(thisRun, '[runner] AUTH REQUIRED: the CLI is not logged in.');
      runPush(thisRun, '[runner] Fix (one time): click "Login CLI" in the dashboard, or run: devin auth login');
      runPush(thisRun, '[runner] الحل (مرة واحدة): دوس زرار تسجيل دخول الـ CLI في الشاشة، أو شغّل devin auth login في الترمنال.');
      cliInfo = null;
      stopRun(thisRun);
    }
  };
  proc.stdout.on('data', (d) => { runPush(thisRun, d); authTrap(d); });
  proc.stderr.on('data', (d) => { runPush(thisRun, d); authTrap(d); });
  proc.on('error', (e) => { runPush(thisRun, `[runner] spawn error: ${e.message}`); });
  proc.on('exit', (code) => {
    thisRun.exitCode = code === null ? -1 : code;
    thisRun.endedAt = new Date().toISOString();
    runPush(thisRun, `[runner] exited with code ${thisRun.exitCode}`);
    recordRun(thisRun);
  });
  return thisRun;
}

function stopRun(r) {
  if (!r || r.exitCode !== null) return false;
  if (r.killAcp) {
    try { r.killAcp(); } catch {}
  } else {
    // The CLI spawns children, so the whole tree has to go: taskkill /T on
    // Windows, the process group on POSIX.
    const kill = killTreeCommand(r.pid);
    try {
      if (kill) execFile(kill.cmd, kill.args, { windowsHide: true }, () => {});
      else { try { process.kill(-r.pid, 'SIGTERM'); } catch { process.kill(r.pid, 'SIGTERM'); } }
    } catch {}
  }
  runPush(r, '[runner] stop requested');
  return true;
}

// A login runs from a temp script file: that avoids every shell-quoting trap
// with spaces in a CLI path. The flavour (.cmd + CRLF, or /bin/sh + chmod +x)
// comes from the platform layer.
async function writeLoginScript(name, lines) {
  const fmt = loginScriptFormat();
  const file = path.join(os.tmpdir(), `${name}${fmt.ext}`);
  await fs.writeFile(file, lines.join(fmt.newline) + fmt.newline, 'utf8');
  try { await fs.chmod(file, fmt.mode); } catch { /* Windows has no exec bit */ }
  return file;
}

// ---------- ACP runner (preferred) ----------
// Talks to `devin acp` directly: authenticates with the stored enterprise key
// (works even when the interactive CLI login flow is broken for the org) and
// streams thought/tool/usage updates into the live console.

// Gates over ACP are conversational: the orchestrator ends its turn at a gate
// (`--headless=acp` tells it so), the dashboard shows the question, and the
// decision goes back as the next message on the same session. No script has
// to stay alive in the agent's shell, so no tool timeout can lose the gate.
const RUN_TIMEOUT_MS = Math.max(600000, Number(process.env.FF_RUN_TIMEOUT_MS) || 12 * 3600 * 1000);
const CONTINUE_MSG = 'Your turn ended while the flow is still running and no gate is waiting. Nobody reads a terminal here: '
  + 'continue the pipeline from the current stage per the flow skill, and at a gate end your turn after writing the gate request.';
// The skill invocation for a run. `resume` continues the pipeline recorded in
// the project's state.json (/flow-resume) instead of starting a flow file.
function flowPrompt(flow, safeTask, gateMode, speedFlag, headless) {
  if (flow === 'resume') return `/flow-resume --gates=${gateMode}${speedFlag} --headless=${headless}`;
  if (flow === 'understand' && !safeTask) return `/understand --gates=${gateMode}${speedFlag} --headless=${headless}`;
  return `/flow ${flow} "${safeTask}" --gates=${gateMode}${speedFlag} --headless=${headless}`;
}
function stateBelongsToRun(st, r) {
  if (r.flow === 'resume') return !!(st && typeof st === 'object' && st.status);
  if (!st || typeof st !== 'object') return false;
  const norm = (s) => String(s || '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  const want = norm(r.task);
  if (!want) return String(st.flow || '') === r.flow;
  return [st.taskRaw, st.task].some((x) => norm(x).startsWith(want.slice(0, 40)));
}
function startRunAcp(project, { flow, task, gates, speed }) {
  const safeTask = String(task || '').replace(/"/g, "'").trim();
  const gateMode = ['auto', 'terminal', 'dashboard', 'ai'].includes(gates) ? gates : 'dashboard';
  const speedFlag = speedSuffix(speed);
  const prompt = flowPrompt(flow, safeTask, gateMode, speedFlag, 'acp');
  const thisRun = registerRun({
    proc: null, pid: null, flow, task: safeTask, gates: gateMode, mode: 'acp', project, sessionId: null,
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
    lines: [], cmd: `devin acp :: ${prompt}`,
  });
  const push = (text) => runPush(thisRun, text);
  push(`[runner:acp] ${thisRun.cmd}`);
  push(`[runner:acp] cwd: ${project}`);

  // Stream assembly: thought/message chunks arrive fragmented, so we hold a
  // partial line and flush it when the stream kind changes.
  let streamKind = null;
  let partial = '';
  const flush = () => { if (partial) { push(partial); partial = ''; } };
  const appendText = (txt) => {
    partial += txt;
    if (partial.includes('\n')) {
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const l of parts) push(l);
    }
  };
  const begin = (kind, prefix) => { if (streamKind !== kind) { flush(); partial = prefix; streamKind = kind; } };

  const handle = startAcp({
    cwd: project, prompt, keepAlive: true, timeoutMs: RUN_TIMEOUT_MS,
    onUpdate: (u) => {
      if (!u || typeof u !== 'object') return;
      if (u.authenticated) { flush(); streamKind = null; push(`[runner:acp] authenticated (${u.authenticated})`); return; }
      if (u.sessionCreated) { flush(); streamKind = null; thisRun.sessionId = u.sessionCreated; push(`[runner:acp] session ${u.sessionCreated}`); return; }
      if (u.permission) { flush(); streamKind = null; push(`[perm] auto-approved tool call ${u.toolCallId || ''}`.trim()); return; }
      if (u.stopReason) { flush(); streamKind = null; push(`[runner:acp] stop reason: ${u.stopReason}`); return; }
      if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) { begin('thought', '[thought] '); appendText(u.content.text); return; }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) { begin('msg', ''); appendText(u.content.text); return; }
      if (u.sessionUpdate === 'tool_call') { flush(); streamKind = null; push(`[tool] ${u.title || u.toolCallId}`); return; }
      if (u.sessionUpdate === 'tool_call_update') { flush(); streamKind = null; push(`[tool] ${u.toolCallId} -> ${u.status || ''}`); return; }
      if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) {
        flush(); streamKind = null;
        const mark = (s) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]');
        push('[plan] ' + u.entries.map((e) => `${mark(e.status)} ${e.content}`).join(' | ').slice(0, 400));
        return;
      }
      if (u.sessionUpdate === 'usage_update' && u._meta) {
        flush(); streamKind = null;
        push(`[usage] in=${u._meta['cognition.ai/inputTokens'] ?? '?'} out=${u._meta['cognition.ai/outputTokens'] ?? '?'}`);
        return;
      }
    },
  });
  thisRun.proc = handle.proc;
  thisRun.killAcp = handle.kill;
  thisRun.acp = handle;
  const finish = (code, msg) => {
    if (thisRun.exitCode !== null) return;
    flush();
    thisRun.exitCode = code;
    thisRun.endedAt = new Date().toISOString();
    thisRun.gateWait = null;
    push(`[runner] ${msg}`);
    handle.close();
    recordRun(thisRun);
  };
  // What to do when the agent stops talking: a gate means "wait for the
  // user", a finished flow means "done", anything else gets one nudge.
  const afterTurn = async (stopReason) => {
    flush();
    if (thisRun.exitCode !== null) return;
    if (stopReason && stopReason !== 'end_turn' && stopReason !== 'max_turn_requests') { finish(1, `stopped (${stopReason})`); return; }
    const st = await readJsonSafe(projectPaths(project).state);
    const mine = stateBelongsToRun(st, thisRun);
    if (mine && st.status === 'waiting_gate' && st.currentStage) {
      thisRun.gateWait = { stage: st.currentStage, since: new Date().toISOString() };
      await ensureGateRequest(project, st);
      push(`[gate] waiting for your decision on "${st.currentStage}" - the run resumes when you decide`);
      return;
    }
    if (mine && st.status === 'done') { finish(0, `finished (${stopReason || 'done'})`); return; }
    if (mine && (st.status === 'failed' || st.status === 'stopped')) { finish(1, `flow ${st.status}`); return; }
    if (!thisRun.nudged) {
      thisRun.nudged = true;
      push('[runner] the agent ended its turn with the flow unfinished - asking it to continue');
      handle.prompt(CONTINUE_MSG).then(afterTurn).catch((e) => finish(1, `acp error: ${e.message}`));
      return;
    }
    finish(1, 'the agent stopped without finishing the flow');
  };
  // Called by POST /api/command while this run waits at a gate.
  thisRun.decide = async (stage, decision, note) => {
    if (!thisRun.gateWait || thisRun.exitCode !== null) return false;
    thisRun.gateWait = null;
    thisRun.nudged = false;
    push(`[gate] ${decision}: ${stage}${note ? ` - ${note}` : ''}`);
    const text = `GATE_DECISION ${stage} ${decision}${note ? `\nNOTE: ${note}` : ''}\nContinue the pipeline from here per the flow skill (--headless=acp).`;
    handle.prompt(text).then(afterTurn).catch((e) => finish(1, `acp error: ${e.message}`));
    return true;
  };
  handle.promise
    .then(({ stopReason }) => afterTurn(stopReason))
    .catch((e) => finish(1, `acp error: ${e.message}`));
  return thisRun;
}

// The dashboard's gate box reads commands.json; when the orchestrator ended
// its turn at a gate without writing the request there, write it for it (the
// question comes from the flow file).
async function ensureGateRequest(project, st) {
  const file = projectPaths(project).commands;
  const cur = (await readJsonSafe(file)) || {};
  if (cur.gate && cur.gate.stage === st.currentStage) return;
  let q = '';
  let qAr = '';
  try {
    const flowDef = JSON.parse(await readTextSafe(path.join(FLOWS_DIR, `${st.flow}.json`)) || '{}');
    const stage = (flowDef.stages || []).find((s) => s.id === st.currentStage) || {};
    q = stage.gateQuestion || `Review ${stage.artifact || 'the result'} of "${stage.title || st.currentStage}" - continue?`;
    qAr = stage.gateQuestionAr || '';
  } catch { q = `Continue after "${st.currentStage}"?`; }
  await fs.writeFile(file, JSON.stringify({ gate: { stage: st.currentStage, question: q, questionAr: qAr, requestedAt: new Date().toISOString() }, response: null }, null, 2), 'utf8');
}

// One entry point for "start this flow in this project with whatever executor
// exists": ACP with the stored key, else the logged-in CLI. Returns null (and
// why) when nothing can run it - the queue keeps the item and retries.
async function launchRun(project, spec) {
  if (process.env.FF_NO_ACP !== '1' && (readStoredKey() || process.env.WINDSURF_API_KEY)) return { run: startRunAcp(project, spec) };
  const cli = await checkCli();
  if (cli.found && cli.authenticated) return { run: startRun(project, spec) };
  return { run: null, reason: 'no_executor' };
}

// ---------- queue + schedules ----------
// Tasks wait here until an executor is free; schedules drop tasks into the
// queue when due. Projects run in parallel (up to MAX_PARALLEL), one run per
// project at a time. Everything is persisted next to the other local state.
const JOBS = new JobStore({
  queueFile: process.env.FF_QUEUE_FILE || path.join(stateDir(__dirname), 'queue.local.json'),
  schedulesFile: process.env.FF_SCHEDULES_FILE || path.join(stateDir(__dirname), 'schedules.local.json'),
});
let jobsTicking = false;
async function tickJobs() {
  if (jobsTicking) return;
  jobsTicking = true;
  try {
    await JOBS.load();
    let dirty = JOBS.fireDue().length > 0;
    // Runs that ended since the last tick close their queue items.
    for (const q of JOBS.queue) {
      if (q.status !== 'running') continue;
      const r = RUNS.get(q.runId);
      if (!r) { JOBS.markEnded(q.id, -1, 'run record lost'); dirty = true; } else if (r.exitCode !== null) { JOBS.markEnded(q.id, r.exitCode); dirty = true; }
    }
    // Start what may start.
    for (;;) {
      const next = pickNext(JOBS.queue, { activeProjects: activeRuns().map((r) => r.project), activeCount: activeRuns().length, maxParallel: MAX_PARALLEL });
      if (!next) break;
      let exists = false;
      try { exists = (await fs.stat(next.project)).isDirectory(); } catch { exists = false; }
      if (!exists) { JOBS.markEnded(next.id, -1, 'project folder not found'); dirty = true; continue; }
      const { run: r, reason } = await launchRun(next.project, next);
      if (!r) { next.waitReason = reason; break; }
      JOBS.markStarted(next.id, r.id);
      dirty = true;
    }
    if (dirty) await JOBS.save();
  } catch { /* a bad tick never stops the next one */ } finally { jobsTicking = false; }
}
const JOB_TICK_MS = Math.max(500, Number(process.env.FF_JOB_TICK_MS) || 3000);
setInterval(tickJobs, JOB_TICK_MS).unref();

// A run summarised for the board: its progress comes from the project's own
// state.json, its cost from the live session counter.
async function runSummary(r) {
  const st = await readJsonSafe(projectPaths(r.project).state);
  const stages = st && Array.isArray(st.stages) ? st.stages : [];
  const usage = await runUsage(r).catch(() => null);
  return {
    id: r.id, project: r.project, flow: r.flow, task: r.task, gates: r.gates, mode: r.mode,
    startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, active: r.exitCode === null, sessionId: r.sessionId || null,
    state: st ? {
      status: st.status || null, currentStage: st.currentStage || null,
      done: stages.filter((s) => s.status === 'done').length, total: stages.length,
      stageTitle: (stages.find((s) => s.id === st.currentStage) || {}).title || null,
      gate: st.status === 'waiting_gate',
    } : null,
    usage,
  };
}

// ---------- live activity watcher ----------
// A recursive fs.watch on the active project feeding a ring buffer.
// High-churn workbench control files are filtered out; artifact writes are kept.

const ACTIVITY_MAX = 600;
const activity = [];
let watcher = null;
let watchedProject = null;

const IGNORE_SEGMENTS = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv', 'venv', 'target', 'obj'];
const IGNORE_FILES = ['state.json', 'commands.json', 'projects.local.json'];

function pushActivity(type, rel) {
  activity.push({ t: new Date().toISOString(), type, path: rel });
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
}

function armWatcher() {
  const project = activeProject();
  if (project === watchedProject) return;
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  watchedProject = project;
  activity.length = 0;
  if (!project) return;
  try {
    watcher = fssync.watch(project, { recursive: true }, (eventType, fname) => {
      if (!fname) return;
      const rel = String(fname).replace(/\//g, '\\');
      const segs = rel.toLowerCase().split('\\');
      if (segs.some((s) => IGNORE_SEGMENTS.includes(s))) return;
      if (IGNORE_FILES.includes(segs[segs.length - 1])) return;
      pushActivity(eventType, rel);
    });
    watcher.on('error', (e) => { pushActivity('watch-error', e.message); });
    pushActivity('watching', project);
  } catch (e) {
    pushActivity('watch-error', e.message);
  }
}

// ---------- small helpers ----------

async function readJsonSafe(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function readTextSafe(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}
async function listDirSafe(dir, filterExt) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (filterExt && !e.name.endsWith(filterExt)) continue;
      const st = await fs.stat(path.join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// Optional per-flow `providers` array, keyed by flow name. `null` means the flow
// carries no restriction (every provider may run it). Cached by file mtime so the
// ~1s /api/state poll never re-reads an unchanged flow file.
const flowProviderCache = new Map(); // file name -> { mtime, providers }
async function flowProvidersMap(files) {
  const out = {};
  for (const f of files) {
    const name = f.name.replace(/\.json$/, '');
    const hit = flowProviderCache.get(f.name);
    if (hit && hit.mtime === f.mtime) { out[name] = hit.providers; continue; }
    const flow = await readJsonSafe(path.join(FLOWS_DIR, f.name));
    const providers = flow && Array.isArray(flow.providers) ? flow.providers : null;
    flowProviderCache.set(f.name, { mtime: f.mtime, providers });
    out[name] = providers;
  }
  return out;
}

function git(project, args, maxBuffer = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: project, maxBuffer, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trimEnd());
    });
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireProject() {
  const p = activeProject();
  if (!p) throw httpError(400, 'no active project - add one in Settings');
  return p;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Parse the `model:` field from each agent profile's YAML frontmatter,
// so the UI can show which model runs each pipeline stage.
async function agentModels() {
  const out = {};
  try {
    for (const f of await fs.readdir(AGENTS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const src = await readTextSafe(path.join(AGENTS_DIR, f));
      const fm = src && src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const model = fm && fm[1].match(/^model:\s*(\S+)/m);
      out[f.replace(/\.md$/, '')] = model ? model[1] : 'default';
    }
  } catch { /* no agents dir */ }
  return out;
}

// Generic markdown-collection helpers shared by agents and skills editors.
function assetFile(kind, name) {
  if (!SAFE_NAME.test(name)) throw httpError(400, `bad ${kind} name`);
  if (kind === 'agent') return path.join(AGENTS_DIR, name.endsWith('.md') ? name : name + '.md');
  // Skills live in a directory per skill: skills/<name>/SKILL.md
  const dir = name.endsWith('.md') ? name.slice(0, -3) : name;
  return path.join(SKILLS_DIR, dir, 'SKILL.md');
}

// ---------- API handlers ----------

const handlers = {
  // Liveness probe: reports process health; requires no active project.
  'GET /api/health': async () => ({ ok: true, uptimeSec: Math.floor(process.uptime()) }),

  // Single poll endpoint: everything the UI needs in one request.
  'GET /api/state': async () => {
    armWatcher();
    const reg = loadRegistry();
    const project = activeProject();
    let state = null, gate = null, artifacts = [], settings = null, inboxPending = false, hasKnowledge = false;
    if (project) {
      const p = projectPaths(project);
      state = await readJsonSafe(p.state);
      const commands = await readJsonSafe(p.commands);
      gate = commands && commands.gate ? commands.gate : null;
      artifacts = await listDirSafe(p.artifacts);
      settings = (await readJsonSafe(p.settings)) || { gateMode: 'default' };
      const inbox = await readTextSafe(p.inbox);
      inboxPending = !!(inbox && inbox.trim());
      hasKnowledge = !!(await readJsonSafe(p.knowledge));
    }
    const flows = await listDirSafe(FLOWS_DIR, '.json');
    let daemon = { alive: false, status: null, aliveAt: null };
    let queuePending = null;
    if (project) {
      daemon = await daemonStatus(project);
      const q = await readJsonSafe(projectPaths(project).queue);
      queuePending = q && q.pending ? q.pending : null;
    }
    return {
      project,
      projects: reg.projects,
      workbench: WORKBENCH,
      state,
      gate,
      artifacts,
      settings,
      // Other projects' runs and the waiting line, so every tab can show them.
      board: {
        active: activeRuns().length, maxParallel: MAX_PARALLEL,
        here: !!activeRunOf(project),
        queued: JOBS.loaded ? JOBS.queue.filter((q) => q.status === 'queued').length : 0,
        gates: await Promise.all(activeRuns().filter((r) => !sameProject(r.project, project)).map(async (r) => {
          const st = await readJsonSafe(projectPaths(r.project).state);
          return st && st.status === 'waiting_gate' ? { project: r.project, stage: st.currentStage || null } : null;
        })).then((xs) => xs.filter(Boolean)),
      },
      flows: flows.map((f) => f.name.replace(/\.json$/, '')),
      flowProviders: await flowProvidersMap(flows),
      providers: await summarizeProviders(project),
      models: await agentModels(),
      daemon,
      queuePending,
      executors: {
        acp: !!(readStoredKey() || process.env.WINDSURF_API_KEY),
        daemon: daemon.alive,
      },
      inboxPending,
      hasKnowledge,
      now: new Date().toISOString(),
    };
  },

  // Live file-change feed. ?since=<ISO> returns only newer events.
  'GET /api/activity': async (_req, url) => {
    armWatcher();
    const since = url.searchParams.get('since');
    const sinceMs = since ? Date.parse(since) : 0;
    const events = sinceMs ? activity.filter((e) => Date.parse(e.t) > sinceMs) : activity.slice(-200);
    return { events, watching: watchedProject, now: new Date().toISOString() };
  },

  // Git working-tree summary for the active project.
  'GET /api/changes': async () => {
    const project = requireProject();
    const [branch, status, diffstat] = await Promise.all([
      git(project, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(project, ['status', '--short']),
      git(project, ['diff', '--stat']),
    ]);
    if (branch === null) return { git: false };
    return {
      git: true,
      branch,
      status: (status || '').split('\n').filter(Boolean).slice(0, 200),
      diffstat: (diffstat || '').split('\n').filter(Boolean).slice(-40),
    };
  },

  // Per-file unified diff (working tree vs HEAD).
  'GET /api/diff': async (_req, url) => {
    const project = requireProject();
    const file = url.searchParams.get('file') || '';
    if (!file || file.includes('..')) throw httpError(400, 'bad file');
    const diff = await git(project, ['diff', '--', file]);
    const untracked = diff === '' ? await git(project, ['diff', '--no-index', '--', os.devNull, file]) : null;
    return { file, diff: diff || untracked || '(no diff)' };
  },

  'GET /api/artifact': async (_req, url) => {
    const project = requireProject();
    const name = url.searchParams.get('name') || '';
    if (!SAFE_NAME.test(name)) throw httpError(400, 'bad artifact name');
    const content = await readTextSafe(path.join(projectPaths(project).artifacts, name));
    if (content === null) throw httpError(404, 'artifact not found');
    return { name, content };
  },

  // Export an artifact to a real file (PDF/Word/Excel/...). The format list and
  // the conversion itself come from the same library the CLI and /export use.
  'POST /api/export': async (req) => {
    const project = requireProject();
    const body = JSON.parse(await readBody(req));
    const name = String(body.name || '');
    const to = String(body.to || '').toLowerCase();
    if (!SAFE_NAME.test(name)) throw httpError(400, 'bad artifact name');
    if (!FORMAT_IDS.includes(to)) throw httpError(400, `bad format (${FORMAT_IDS.join(', ')})`);
    const source = path.join(projectPaths(project).artifacts, name);
    if (!fssync.existsSync(source)) throw httpError(404, 'artifact not found');
    const outDir = path.join(projectPaths(project).wb, 'exports');
    const out = path.join(outDir, name.replace(/\.[^.]+$/, '') + extensionFor(to));
    try {
      const res = await convertDoc({ input: source, to, out, quiet: true });
      const size = fssync.statSync(res.out).size;
      return { ok: true, out: res.out, dir: outDir, format: to, method: res.method, size };
    } catch (err) {
      throw httpError(500, err.message);
    }
  },

  'GET /api/formats': async () => ({
    formats: FORMAT_IDS.map((id) => ({ id, ext: FORMATS[id].ext, label: FORMATS[id].label })),
  }),

  'GET /api/flow': async (_req, url) => {
    const name = url.searchParams.get('name') || '';
    if (!SAFE_NAME.test(name)) throw httpError(400, 'bad flow name');
    const content = await readTextSafe(path.join(FLOWS_DIR, name.endsWith('.json') ? name : name + '.json'));
    if (content === null) throw httpError(404, 'flow not found');
    return { name, content };
  },

  'POST /api/flow': async (req) => {
    const { name, content } = JSON.parse(await readBody(req));
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) throw httpError(400, 'bad flow name');
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    try { JSON.parse(content); } catch (e) { throw httpError(400, 'invalid JSON: ' + e.message); }
    const file = path.join(FLOWS_DIR, name.endsWith('.json') ? name : name + '.json');
    await fs.writeFile(file, content, 'utf8');
    return { ok: true, file };
  },

  'DELETE /api/flow': async (_req, url) => {
    const name = (url.searchParams.get('name') || '').replace(/\.json$/, '');
    if (!SAFE_NAME.test(name)) throw httpError(400, 'bad flow name');
    if (name === 'task' || name === 'understand') throw httpError(400, 'built-in flows cannot be deleted');
    try { await fs.unlink(path.join(FLOWS_DIR, name + '.json')); } catch { throw httpError(404, 'flow not found'); }
    return { ok: true };
  },

  'GET /api/agents': async () => {
    const files = await listDirSafe(AGENTS_DIR, '.md');
    return { agents: files.map((f) => f.name) };
  },

  'GET /api/agent': async (_req, url) => {
    const content = await readTextSafe(assetFile('agent', url.searchParams.get('name') || ''));
    if (content === null) throw httpError(404, 'agent not found');
    return { name: url.searchParams.get('name'), content };
  },

  'POST /api/agent': async (req) => {
    const { name, content } = JSON.parse(await readBody(req));
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const file = assetFile('agent', String(name || ''));
    await fs.writeFile(file, content, 'utf8');
    return { ok: true, file };
  },

  // The six pipeline roles are referenced by the built-in flows, so they are
  // not deletable from the UI; custom roles are.
  'DELETE /api/agent': async (_req, url) => {
    const name = (url.searchParams.get('name') || '').replace(/\.md$/, '');
    const core = ['thinker', 'analyst', 'coder', 'tester', 'debugger', 'shipper'];
    if (core.includes(name)) throw httpError(400, 'core roles cannot be deleted');
    const file = assetFile('agent', name);
    if (!fssync.existsSync(file)) throw httpError(404, 'agent not found');
    await fs.rm(file);
    return { ok: true };
  },

  'GET /api/skills': async () => {
    try {
      const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (e.isDirectory() && fssync.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'))) out.push(e.name);
      }
      return { skills: out.sort() };
    } catch { return { skills: [] }; }
  },

  'GET /api/skill': async (_req, url) => {
    const content = await readTextSafe(assetFile('skill', url.searchParams.get('name') || ''));
    if (content === null) throw httpError(404, 'skill not found');
    return { name: url.searchParams.get('name'), content };
  },

  'POST /api/skill': async (req) => {
    const { name, content } = JSON.parse(await readBody(req));
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const file = assetFile('skill', String(name || ''));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return { ok: true, file };
  },

  'POST /api/inbox': async (req) => {
    const project = requireProject();
    const { text } = JSON.parse(await readBody(req));
    if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'empty note');
    const p = projectPaths(project);
    await fs.mkdir(p.wb, { recursive: true });
    const stamp = new Date().toISOString();
    await fs.appendFile(p.inbox, `\n- [${stamp}] ${text.trim()}\n`, 'utf8');
    return { ok: true };
  },

  'POST /api/command': async (req) => {
    const project = requireProject();
    const { stage, decision, note } = JSON.parse(await readBody(req));
    if (typeof stage !== 'string' || !stage) throw httpError(400, 'missing stage');
    if (decision !== 'approve' && decision !== 'reject') throw httpError(400, 'decision must be approve|reject');
    const cmdFile = projectPaths(project).commands;
    const current = (await readJsonSafe(cmdFile)) || {};
    if (!current.gate || current.gate.stage !== stage) throw httpError(409, 'no pending gate for that stage');
    const cleanNote = typeof note === 'string' ? note.trim() : '';
    // An ACP run parked at this gate gets the decision as its next message
    // and the request is cleared; otherwise gate-wait.mjs reads the response.
    const r = activeRunOf(project);
    if (r && r.gateWait && r.gateWait.stage === stage && r.decide) {
      await fs.writeFile(cmdFile, JSON.stringify({ gate: null, response: null }, null, 2), 'utf8');
      await r.decide(stage, decision, cleanNote);
      return { ok: true, via: 'acp' };
    }
    current.response = { stage, decision, note: cleanNote, at: new Date().toISOString() };
    await fs.writeFile(cmdFile, JSON.stringify(current, null, 2), 'utf8');
    return { ok: true, via: 'file' };
  },

  'GET /api/settings': async () => {
    const project = requireProject();
    const settings = (await readJsonSafe(projectPaths(project).settings)) || {};
    // The API key never leaves the server; the UI only learns whether one is set.
    const { refineApiKey, ...rest } = settings;
    return {
      settings: {
        gateMode: 'default', refineProvider: 'auto', executorProvider: DEFAULT_PROVIDER,
        ...rest, refineApiKeySet: !!refineApiKey,
      },
    };
  },

  // Rewrites the user's rough line into a precise task statement. Provider
  // order for 'auto': Devin ACP -> Devin CLI -> configured HTTP model ->
  // offline template, so it works with no key and no configuration at all.
  'POST /api/refine': async (req) => {
    const project = requireProject();
    const { text, flow, mode } = JSON.parse(await readBody(req));
    const raw = String(text || '').trim();
    if (!raw) throw httpError(400, 'text required');
    if (mode !== undefined && !REFINE_MODES.includes(mode)) {
      throw httpError(400, `mode must be one of: ${REFINE_MODES.join(', ')}`);
    }
    const job = mode || 'generate';
    if (refining) throw httpError(409, 'a refine request is already running');
    const flowName = SAFE_NAME.test(String(flow || '')) ? flow : 'task';
    const cfg = (await readJsonSafe(projectPaths(project).settings)) || {};
    const provider = REFINE_PROVIDERS.includes(cfg.refineProvider) ? cfg.refineProvider : 'auto';
    const instruction = REFINER_INSTRUCTION(raw, flowName, job);
    const tried = [];
    refining = true;
    try {
      // 'cli' is deliberately NOT in the automatic chain: on this machine
      // `devin -p` can pop the interactive login instead of answering.
      const attempts = provider === 'auto'
        ? ['acp', ...PRINT_PROVIDERS.map((id) => `prov:${id}`), 'http', 'local']
        : PRINT_PROVIDERS.includes(provider) ? [`prov:${provider}`, 'local'] : [provider, 'local'];
      for (const via of attempts) {
        try {
          if (via.startsWith('prov:')) {
            const pid = via.slice(5);
            const prompt = await refineViaProviderCli(pid, project, instruction);
            if (prompt) return { ok: true, prompt, via: `${pid}-cli`, mode: job, tried };
            tried.push(`${pid}:unavailable`);
          } else if (via === 'acp') {
            if (process.env.FF_NO_ACP === '1' || !(readStoredKey() || process.env.WINDSURF_API_KEY)) { tried.push('acp:no-key'); continue; }
            // ACP is deliberately NOT gated on `auth status`: the stored key is
            // a different credential from the browser session, and ACP can be
            // the one path that works while `auth status` rejects. The client
            // itself can never draw a login UI (interactiveAuth=false + the
            // login-marker kill), so a dead key just fails through to 'local'.
            const prompt = await refineViaAcp(project, instruction);
            if (prompt) return { ok: true, prompt, via: 'devin-acp', mode: job, tried };
            tried.push('acp:empty');
          } else if (via === 'cli') {
            const cli = await checkCli();
            if (!cli.found || !cli.authenticated) { tried.push('cli:unavailable'); continue; }
            const prompt = await refineViaCli(project, instruction);
            if (prompt) return { ok: true, prompt, via: 'devin-cli', mode: job, tried };
            tried.push('cli:empty');
          } else if (via === 'http') {
            if (!cfg.refineApiBase) { tried.push('http:not-configured'); continue; }
            const prompt = await refineViaHttp(cfg, instruction);
            if (prompt) return { ok: true, prompt, via: `http:${cfg.refineModel || 'default'}`, mode: job, tried };
            tried.push('http:empty');
          } else {
            return { ok: true, prompt: refineLocally(raw, flowName, project, job), via: 'offline', mode: job, tried };
          }
        } catch (e) {
          tried.push(`${via}:${e.message.slice(0, 80)}`);
        }
      }
      return { ok: true, prompt: refineLocally(raw, flowName, project, job), via: 'offline', mode: job, tried };
    } finally {
      refining = false;
    }
  },

  'POST /api/settings': async (req) => {
    const project = requireProject();
    const patch = JSON.parse(await readBody(req));
    if (patch.gateMode !== undefined && !GATE_MODES.includes(patch.gateMode)) {
      throw httpError(400, `gateMode must be one of: ${GATE_MODES.join(', ')}`);
    }
    if (patch.refineProvider !== undefined && !REFINE_PROVIDERS.includes(patch.refineProvider)) {
      throw httpError(400, `refineProvider must be one of: ${REFINE_PROVIDERS.join(', ')}`);
    }
    if (patch.executorProvider !== undefined && !PROVIDER_IDS.includes(patch.executorProvider)) {
      throw httpError(400, `executorProvider must be one of: ${PROVIDER_IDS.join(', ')}`);
    }
    const p = projectPaths(project);
    await fs.mkdir(p.wb, { recursive: true });
    const current = (await readJsonSafe(p.settings)) || {};
    const next = { ...current, ...patch };
    await fs.writeFile(p.settings, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, settings: next };
  },

  'GET /api/projects': async () => {
    const reg = loadRegistry();
    return { active: reg.active, projects: reg.projects };
  },

  // ---------- headless runner API ----------
  // Execution paths, tried in order:
  //   1. ACP mode (preferred) - `devin acp` with the stored enterprise key;
  //      works even when the interactive CLI login is rejected server-side.
  //   2. CLI mode - `devin -p` headless (only when auth status confirms login).
  //   3. Queue mode - a /flow-daemon session is listening.
  'POST /api/run': async (req) => {
    const body = JSON.parse(await readBody(req));
    const { flow, task, gates, speed, permissionMode, provider, enqueue } = body;
    const project = body.project ? path.resolve(String(body.project)) : requireProject();
    if (typeof flow !== 'string' || !SAFE_NAME.test(flow)) throw httpError(400, 'bad flow name');
    if (flow !== 'understand' && flow !== 'resume' && (typeof task !== 'string' || !task.trim())) throw httpError(400, 'task required');
    // Resume needs something to resume: an interrupted state in this project.
    if (flow === 'resume') {
      const st = await readJsonSafe(projectPaths(project).state);
      if (!st || !st.status || st.status === 'done') throw httpError(409, 'nothing_to_resume');
    }
    // Only Devin has an executor; the other providers are selectable for flow and
    // model filtering only. Reject BEFORE any ACP/CLI/queue branch so a mislabeled
    // provider can never start a real Devin run.
    if (provider !== undefined && provider !== null && provider !== DEFAULT_PROVIDER) {
      throw httpError(409, 'provider_not_runnable');
    }
    // This project is busy: refuse as before, or (enqueue) line the task up.
    if (activeRunOf(project)) {
      if (!enqueue) throw httpError(409, 'a run is already active - stop it first');
      await JOBS.load();
      const item = JOBS.enqueue({ project, flow, task, gates, speed: SPEEDS.includes(speed) ? speed : '' });
      await JOBS.save();
      return { ok: true, mode: 'queue', id: item.id, position: JOBS.queue.filter((q) => q.status === 'queued').length };
    }
    if (activeRuns().length >= MAX_PARALLEL) {
      await JOBS.load();
      const item = JOBS.enqueue({ project, flow, task, gates, speed: SPEEDS.includes(speed) ? speed : '' });
      await JOBS.save();
      return { ok: true, mode: 'queue', id: item.id, position: JOBS.queue.filter((q) => q.status === 'queued').length };
    }
    if (process.env.FF_NO_ACP !== '1' && (readStoredKey() || process.env.WINDSURF_API_KEY)) {
      const r = startRunAcp(project, { flow, task, gates, speed });
      return { ok: true, mode: 'acp', id: r.id, pid: r.pid, cmd: r.cmd, startedAt: r.startedAt };
    }
    const cli = await checkCli();
    if (cli.found && cli.authenticated) {
      const r = startRun(project, { flow, task, gates, speed, permissionMode });
      return { ok: true, mode: 'cli', id: r.id, pid: r.pid, cmd: r.cmd, startedAt: r.startedAt };
    }
    const daemon = await daemonStatus(project);
    if (!daemon.alive) throw httpError(409, 'no_executor');
    const q = (await readJsonSafe(projectPaths(project).queue)) || {};
    if (q.pending) throw httpError(409, 'a queued run is already waiting for the daemon');
    const pending = {
      id: Date.now().toString(36),
      flow, task: String(task || '').trim(), gates: gates || 'dashboard',
      speed: SPEEDS.includes(speed) ? speed : 'flow',
      requestedAt: new Date().toISOString(),
    };
    await fs.writeFile(projectPaths(project).queue, JSON.stringify({ pending, stop: false }, null, 2), 'utf8');
    return { ok: true, mode: 'queue', id: pending.id };
  },

  // Ask a listening daemon session to shut down.
  'POST /api/daemon/stop': async () => {
    const project = requireProject();
    const q = (await readJsonSafe(projectPaths(project).queue)) || {};
    await fs.writeFile(projectPaths(project).queue, JSON.stringify({ ...q, stop: true }, null, 2), 'utf8');
    return { ok: true };
  },

  'GET /api/cli': async (_req, url) => {
    return await checkCli(url.searchParams.get('force') === '1');
  },

  // ?provider= keeps the endpoint response-compatible: absent or 'devin' is
  // exactly today's `devin models list` path (CLI + 5-minute cache + fallback),
  // the other providers answer from the static registry catalogue.
  'GET /api/models': async (_req, url) => {
    const id = url.searchParams.get('provider');
    if (!id || id === DEFAULT_PROVIDER) return await listModels(url.searchParams.get('force') === '1');
    if (!PROVIDER_IDS.includes(id)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    return { families: providerModels(id), source: 'registry' };
  },

  // Switching executor must not leave a flow pinned to models the new tool does
  // not have. The mapping rule lives in the registry (derived from the
  // catalogues), so the dashboard just asks for it and applies it to whatever
  // it currently has on the canvas.
  'POST /api/retarget-models': async (req) => {
    const { provider, models } = JSON.parse(await readBody(req));
    if (!PROVIDER_IDS.includes(provider)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    if (!Array.isArray(models)) throw httpError(400, 'models must be an array');
    const list = models.filter((m) => typeof m === 'string');
    const cat = await providerCatalogue(provider);
    if (!cat.trusted) {
      return { provider, map: Object.fromEntries(list.map((m) => [m, m])), changed: [], catalogue: 'unavailable' };
    }
    const { map, changed } = mapModelsToProvider(list, provider, cat.families);
    return { provider, map, changed };
  },

  // Retarget EVERY flow file at once. Two deliberate safety rules:
  //   * `apply` defaults to false - the dashboard shows the diff first;
  //   * applying writes a per-provider COPY (`<flow>-<provider>.json`, restricted
  //     with `providers:[id]`) instead of rewriting the original, because only
  //     Devin executes flows: rewriting task.json with Trae model ids would leave
  //     the user with a pipeline no runnable executor can run. A flow that is
  //     already this provider's copy is updated in place.
  'POST /api/retarget-flows': async (req) => {
    const { provider, apply } = JSON.parse(await readBody(req));
    if (!PROVIDER_IDS.includes(provider)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    // Devin's real catalogue lives in its CLI; without it every id would look
    // unsupported and a bulk apply would rewrite perfectly good flows.
    const cat = await providerCatalogue(provider);
    if (!cat.trusted) return { provider, applied: false, flows: [], totalChanges: 0, catalogue: 'unavailable' };
    const files = await listDirSafe(FLOWS_DIR, '.json');
    const out = [];
    for (const f of files) {
      const name = f.name.replace(/\.json$/, '');
      const flow = await readJsonSafe(path.join(FLOWS_DIR, f.name));
      if (!flow || !Array.isArray(flow.stages)) continue;
      const own = Array.isArray(flow.providers) && flow.providers.length === 1 && flow.providers[0] === provider;
      // Skip other providers' dedicated copies - they are not ours to rewrite.
      if (Array.isArray(flow.providers) && !flow.providers.includes(provider)) continue;
      const { map } = mapModelsToProvider(flow.stages.map((s) => s.model).filter(Boolean), provider, cat.families);
      const changes = [];
      for (const stage of flow.stages) {
        const to = stage.model ? map[stage.model] : '';
        if (!stage.model || to === stage.model) continue;
        changes.push({ stage: stage.id, from: stage.model, to });
        if (apply) { stage.model = to; delete stage.effort; }
      }
      const target = own || provider === DEFAULT_PROVIDER ? name : `${name}-${provider}`;
      out.push({ name, target, changes, inPlace: target === name });
      if (apply && changes.length) {
        if (target !== name) flow.providers = [provider];
        flow.name = target;
        await fs.writeFile(path.join(FLOWS_DIR, `${target}.json`), `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
      }
    }
    return {
      provider,
      applied: !!apply,
      flows: out,
      totalChanges: out.reduce((n, f) => n + f.changes.length, 0),
    };
  },

  // ---------- executor providers ----------

  'GET /api/providers': async () => {
    const project = activeProject();
    const settings = project ? await readJsonSafe(projectPaths(project).settings) : null;
    const selected = settings && PROVIDER_IDS.includes(settings.executorProvider)
      ? settings.executorProvider : DEFAULT_PROVIDER;
    return { providers: await summarizeProviders(project), selected };
  },

  // Per-provider detection plus the flow that would be built from what was found.
  // A provider that is not installed answers 200 with installed:false, never 500.
  'GET /api/provider': async (_req, url) => {
    const project = requireProject();
    const id = url.searchParams.get('id') || '';
    if (!PROVIDER_IDS.includes(id)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    const detection = await detectProvider(id, project);
    return { provider: id, detection, flow: buildFlowFromModules(id, detection) };
  },

  // Login status for one provider. `kind:'cli'` means a real CLI owns the
  // credentials and we can read/start a login; `kind:'none'` means the sign-in
  // lives inside the editor UI and the card says so instead of faking a button.
  'GET /api/provider-auth': async (_req, url) => {
    const id = url.searchParams.get('id') || '';
    if (!PROVIDER_IDS.includes(id)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    const project = activeProject();
    const detection = await detectProvider(id, project);
    const auth = await checkProviderAuth(id, detection, url.searchParams.get('force') === '1');
    return { provider: id, installed: detection.installed, auth };
  },

  // Same contract as the Devin login below, for any provider whose CLI owns the
  // credentials: open a real terminal on ITS login command. We never handle the
  // user's password or token - the provider's CLI does the whole dance.
  'POST /api/provider/login': async (req) => {
    const { id, alt } = JSON.parse(await readBody(req));
    if (!PROVIDER_IDS.includes(id)) throw httpError(400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    const project = activeProject();
    const detection = await detectProvider(id, project);
    // Editors keep the session inside the app: the honest "login" is to open the
    // editor on its own sign-in screen. Launch the CLI shim when there is one
    // (it starts the editor), else the editor binary itself.
    if (providerAuthKind(id) === 'app') {
      const target = detection.cliPath || detection.editorPath;
      const open = target ? openAppCommand(target) : null;
      if (!open) throw httpError(409, 'app_not_found');
      spawn(open.cmd, open.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, opened: true, path: target };
    }
    const script = providerLoginScript(id, detection.cliPath);
    if (!script) {
      throw httpError(409, detection.cliPath ? 'login_not_supported' : 'cli_not_found');
    }
    const already = await checkProviderAuth(id, detection, true);
    if (already.loggedIn) return { ok: true, already: true, account: already.account };
    const useAlt = !!(alt && script.alt);
    const file = await writeLoginScript(`flowforge-${id}-login`, useAlt ? script.alt.lines : script.lines);
    const term = terminalCommand({ file, title: useAlt ? script.alt.title : script.title });
    // No terminal emulator on this machine: say so and hand back the command,
    // rather than reporting a window that never opened.
    if (!term) return { ok: false, noTerminal: true, script: file };
    spawn(term.cmd, term.args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    invalidateProviderAuth(id);
    if (id === DEFAULT_PROVIDER) cliInfo = null;
    return { ok: true, already: false };
  },

  // Opens a visible terminal window on the user's machine running the
  // one-time interactive login (browser OAuth) - the dashboard cannot do
  // the OAuth dance itself. A temp script file sidesteps the shell quoting
  // pitfalls with spaces in the CLI path.
  'POST /api/cli/login': async () => {
    const cli = await checkCli(true);
    if (!cli.found) throw httpError(409, 'devin CLI not found');
    if (cli.authenticated) return { ok: true, already: true };
    const title = 'Devin CLI Login';
    const lines = loginScriptLines({
      title,
      note: 'IMPORTANT: choose option 1 "Log in with browser" (press 1 then Enter).',
      cliPath: DEVIN_CLI,
      steps: [['auth', 'login'], ['auth', 'status']],
    });
    const file = await writeLoginScript('flowforge-devin-login', lines);
    const term = terminalCommand({ file, title });
    if (!term) return { ok: false, noTerminal: true, script: file };
    spawn(term.cmd, term.args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    cliInfo = null;
    return { ok: true, already: false };
  },

  // The console of one run: by id, else the active project's latest run.
  'GET /api/run': async (_req, url) => {
    const id = url.searchParams.get('id');
    const r = id ? RUNS.get(id) : latestRunOf(activeProject());
    if (!r) return { exists: false };
    const since = Number(url.searchParams.get('since') || 0);
    return {
      exists: true, id: r.id, project: r.project, mode: r.mode,
      active: r.exitCode === null,
      flow: r.flow, task: r.task, gates: r.gates, cmd: r.cmd,
      startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode,
      lines: r.lines.slice(since),
      next: r.lines.length,
      usage: await runUsage(r).catch(() => null),
    };
  },

  // Everything in flight and waiting, across all projects.
  'GET /api/runs/board': async () => {
    await JOBS.load();
    const active = await Promise.all(activeRuns().map(runSummary));
    const recent = await Promise.all(allRuns().filter((r) => r.exitCode !== null).slice(-10).reverse().map(runSummary));
    return {
      maxParallel: MAX_PARALLEL, active, recent,
      queue: JOBS.queue.filter((q) => q.status === 'queued' || q.status === 'running'),
      history: JOBS.queue.filter((q) => q.status !== 'queued' && q.status !== 'running').slice(-30).reverse(),
      schedules: JOBS.schedules.map((s) => ({ ...s, nextAtIso: typeof s.nextAt === 'number' ? new Date(s.nextAt).toISOString() : null })),
      executor: (process.env.FF_NO_ACP !== '1' && (readStoredKey() || process.env.WINDSURF_API_KEY)) ? 'acp' : (cliInfo && cliInfo.authenticated ? 'cli' : null),
    };
  },

  // Add tasks to the queue: one spec, or `items` (several tasks at once). A
  // task can name a project other than the active one.
  'POST /api/queue': async (req) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const items = Array.isArray(body.items) ? body.items : [body];
    await JOBS.load();
    const added = [];
    for (const it of items) {
      const project = it.project ? path.resolve(String(it.project)) : requireProject();
      const flow = String(it.flow || '');
      if (!SAFE_NAME.test(flow)) throw httpError(400, 'bad flow name');
      if (flow !== 'understand' && !String(it.task || '').trim()) throw httpError(400, 'task required');
      added.push(JOBS.enqueue({
        project, flow, task: it.task, gates: ['auto', 'terminal', 'dashboard', 'ai'].includes(it.gates) ? it.gates : 'dashboard',
        speed: SPEEDS.includes(it.speed) ? it.speed : '',
      }));
    }
    await JOBS.save();
    setTimeout(tickJobs, 10);
    return { ok: true, added };
  },
  'DELETE /api/queue': async (_req, url) => {
    await JOBS.load();
    const id = url.searchParams.get('id') || '';
    if (!JOBS.cancel(id)) throw httpError(404, 'not a waiting item');
    await JOBS.save();
    return { ok: true };
  },
  'POST /api/queue/reorder': async (req) => {
    const { id, before } = JSON.parse(await readBody(req) || '{}');
    await JOBS.load();
    if (!JOBS.reorder(String(id || ''), before ? String(before) : null)) throw httpError(404, 'not a waiting item');
    await JOBS.save();
    return { ok: true };
  },

  'POST /api/schedules': async (req) => {
    const it = JSON.parse(await readBody(req) || '{}');
    await JOBS.load();
    if (it.id) {
      const s = JOBS.updateSchedule(String(it.id), {
        ...(it.enabled !== undefined ? { enabled: !!it.enabled } : {}),
        ...(it.repeat ? { repeat: it.repeat } : {}),
        ...(it.task !== undefined ? { task: String(it.task) } : {}),
      });
      if (!s) throw httpError(404, 'no such schedule');
      await JOBS.save();
      return { ok: true, schedule: s };
    }
    const project = it.project ? path.resolve(String(it.project)) : requireProject();
    const flow = String(it.flow || '');
    if (!SAFE_NAME.test(flow)) throw httpError(400, 'bad flow name');
    if (flow !== 'understand' && !String(it.task || '').trim()) throw httpError(400, 'task required');
    if (nextRunAt(it.repeat) === null) throw httpError(400, 'repeat never fires - check the time or the days');
    const s = JOBS.addSchedule({
      project, flow, task: it.task, repeat: it.repeat,
      gates: ['auto', 'terminal', 'dashboard', 'ai'].includes(it.gates) ? it.gates : 'auto',
      speed: SPEEDS.includes(it.speed) ? it.speed : '',
    });
    await JOBS.save();
    return { ok: true, schedule: s };
  },
  'DELETE /api/schedules': async (_req, url) => {
    await JOBS.load();
    if (!JOBS.removeSchedule(url.searchParams.get('id') || '')) throw httpError(404, 'no such schedule');
    await JOBS.save();
    return { ok: true };
  },
  // "Run now": the schedule's task joins the queue immediately.
  'POST /api/schedules/run-now': async (req) => {
    const { id } = JSON.parse(await readBody(req) || '{}');
    await JOBS.load();
    const s = JOBS.schedules.find((x) => x.id === id);
    if (!s) throw httpError(404, 'no such schedule');
    const item = JOBS.enqueue({ ...s, scheduleId: s.id });
    await JOBS.save();
    setTimeout(tickJobs, 10);
    return { ok: true, item };
  },

  // Real usage from Devin's session log: month totals, per day, per model,
  // per project, per flow, and every task. scope=flowforge keeps only flow
  // runs and prompt-generator calls; scope=all adds your other Devin sessions.
  'GET /api/usage': async (_req, url) => {
    const scope = url.searchParams.get('scope') === 'flowforge' ? 'flowforge' : 'all';
    const tool = String(url.searchParams.get('tool') || '').replace(/[^a-z-]/g, '');
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : '';
    const { log, sessions } = await usageSessions(url.searchParams.get('force') === '1');
    const dollars = await dollarsFor(sessions);
    // A contract rate from the browser overrides the measured list rate.
    const rate = Number(url.searchParams.get('rate')) > 0 ? Number(url.searchParams.get('rate')) : dollars.usdPerAcu;
    const other = await otherToolSessions(month || new Date().toISOString().slice(0, 7));
    return {
      available: log.available, message: log.message || null, source: log.file || null,
      dollars,
      tracking: await trackingStatus(other.status),
      ...aggregateUsage([...sessions, ...other.sessions], { month, scope, tool, usdPerAcu: rate }),
    };
  },

  // The last runs started from this dashboard, each with what it really cost
  // (its Devin session, linked by id or by start time and project).
  'GET /api/runs': async (_req, url) => {
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get('n')) || 20));
    const runs = (await readRunsLog()).slice(-n).reverse();
    if (!runs.length) return { runs: [] };
    const { sessions } = await usageSessions();
    const dollars = await dollarsFor(sessions);
    const rate = Number(url.searchParams.get('rate')) > 0 ? Number(url.searchParams.get('rate')) : dollars.usdPerAcu;
    const byStart = new Map(sessions.filter((s) => s.run).map((s) => [s.run.startedAt, s]));
    return {
      runs: runs.map((r) => {
        const s = byStart.get(r.startedAt);
        return {
          ...r,
          durationSec: r.endedAt ? Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) : null,
          acu: s ? s.acu : null, usd: s ? s.acu * rate : null, tokens: s ? totalTokens(s) : null, turns: s ? s.turns : null,
          sessionId: s ? s.id : r.sessionId || null,
        };
      }),
    };
  },

  'GET /api/usage/tracking': async () => {
    const other = await otherToolSessions(new Date().toISOString().slice(0, 7));
    return { tracking: await trackingStatus(other.status), logDir: usageLogDir() };
  },

  // Switch a tool's usage recorder on or off. Every action is one the user
  // clicked; nothing here runs on its own.
  //   cursor  - add/remove FlowForge's `stop` hook in ~/.cursor/hooks.json
  //   aider   - set/clear AIDER_ANALYTICS_LOG
  //   copilot - set/clear the Copilot CLI OpenTelemetry file export, and
  //             read GitHub's premium-request billing report through gh
  //   copilot-grant - open a terminal on `gh auth refresh -s user`
  'POST /api/usage/tracking': async (req) => {
    const { tool, on } = JSON.parse(await readBody(req) || '{}');
    const run = (cmd, args) => execFileSync(cmd, args, { windowsHide: true, stdio: 'ignore' });
    if (tool === 'cursor') {
      try {
        return { ok: true, ...setCursorHook(!!on, { hookScript: path.join(WORKBENCH, 'scripts', 'usage-hook.mjs') }) };
      } catch (e) { throw httpError(409, e.message); }
    }
    if (tool === 'aider') return { ok: true, ...setTrackedEnv('aider', !!on, { run }) };
    if (tool === 'copilot') {
      const res = setTrackedEnv('copilot', !!on, { run });
      setTrackingFlag('copilotBilling', !!on);
      if (on) refreshCopilotBilling({ cacheFile: billingCacheFile(), month: new Date().toISOString().slice(0, 7) }).catch(() => {});
      return { ok: true, ...res, billing: !!on };
    }
    if (tool === 'copilot-grant') {
      const gh = resolveGh();
      if (!gh) throw httpError(409, 'GitHub CLI (gh) is not installed');
      const file = await writeLoginScript('flowforge-gh-billing', loginScriptLines({
        title: 'GitHub billing access', note: 'Grants the gh login read access to your Copilot billing report.',
        cliPath: gh, steps: [['auth', 'refresh', '-h', 'github.com', '-s', 'user'], ['auth', 'status']],
      }));
      const term = terminalCommand({ file, title: 'GitHub billing access' });
      if (!term) return { ok: false, noTerminal: true, script: file };
      spawn(term.cmd, term.args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true };
    }
    throw httpError(400, 'tool must be cursor, aider, copilot or copilot-grant');
  },

  // The monthly report as Markdown; with a project open it is also saved as an
  // artifact and, for any other format, converted by the same library /export
  // uses - so a PDF/Word/Excel report is one click.
  'POST /api/usage/report': async (req) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const scope = body.scope === 'flowforge' ? 'flowforge' : 'all';
    const to = String(body.to || 'md').toLowerCase();
    if (to !== 'md' && !FORMAT_IDS.includes(to)) throw httpError(400, `bad format (md, ${FORMAT_IDS.join(', ')})`);
    const { sessions } = await usageSessions();
    // Dollars always appear: at the contract rate the user set, otherwise at
    // the list-price rate measured against Devin's official price list.
    const dollars = await dollarsFor(sessions);
    const usdPerAcu = Number(body.usdPerAcu) > 0 ? Number(body.usdPerAcu) : dollars.usdPerAcu;
    const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : '';
    const other = await otherToolSessions(month || new Date().toISOString().slice(0, 7));
    const tool = String(body.tool || '').replace(/[^a-z-]/g, '');
    const agg = aggregateUsage([...sessions, ...other.sessions], { month, scope, tool, usdPerAcu });
    const markdown = usageReportMarkdown(agg, {
      usdPerAcu, lang: body.lang === 'ar' ? 'ar' : 'en',
      usdBasis: Number(body.usdPerAcu) > 0 ? 'contract' : dollars.basis, verified: dollars.verified, priced: dollars.priced,
    });
    const project = activeProject();
    if (!project) return { ok: true, month: agg.month, markdown, saved: null };
    const name = `usage-report-${agg.month}.md`;
    const source = path.join(projectPaths(project).artifacts, name);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, markdown, 'utf8');
    if (to === 'md') return { ok: true, month: agg.month, markdown, saved: source, name };
    const out = path.join(projectPaths(project).wb, 'exports', name.replace(/\.md$/, '') + extensionFor(to));
    try {
      const res = await convertDoc({ input: source, to, out, quiet: true });
      return { ok: true, month: agg.month, markdown, saved: source, name, out: res.out, format: to };
    } catch (err) {
      throw httpError(500, err.message);
    }
  },

  // What a run will cost before it starts: the typed task in tokens, what every
  // run of the flow sends besides it, each stage's model at the rate measured
  // on this account, and the forecast from past runs of the same flow.
  // `flowDef` inline (the canvas, unsaved) wins over the saved flow file, so the
  // price of a model change shows before it is saved.
  'POST /api/estimate': async (req) => {
    const { flow, task, speed, flowDef: inline } = JSON.parse(await readBody(req) || '{}');
    const name = SAFE_NAME.test(String(flow || '')) ? String(flow) : 'task';
    let flowDef = {};
    if (inline && typeof inline === 'object' && Array.isArray(inline.stages)) flowDef = inline;
    else { try { flowDef = JSON.parse(await readTextSafe(path.join(FLOWS_DIR, `${name}.json`)) || '{}'); } catch { flowDef = {}; } }
    const stages = Array.isArray(flowDef.stages) ? flowDef.stages : [];
    const skill = await readTextSafe(path.join(SKILLS_DIR, name === 'understand' ? 'understand' : 'flow', 'SKILL.md'));
    const parts = [{ name: 'skill', text: skill || '' }];
    for (const agent of [...new Set(stages.map((s) => s.agent).filter((a) => a && SAFE_NAME.test(a)))]) {
      parts.push({ name: `agent:${agent}`, text: (await readTextSafe(path.join(AGENTS_DIR, `${agent}.md`))) || '' });
    }
    parts.push({ name: 'stage prompts', text: stages.map((s) => String(s.prompt || '').replace(/\{TASK\}/g, '')).join('\n') });
    const { log, sessions } = await usageSessions();
    const pl = await priceList();
    const est = estimateRun({
      flow: name, task: String(task || ''), flowDef, parts, sessions,
      stageCounts: await flowStageCounts(), agentModels: await agentModels(),
      speed: SPEEDS.includes(speed) ? speed : '', prices: pl ? pl.table : null,
    });
    est.dollars = { ...est.dollars, source: pl ? pl.source : null, fetchedAt: pl ? pl.fetchedAt : null };
    return { available: log.available, message: log.message || null, ...est };
  },

  'POST /api/run/stop': async (req) => {
    const { id } = JSON.parse((await readBody(req)) || '{}');
    const r = id ? RUNS.get(id) : activeRunOf(activeProject());
    if (!r || r.exitCode !== null) throw httpError(409, 'no active run');
    stopRun(r);
    return { ok: true, id: r.id };
  },

  // Folder picker for the dashboard: with no path it lists the machine's
  // drives, otherwise the sub-directories of `path` plus hints about what the
  // folder looks like, so a project can be chosen by clicking instead of typing.
  'GET /api/browse': async (_req, url) => {
    const raw = (url.searchParams.get('path') || '').trim();
    const marks = (dir) => ({
      git: fssync.existsSync(path.join(dir, '.git')),
      workbench: fssync.existsSync(path.join(dir, '.workbench')),
      pkg: fssync.existsSync(path.join(dir, 'package.json')),
    });
    if (!raw) {
      // Windows has a forest of drive roots; POSIX has the single `/`.
      const drives = [];
      if (process.platform === 'win32') {
        for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
          const root = `${String.fromCharCode(c)}:\\`;
          try { if (fssync.existsSync(root)) drives.push(root); } catch {}
        }
      } else {
        drives.push(path.parse(process.cwd()).root); // always '/'
        const extras = process.platform === 'darwin'
          ? ['/Applications', '/Users', '/opt']
          : ['/opt', '/srv', '/mnt', '/media', '/home'];
        for (const extra of extras) {
          try { if (fssync.existsSync(extra)) drives.push(extra); } catch {}
        }
      }
      const home = os.homedir();
      const shortcuts = [home, path.join(home, 'Desktop'), path.join(home, 'Documents')]
        .filter((p) => fssync.existsSync(p));
      return { roots: true, path: null, parent: null, drives, shortcuts, entries: [] };
    }
    const dir = path.resolve(raw);
    if (!fssync.existsSync(dir) || !fssync.statSync(dir).isDirectory()) throw httpError(404, 'directory not found');
    let entries = [];
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, path: path.join(dir, e.name), ...marks(path.join(dir, e.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      throw httpError(403, 'cannot read directory: ' + e.code);
    }
    const parent = path.dirname(dir);
    return { roots: false, path: dir, parent: parent === dir ? null : parent, self: marks(dir), entries };
  },

  'POST /api/projects': async (req) => {
    const { action, path: projPath } = JSON.parse(await readBody(req));
    const reg = loadRegistry();
    // Windows/macOS paths compare case-insensitively, Linux does not - the
    // platform layer knows which filesystem this is.
    const eq = (a, b) => samePath(a, b);
    if (action === 'add') {
      if (typeof projPath !== 'string' || !projPath.trim()) throw httpError(400, 'missing path');
      const p = path.resolve(projPath.trim());
      if (!fssync.existsSync(p) || !fssync.statSync(p).isDirectory()) throw httpError(400, 'directory not found: ' + p);
      if (!reg.projects.some((x) => eq(x, p))) reg.projects.push(p);
      reg.active = p;
    } else if (action === 'activate') {
      const match = reg.projects.find((x) => eq(x, projPath));
      if (!match) throw httpError(404, 'project not in registry');
      reg.active = match;
    } else if (action === 'remove') {
      reg.projects = reg.projects.filter((x) => !eq(x, projPath));
      if (reg.active && eq(reg.active, projPath)) reg.active = reg.projects[0] || null;
    } else {
      throw httpError(400, 'action must be add|activate|remove');
    }
    await saveRegistry(reg);
    armWatcher();
    return { ok: true, active: reg.active, projects: reg.projects };
  },
};

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === 'GET /' || key === 'GET /index.html') {
      const html = await readTextSafe(UI_FILE);
      if (html === null) return send(res, 500, 'UI file missing', 'text/plain; charset=utf-8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (key === 'GET /studio' || key === 'GET /studio.html') {
      const html = await readTextSafe(STUDIO_FILE);
      if (html === null) return send(res, 500, 'UI file missing', 'text/plain; charset=utf-8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    const handler = handlers[key];
    if (!handler) return send(res, 404, { error: 'not found' });
    const result = await handler(req, url);
    return send(res, 200, result);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'internal error' });
  }
});

// A port already taken is a normal thing on a shared machine, not a crash: say
// what to do and exit with a distinct code the launcher recognises.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`  Another FlowForge may be running: http://127.0.0.1:${PORT}/`);
    console.error('  Or start this one elsewhere:  flowforge --port=4830');
    process.exit(3);
  }
  console.error(`server error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  armWatcher();
  console.log('FlowForge dashboard');
  console.log(`  workbench: ${WORKBENCH}`);
  console.log(`  active:    ${activeProject() || '(none - add a project from Settings)'}`);
  console.log(`  url:       http://127.0.0.1:${PORT}/`);
});
