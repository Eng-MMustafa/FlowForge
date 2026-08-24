// FlowForge executor-provider registry - zero dependencies (node builtins only).
//
// One descriptor per provider (Devin, GitHub Copilot, Cursor, Trae) is the single
// source of truth for: how to probe for the installed editor and its CLI, which
// files count as "modules" (rules, instructions, prompts, agents, MCP configs) in
// the user profile and in the project workspace, and which models that provider
// can be asked for. Adding a provider later means adding ONE entry to PROVIDERS -
// the same "one registry" shape scripts/lib/formats.mjs uses for export formats.
//
// Detection is filesystem-only and bounded: no editor and no CLI is ever spawned,
// the scan stops at MAX_DEPTH levels / MAX_MODULES entries, and every root comes
// from the environment (LOCALAPPDATA / APPDATA / USERPROFILE) or from the
// FF_PROVIDER_HOME_<ID> override, so no machine-specific path is ever baked into a
// tracked file. A provider whose editor is missing reports installed:false with an
// empty module list - never an error.
//
// buildFlowFromModules() emits ORDINARY flow JSON (the same shape as
// scripts/new-flow.mjs and Studio's buildFlow()), plus the optional top-level
// `providers` array the dashboard filters on. The orchestrator ignores that field.
import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { providerRoots, loginScriptLines, whichSync as whichOn } from '../scripts/lib/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH = path.resolve(__dirname, '..');

const MAX_DEPTH = 2;       // directory levels below a module folder
const MAX_MODULES = 200;   // hard cap per provider, so /api/state stays fast
const DETECT_TTL = 10000;  // ms - the UI polls state roughly every 1.5s
const WHICH_TTL = 60000;   // ms - PATH lookups are stable

// Static model catalogues for the editors that expose no `models list` command.
// Same {slug,label,aliases,variants} shape as `devin models list` output, so the
// inspector and the visual builders need no special case. Edit freely: this list
// is a convenience catalogue, not a contract with the vendor.
const DEVIN_MODELS = [
  { slug: 'opus', label: 'Opus', aliases: [], variants: [] },
  { slug: 'sonnet', label: 'Sonnet', aliases: [], variants: [] },
  { slug: 'swe', label: 'SWE', aliases: [], variants: [] },
];
const COPILOT_MODELS = [
  { slug: 'gpt-5', label: 'GPT-5', aliases: ['gpt5', 'gpt'], variants: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini' },
    { id: 'gpt-5', label: 'GPT-5' },
  ] },
  { slug: 'gpt-4.1', label: 'GPT-4.1', aliases: ['gpt41'], variants: [] },
  { slug: 'o4-mini', label: 'o4-mini', aliases: ['o4'], variants: [] },
  { slug: 'o3', label: 'o3', aliases: [], variants: [
    { id: 'o3-mini', label: 'o3-mini' },
    { id: 'o3', label: 'o3' },
  ] },
  { slug: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', aliases: ['sonnet', 'claude'], variants: [
    { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  ] },
  { slug: 'claude-opus-4.1', label: 'Claude Opus 4.1', aliases: ['opus'], variants: [] },
  { slug: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', aliases: ['gemini'], variants: [] },
  { slug: 'grok-code-fast-1', label: 'Grok Code Fast 1', aliases: ['grok'], variants: [] },
];
const CURSOR_MODELS = [
  { slug: 'auto', label: 'Auto (Cursor picks)', aliases: [], variants: [] },
  { slug: 'composer-1', label: 'Composer 1', aliases: ['composer'], variants: [] },
  { slug: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', aliases: ['sonnet', 'claude'], variants: [
    { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4.5-thinking', label: 'Claude Sonnet 4.5 Thinking' },
  ] },
  { slug: 'claude-opus-4.1', label: 'Claude Opus 4.1', aliases: ['opus'], variants: [] },
  { slug: 'gpt-5', label: 'GPT-5', aliases: ['gpt5', 'gpt'], variants: [
    { id: 'gpt-5-fast', label: 'GPT-5 Fast' },
    { id: 'gpt-5', label: 'GPT-5' },
  ] },
  { slug: 'o3', label: 'o3', aliases: [], variants: [] },
  { slug: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', aliases: ['gemini'], variants: [] },
  { slug: 'grok-4', label: 'Grok 4', aliases: ['grok'], variants: [] },
  { slug: 'deepseek-v3.1', label: 'DeepSeek V3.1', aliases: ['deepseek'], variants: [] },
];
const TRAE_MODELS = [
  { slug: 'auto', label: 'Auto (Trae picks)', aliases: [], variants: [] },
  { slug: 'claude-sonnet-4', label: 'Claude Sonnet 4', aliases: ['sonnet', 'claude'], variants: [
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
    { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  ] },
  { slug: 'gpt-5', label: 'GPT-5', aliases: ['gpt5', 'gpt'], variants: [
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-5', label: 'GPT-5' },
  ] },
  { slug: 'deepseek-v3.1', label: 'DeepSeek V3.1', aliases: ['deepseek'], variants: [
    { id: 'deepseek-r1', label: 'DeepSeek R1' },
    { id: 'deepseek-v3.1', label: 'DeepSeek V3.1' },
  ] },
  { slug: 'doubao-seed-code', label: 'Doubao Seed Code', aliases: ['doubao'], variants: [] },
  { slug: 'kimi-k2', label: 'Kimi K2', aliases: ['kimi'], variants: [] },
  { slug: 'qwen3-coder', label: 'Qwen3 Coder', aliases: ['qwen'], variants: [] },
  { slug: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', aliases: ['gemini'], variants: [] },
];

// Descriptor fields:
//   editor / cli : ordered probe list, first hit wins.
//                  { env } reads a path straight out of the environment,
//                  { base, rel } joins an environment root with path segments,
//                  { command } looks the name up on PATH (filesystem only),
//                  { name } is a bare fallback (reported, never verified).
//   userModules / workspaceModules : module specs.
//                  { kind, rel, type:'file'|'dir', exts?, junctionOf? }
//                  user specs additionally carry a `base` root; workspace specs
//                  are always relative to the active project.
//   auth         : how (and whether) a login can be driven from here.
//                  { kind:'cli', statusArgs, loginArgs, notLoggedIn, account?, title }
//                    -> the provider's own CLI owns the credentials; we only read
//                       its status and can open a terminal on its login command.
//                  { kind:'app', reason, reasonAr }
//                    -> sign-in happens inside the editor window. We cannot read
//                       that state (it lives in the OS keyring), but we CAN open
//                       the editor on the sign-in screen, which is the real and
//                       only login path - so the card offers exactly that.
//                  { kind:'none', reason, reasonAr } -> nothing to do at all.
//                  NOTE: this is the ONLY part of this module that spawns a
//                  process, and only from checkProviderAuth() - never from
//                  detectProvider(), which stays filesystem-only.
export const PROVIDERS = {
  devin: {
    id: 'devin',
    label: 'Devin',
    labelAr: 'ديفين',
    models: DEVIN_MODELS,
    runnable: true,
    editor: [
      { os: 'win32', base: 'local', rel: ['Programs', 'Devin'] },
      { os: 'darwin', base: 'files', rel: ['Devin.app'] },
      { os: 'linux', base: 'files', rel: ['devin'] },
    ],
    cli: [
      { env: 'DEVIN_CLI' },
      { os: 'win32', base: 'local', rel: ['Programs', 'Devin', 'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe'] },
      { os: 'darwin', base: 'files', rel: ['Devin.app', 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin'] },
      { command: 'devin' },
    ],
    // `devin auth status` prints "Logged in (via Devin)." and exits 0; when it is
    // not logged in the text carries the marker below.
    auth: {
      kind: 'cli',
      statusArgs: ['auth', 'status'],
      loginArgs: ['auth', 'login'],
      notLoggedIn: /not logged in|no credentials|please log ?in/i,
      title: 'Devin CLI Login',
      note: 'Choose option 1 "Log in with browser" (press 1 then Enter).',
    },
    userModules: [
      { kind: 'locator', base: 'appdata', rel: ['devin', 'flowforge.json'], type: 'file' },
      { kind: 'skill', base: 'appdata', rel: ['devin', 'skills'], type: 'dir', exts: ['.md'], junctionOf: 'skills' },
      { kind: 'agent', base: 'appdata', rel: ['devin', 'agents'], type: 'dir', exts: ['.md'], junctionOf: 'agents' },
    ],
    workspaceModules: [
      { kind: 'settings', rel: ['.workbench', 'settings.json'], type: 'file' },
      { kind: 'rule', rel: ['AGENTS.md'], type: 'file' },
    ],
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    labelAr: 'جيت‌هاب كوبايلوت',
    models: COPILOT_MODELS,
    runnable: false,
    // Copilot is an EXTENSION, so "installed" means the extension folder exists in
    // some VS Code-family editor (or the standalone `copilot` CLI does). A plain
    // VS Code install, or the GitHub CLI on its own, is NOT Copilot - counting
    // either of those reported "installed" on a machine that has no Copilot.
    editor: [
      { base: 'home', rel: ['.vscode', 'extensions'], match: 'github.copilot' },
      { base: 'home', rel: ['.vscode-insiders', 'extensions'], match: 'github.copilot' },
      { base: 'home', rel: ['.windsurf', 'extensions'], match: 'github.copilot' },
      { base: 'home', rel: ['.cursor', 'extensions'], match: 'github.copilot' },
    ],
    cli: [{ command: 'copilot' }, { command: 'github-copilot-cli' }],
    // The account itself lives in the GitHub CLI, which is a DIFFERENT binary from
    // the provider's own CLI - hence auth.cli. `gh auth status` prints
    // "Logged in to github.com account <name> (keyring)".
    auth: {
      kind: 'cli',
      cli: [
        { command: 'gh' },
        { os: 'win32', base: 'files', rel: ['GitHub CLI', 'gh.exe'] },
      ],
      statusArgs: ['auth', 'status'],
      loginArgs: ['auth', 'login'],
      notLoggedIn: /not logged in|no accounts|You are not logged into/i,
      account: /account\s+(\S+)/i,
      title: 'GitHub CLI Login',
      note: 'This signs in the GitHub account Copilot uses.',
    },
    userModules: [
      { kind: 'prompt', base: 'appdata', rel: ['Code', 'User', 'prompts'], type: 'dir', exts: ['.md'] },
    ],
    workspaceModules: [
      { kind: 'instruction', rel: ['.github', 'copilot-instructions.md'], type: 'file' },
      { kind: 'instruction', rel: ['.github', 'instructions'], type: 'dir', exts: ['.md'] },
      { kind: 'prompt', rel: ['.github', 'prompts'], type: 'dir', exts: ['.md'] },
      { kind: 'chatmode', rel: ['.github', 'chatmodes'], type: 'dir', exts: ['.md'] },
      { kind: 'mcp', rel: ['.vscode', 'mcp.json'], type: 'file' },
    ],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    labelAr: 'كيرسر',
    models: CURSOR_MODELS,
    runnable: false,
    editor: [
      { os: 'win32', base: 'local', rel: ['Programs', 'cursor', 'Cursor.exe'] },
      { os: 'darwin', base: 'files', rel: ['Cursor.app'] },
      { base: 'appdata', rel: ['Cursor', 'User', 'settings.json'] },
    ],
    cli: [{ command: 'cursor' }],
    auth: {
      kind: 'app',
      // Cursor keeps most of its auth in state.vscdb (SQLite), which we will not
      // parse without a dependency - so when storage.json carries nothing the
      // answer is "unknown", never a confident "logged out".
      session: {
        base: 'appdata',
        rel: ['Cursor', 'User', 'globalStorage', 'storage.json'],
        authKeys: ['cursorAuth/accessToken', 'cursorAuth/cachedEmail', 'cursorAuth/stripeMembershipType'],
        minLength: 8,
      },
      reason: 'Cursor signs in inside the app (Settings -> Account). Opening it here takes you straight there; the session itself is stored by Cursor, not by this dashboard.',
      reasonAr: 'كيرسر بيسجّل دخولك جوّا البرنامج نفسه (Settings ← Account). الزرار هنا بيفتحه ليك علطول، والجلسة بتتخزن عند كيرسر مش عند الشاشة دي.',
    },
    userModules: [
      { kind: 'rule', base: 'home', rel: ['.cursor', 'rules'], type: 'dir', exts: ['.mdc', '.md'] },
      { kind: 'mcp', base: 'home', rel: ['.cursor', 'mcp.json'], type: 'file' },
    ],
    workspaceModules: [
      { kind: 'rule', rel: ['.cursor', 'rules'], type: 'dir', exts: ['.mdc', '.md'] },
      { kind: 'rule', rel: ['.cursorrules'], type: 'file' },
      { kind: 'mcp', rel: ['.cursor', 'mcp.json'], type: 'file' },
      { kind: 'rule', rel: ['AGENTS.md'], type: 'file' },
    ],
  },
  trae: {
    id: 'trae',
    label: 'Trae',
    labelAr: 'تراي',
    models: TRAE_MODELS,
    runnable: false,
    editor: [
      { os: 'win32', base: 'local', rel: ['Programs', 'Trae', 'Trae.exe'] },
      { os: 'darwin', base: 'files', rel: ['Trae.app'] },
      { base: 'appdata', rel: ['Trae', 'User', 'settings.json'] },
    ],
    cli: [
      { os: 'win32', base: 'local', rel: ['Programs', 'Trae', 'bin', 'trae.cmd'] },
      { command: 'trae' },
    ],
    auth: {
      kind: 'app',
      // Trae (iCube internally) writes its session into plain JSON, so the real
      // state IS readable: the presence of a non-trivial iCubeAuthInfo entry means
      // signed in, and the entitlement blob names the plan. Values are never read
      // out of the file - only key presence and the plan label.
      session: {
        base: 'appdata',
        rel: ['Trae', 'User', 'globalStorage', 'storage.json'],
        authKeys: ['iCubeAuthInfo://icube.cloudide'],
        minLength: 64,
        planKey: 'iCubeEntitlementInfo://icube.cloudide',
        planField: 'identityStr',
      },
      reason: 'Trae signs in inside the app (profile icon -> sign in); `trae.cmd` is only a file opener, so the button below opens Trae itself instead of pretending to log you in.',
      reasonAr: 'تراي بيسجّل دخولك جوّا البرنامج (أيقونة البروفايل ← تسجيل الدخول)؛ وـ trae.cmd مجرّد فاتح ملفات، عشان كده الزرار بيفتحلك تراي نفسه بدل ما يدّعي إنه سجّلك.',
    },
    userModules: [
      { kind: 'settings', base: 'appdata', rel: ['Trae', 'User', 'settings.json'], type: 'file' },
      { kind: 'rule', base: 'appdata', rel: ['Trae', 'User', 'rules'], type: 'dir', exts: ['.md'] },
      { kind: 'agent', base: 'appdata', rel: ['Trae', 'User', 'agents'], type: 'dir', exts: ['.md', '.json'] },
    ],
    workspaceModules: [
      { kind: 'rule', rel: ['.trae', 'rules'], type: 'dir', exts: ['.md'] },
      { kind: 'agent', rel: ['.trae', 'agents'], type: 'dir', exts: ['.md', '.json'] },
      { kind: 'mcp', rel: ['.trae', 'mcp.json'], type: 'file' },
      { kind: 'rule', rel: ['AGENTS.md'], type: 'file' },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'devin';

// ---------- environment roots ----------

// Roots are read fresh on every call (never captured at module load) so a test
// that spawns a server with FF_PROVIDER_HOME_* actually gets the override.
// The per-platform mapping itself lives in scripts/lib/platform.mjs, which is
// why the descriptors above can use the same `appdata` + rel on all three.
function rootsFor(id) {
  const override = process.env['FF_PROVIDER_HOME_' + id.toUpperCase()];
  if (override) return { local: override, appdata: override, home: override, files: override };
  return providerRoots();
}

// `overridden` means FF_PROVIDER_HOME_<ID> is in force: the override is the whole
// world for that provider, so environment and PATH probes are deliberately skipped
// (otherwise a stray binary on PATH would defeat the override a test just set).
function resolveProbe(roots, probe, overridden) {
  // A probe may belong to one OS only (an .exe under Programs, an .app bundle);
  // on the others it simply does not apply.
  if (probe.os && probe.os !== process.platform) return '';
  if (probe.env) return overridden ? '' : (process.env[probe.env] || '');
  if (probe.command) return overridden ? '' : (whichSync(probe.command) || '');
  const root = roots[probe.base] || '';
  if (!root) return '';
  const dir = path.join(root, ...probe.rel);
  // `match` means "a child of this folder whose name starts with X" - editor
  // extensions live in version-stamped folders (github.copilot-1.2.3), so an
  // exact path can never find them.
  if (probe.match) {
    const prefix = probe.match.toLowerCase();
    try {
      const hit = fssync.readdirSync(dir).find((n) => n.toLowerCase().startsWith(prefix));
      return hit ? path.join(dir, hit) : '';
    } catch { return ''; }
  }
  return dir;
}

function probeLabel(probe) {
  if (probe.env) return `$${probe.env}`;
  if (probe.command) return `${probe.command} (PATH)`;
  const base = `%${probe.base}%/${probe.rel.join('/')}`;
  return probe.match ? `${base}/${probe.match}*` : base;
}

const whichCache = new Map(); // command -> { hit, at }

// Filesystem-only PATH lookup: the same three-tier idea as resolveDevinCli(),
// but nothing is ever executed just to learn whether it exists. The extension
// rules (PATHEXT on Windows, none elsewhere) live in the platform layer.
function whichSync(cmd) {
  const cached = whichCache.get(cmd);
  if (cached && Date.now() - cached.at < WHICH_TTL) return cached.hit;
  const hit = whichOn(cmd);
  whichCache.set(cmd, { hit, at: Date.now() });
  return hit;
}

function isFile(p) {
  try { return fssync.statSync(p).isFile(); } catch { return false; }
}
function exists(p) {
  try { fssync.statSync(p); return true; } catch { return false; }
}

// A junction is only useful while it still points at THIS clone - a moved or
// renamed folder leaves a link that resolves nowhere (same rule as start.mjs).
function junctionOk(link, targetName) {
  try {
    if (!fssync.existsSync(link)) return false;
    return fssync.realpathSync(link) === fssync.realpathSync(path.join(WORKBENCH, targetName));
  } catch { return false; }
}

// ---------- detection ----------

const detectCache = new Map(); // key -> { result, at }

async function collectDir(dir, spec, scope, out) {
  const walk = async (current, prefix, depth) => {
    if (out.length >= MAX_MODULES || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_MODULES) return;
      const full = path.join(current, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(full, rel, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (spec.exts && !spec.exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      out.push(await moduleEntry(spec.kind, rel, full, scope, spec.rel.join('/') + '/' + rel));
    }
  };
  await walk(dir, '', 1);
}

async function moduleEntry(kind, name, full, scope, label) {
  let size = 0, mtime = 0;
  try { const st = await fs.stat(full); size = st.size; mtime = st.mtimeMs; } catch { /* vanished */ }
  return { kind, name, path: full, label, scope, size, mtime };
}

async function collectSpecs(specs, rootOf, scope, modules, missing) {
  for (const spec of specs) {
    const root = rootOf(spec);
    if (!root) { missing.push({ label: spec.rel.join('/'), path: null, scope }); continue; }
    const target = path.join(root, ...spec.rel);
    if (spec.junctionOf && !junctionOk(target, spec.junctionOf)) {
      missing.push({ label: spec.rel.join('/'), path: target, scope });
      continue;
    }
    if (!exists(target)) { missing.push({ label: spec.rel.join('/'), path: target, scope }); continue; }
    if (spec.type === 'dir') await collectDir(target, spec, scope, modules);
    else if (modules.length < MAX_MODULES) {
      modules.push(await moduleEntry(spec.kind, path.basename(target), target, scope, spec.rel.join('/')));
    }
  }
}

// Probe one provider: editor, CLI, user modules, workspace modules.
// Never throws for a missing editor - that is reported as installed:false.
export async function detectProvider(id, project) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  const roots = rootsFor(id);
  const override = process.env['FF_PROVIDER_HOME_' + id.toUpperCase()] || '';
  const cacheKey = `${id}|${project || ''}|${override}`;
  const cached = detectCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETECT_TTL) return cached.result;

  const missing = [];
  let editorPath = null;
  for (const probe of provider.editor) {
    const p = resolveProbe(roots, probe, !!override);
    if (p && exists(p)) { editorPath = p; break; }
    missing.push({ label: probeLabel(probe), path: p || null, scope: 'editor' });
  }
  let cliPath = null;
  for (const probe of provider.cli) {
    const p = resolveProbe(roots, probe, !!override);
    if (p && exists(p)) { cliPath = p; break; }
    missing.push({ label: probeLabel(probe), path: p || null, scope: 'cli' });
  }

  const modules = [];
  await collectSpecs(provider.userModules, (s) => roots[s.base] || '', 'user', modules, missing);
  if (project) {
    await collectSpecs(provider.workspaceModules, () => project, 'workspace', modules, missing);
  }

  const result = {
    id,
    label: provider.label,
    labelAr: provider.labelAr,
    installed: !!(editorPath || cliPath),
    editorPath,
    cliPath,
    project: project || null,
    modules,
    missing,
    truncated: modules.length >= MAX_MODULES,
    checkedAt: new Date().toISOString(),
  };
  detectCache.set(cacheKey, { result, at: Date.now() });
  return result;
}

const summaryCache = new Map(); // project -> { list, at }

// Compact per-provider status for GET /api/state and GET /api/providers.
export async function summarizeProviders(project) {
  const key = project || '';
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < DETECT_TTL) return cached.list;
  const list = [];
  for (const id of PROVIDER_IDS) {
    const d = await detectProvider(id, project);
    list.push({
      id,
      label: d.label,
      labelAr: d.labelAr,
      installed: d.installed,
      runnable: !!PROVIDERS[id].runnable,
      editorPath: d.editorPath,
      cliPath: d.cliPath,
      moduleCount: d.modules.length,
      checkedAt: d.checkedAt,
    });
  }
  summaryCache.set(key, { list, at: Date.now() });
  return list;
}

// ---------- models ----------

export function providerModels(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  return provider.models;
}

// Every one of these takes an OPTIONAL catalogue: Devin's real model list comes
// from `devin models list` at runtime, and only the caller (the server) has it.
// Omitting it falls back to the static catalogue in this file.
export function providerModelIds(id, families = providerModels(id)) {
  const out = [];
  for (const f of families) {
    out.push(f.slug, ...(f.aliases || []), ...(f.variants || []).map((v) => v.id));
  }
  return out;
}

export function providerSupportsModel(id, model, families = providerModels(id)) {
  if (!model) return true; // empty = inherit the role default
  return providerModelIds(id, families).includes(model);
}

// First family is the provider's safest default ('auto' where the tool has one).
export function providerDefaultModel(id, families = providerModels(id)) {
  return families.length ? families[0].slug : '';
}

// Cross-provider model mapping, derived from the catalogues themselves so there
// is no second table to keep in sync: score each target family by how many
// tokens it shares with the source model id, and keep the thinking level word
// when the winning family has a variant carrying it.
const LEVEL_WORDS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'mini', 'fast', 'thinking'];
const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

export function mapModelToProvider(model, toId, families = providerModels(toId)) {
  if (!model) return '';
  if (providerSupportsModel(toId, model, families)) return model;
  const srcTokens = tokenize(model).filter((tk) => !/^\d+(\.\d+)?$/.test(tk));
  const level = srcTokens.filter((tk) => LEVEL_WORDS.includes(tk)).pop() || '';
  const nameTokens = srcTokens.filter((tk) => !LEVEL_WORDS.includes(tk));
  let best = null;
  let bestScore = 0;
  for (const f of families) {
    const famTokens = new Set([...tokenize(f.slug), ...tokenize(f.label), ...(f.aliases || []).flatMap(tokenize)]);
    const score = nameTokens.reduce((n, tk) => n + (famTokens.has(tk) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  if (!best) return providerDefaultModel(toId, families);
  if (level) {
    const variant = (best.variants || []).find((v) => tokenize(v.id).includes(level));
    if (variant) return variant.id;
  }
  return best.slug;
}

// Bulk form for the dashboard: { "<from>": "<to>" } plus what had to change.
export function mapModelsToProvider(models, toId, families = providerModels(toId)) {
  const map = {};
  const changed = [];
  for (const m of models) {
    if (!m || map[m] !== undefined) continue;
    const to = mapModelToProvider(m, toId, families);
    map[m] = to;
    if (to !== m) changed.push({ from: m, to });
  }
  return { map, changed };
}

// ---------- login status ----------
// The ONLY place this module runs a process. Everything is bounded: one short
// `<cli> auth status` per call, cached, output truncated. A provider whose
// sign-in lives inside its editor answers kind:'none' without spawning anything,
// and a provider whose CLI is missing answers cli:null - never an error.
const AUTH_TTL = 30000;
const AUTH_TIMEOUT = 12000;
const authCache = new Map(); // id -> { at, value }

// A .cmd/.bat launcher cannot be exec'd directly on Windows, so those go through
// cmd.exe. Never rejects: a crash is just a non-zero code plus its message.
function runCli(cliPath, args) {
  const batch = /\.(cmd|bat)$/i.test(cliPath);
  const file = batch ? process.env.ComSpec || 'cmd.exe' : cliPath;
  const argv = batch ? ['/c', cliPath, ...args] : args;
  return new Promise((resolve) => {
    execFile(file, argv, {
      timeout: AUTH_TIMEOUT, windowsHide: true, maxBuffer: 1 << 20,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      out: `${stdout || ''}${stderr || ''}` || (err ? err.message : ''),
    }));
  });
}

// Reads an editor's OWN session file. Deliberately minimal and privacy-safe: it
// answers "is a session key present" and (optionally) the plan label, and never
// returns, logs or forwards the value of any auth key. `known:false` means the
// state could not be read at all - which the UI must show as unknown, NOT as
// logged out.
function readAppSession(session, roots) {
  if (!session) return { known: false, file: null };
  const root = roots[session.base] || '';
  if (!root) return { known: false, file: null };
  const file = path.join(root, ...session.rel);
  if (!isFile(file)) return { known: false, file };
  let data;
  try { data = JSON.parse(fssync.readFileSync(file, 'utf8')); } catch { return { known: false, file }; }
  const min = session.minLength || 1;
  const loggedIn = (session.authKeys || []).some((key) => {
    const value = data[key];
    return typeof value === 'string' ? value.length >= min : !!value;
  });
  let plan = null;
  if (session.planKey && typeof data[session.planKey] === 'string') {
    try {
      const parsed = JSON.parse(data[session.planKey]);
      const label = parsed[session.planField || 'identityStr'];
      if (label) plan = String(label).slice(0, 40);
    } catch { /* a plan label is a nicety, never a failure */ }
  }
  return { known: true, file, loggedIn, plan };
}

// The credentials can live in a different binary than the provider's own CLI
// (Copilot's account belongs to `gh`), so auth.cli wins when it is declared.
// Status reading and the login terminal must agree, hence one resolver.
function authCliPath(id, auth, fallback) {
  const roots = rootsFor(id);
  const overridden = !!process.env['FF_PROVIDER_HOME_' + id.toUpperCase()];
  for (const probe of auth.cli || []) {
    const p = resolveProbe(roots, probe, overridden);
    if (p && isFile(p)) return p;
  }
  return fallback || null;
}

export function providerAuthKind(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  return (provider.auth && provider.auth.kind) || 'none';
}

// `where` is the detection result ({cliPath, editorPath, installed}); a bare
// string is still accepted and read as the CLI path.
export async function checkProviderAuth(id, where, force = false) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  const auth = provider.auth || { kind: 'none', reason: 'No login is defined for this provider.' };
  const hit = authCache.get(id);
  if (!force && hit && Date.now() - hit.at < AUTH_TTL) return hit.value;

  const detection = typeof where === 'string' || !where ? { cliPath: where || null } : where;
  const roots = rootsFor(id);
  const cliPath = authCliPath(id, auth, detection.cliPath);
  const installed = detection.installed !== undefined
    ? !!detection.installed : !!(detection.editorPath || detection.cliPath);

  const base = {
    provider: id, kind: auth.kind, canLogin: false, canOpen: false,
    loggedIn: false, known: false, account: null, cli: cliPath || null, detail: '',
    reason: auth.reason || '', reasonAr: auth.reasonAr || '',
  };
  let value = base;
  if (auth.kind === 'cli' && cliPath) {
    const { code, out } = await runCli(cliPath, auth.statusArgs || ['auth', 'status']);
    const text = out.trim();
    const denied = auth.notLoggedIn ? auth.notLoggedIn.test(text) : false;
    const account = auth.account ? (auth.account.exec(text) || [])[1] || null : null;
    value = {
      ...base,
      canLogin: true,
      known: true,
      // Exit 0 AND no explicit "not logged in" marker: CLIs report a missing
      // login on stdout as often as through the exit code, so demand both.
      loggedIn: code === 0 && !denied,
      account,
      detail: text.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ').slice(0, 300),
    };
  } else if (auth.kind === 'cli' && !cliPath) {
    value = { ...base, detail: 'CLI not found on this machine' };
  } else if (auth.kind === 'app') {
    // Some editors write their session into plain JSON we can read; the rest keep
    // it somewhere we will not parse, and then the honest answer is "unknown".
    // Either way the only real login is the editor's own window, so the button
    // opens it - but only when there IS an app to open.
    const sess = readAppSession(auth.session, roots);
    value = {
      ...base,
      canOpen: installed,
      known: sess.known,
      loggedIn: sess.known ? sess.loggedIn : false,
      account: sess.plan || null,
      detail: !installed ? 'Not installed on this machine'
        : sess.known ? `Session read from ${path.basename(sess.file)}`
          : 'Session state is not readable from disk',
    };
  }
  authCache.set(id, { at: Date.now(), value });
  return value;
}

export function invalidateProviderAuth(id) {
  if (id) authCache.delete(id); else authCache.clear();
}

// Lines for the temporary script the server opens in a visible terminal: the
// OAuth dance belongs to the provider's CLI, we only start it and show the
// verdict. The script flavour (.cmd vs /bin/sh) comes from the platform layer.
export function providerLoginScript(id, cliPath, plat = process.platform) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  const auth = provider.auth;
  if (!auth || auth.kind !== 'cli') return null;
  cliPath = authCliPath(id, auth, cliPath);
  if (!cliPath) return null;
  const title = auth.title || `${provider.label} login`;
  return {
    title,
    lines: loginScriptLines({
      title,
      note: auth.note,
      cliPath,
      steps: [auth.loginArgs || ['auth', 'login'], auth.statusArgs || ['auth', 'status']],
      plat,
    }),
  };
}

// ---------- flow filtering ----------

// A flow with no `providers` field is unrestricted (today's behaviour for every
// shipped flow); `providers: []` deliberately hides it from all of them.
export function flowSupportsProvider(flowJson, id) {
  const list = flowJson && flowJson.providers;
  if (!Array.isArray(list)) return true;
  return list.includes(id);
}

// ---------- flow builder ----------

// Deterministic mapping from detected modules to an ordinary flow:
//   * rules / instructions / settings / MCP configs become ONE context stage on
//     the analyst role, because they describe the project rather than a job;
//   * agents / chatmodes / prompts / skills become a stage on the role their
//     file name matches (thinker|analyst|coder|tester|debugger|shipper, else
//     analyst), and the stages are emitted in that role order;
//   * the first stage runs scripts/collect-context.mjs, every stage writes
//     <stage-id>.md, and only the last stage gates (default + bilingual question).
// Nothing detected -> a single-stage skeleton flagged `detected: false`.
const ROLE_ORDER = ['thinker', 'analyst', 'coder', 'tester', 'debugger', 'shipper'];
const ROLE_HINTS = {
  thinker: ['thinker', 'think', 'plan', 'architect'],
  analyst: ['analyst', 'analy', 'research', 'explain'],
  coder: ['coder', 'code', 'implement', 'develop', 'build'],
  tester: ['tester', 'test', 'review', 'qa'],
  debugger: ['debugger', 'debug', 'bug', 'fix'],
  shipper: ['shipper', 'ship', 'release', 'deploy', 'commit'],
};
const ROLE_STAGE = {
  thinker: { id: 'think', title: 'Think & plan', titleAr: 'التفكير والتخطيط' },
  analyst: { id: 'analyze', title: 'Analyze', titleAr: 'التحليل' },
  coder: { id: 'code', title: 'Implement', titleAr: 'كتابة الكود' },
  tester: { id: 'test', title: 'Test & review', titleAr: 'الاختبار والمراجعة' },
  debugger: { id: 'debug', title: 'Debug', titleAr: 'التصحيح' },
  shipper: { id: 'ship', title: 'Ship', titleAr: 'الرفع والتسليم' },
};
const CONTEXT_KINDS = ['rule', 'instruction', 'settings', 'mcp', 'locator'];
const ROLE_KINDS = ['agent', 'chatmode', 'prompt', 'skill'];

function roleOfModule(name) {
  const lower = String(name || '').toLowerCase();
  for (const role of ROLE_ORDER) {
    if (ROLE_HINTS[role].some((h) => lower.includes(h))) return role;
  }
  return 'analyst';
}

function moduleList(mods) {
  return mods.map((m) => `- ${m.label} (${m.kind}, ${m.scope})`).join('\n');
}

export function buildFlowFromModules(id, detection) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  const modules = (detection && Array.isArray(detection.modules)) ? detection.modules : [];
  const context = modules.filter((m) => CONTEXT_KINDS.includes(m.kind));
  const byRole = new Map();
  for (const m of modules) {
    if (!ROLE_KINDS.includes(m.kind)) continue;
    const role = roleOfModule(m.name);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(m);
  }

  const stages = [];
  if (context.length) {
    stages.push({
      id: 'modules',
      title: `${provider.label} project rules`,
      titleAr: `قواعد المشروع في ${provider.label}`,
      agent: 'analyst',
      prompt: `The ${provider.label} workspace carries these rule/configuration modules:\n${moduleList(context)}\n\n`
        + 'Read them in the project at {PROJECT}, summarise the constraints they impose on this task, '
        + 'and write .workbench/artifacts/modules.md. Task: {TASK}',
      pre: [], post: [], gate: 'auto', artifact: 'modules.md',
      done: ['modules.md exists and lists every rule module with the constraint it imposes'],
    });
  }
  for (const role of ROLE_ORDER) {
    const mods = byRole.get(role);
    if (!mods || !mods.length) continue;
    const meta = ROLE_STAGE[role];
    stages.push({
      id: meta.id,
      title: `${meta.title} (${provider.label})`,
      titleAr: `${meta.titleAr} (${provider.label})`,
      agent: role,
      prompt: `Detected ${provider.label} modules for this step:\n${moduleList(mods)}\n\n`
        + `Do the ${role} work for the project at {PROJECT} following those modules, `
        + `and write .workbench/artifacts/${meta.id}.md per your role contract. Task: {TASK}`,
      pre: [], post: [], gate: 'auto', artifact: `${meta.id}.md`,
      done: [`${meta.id}.md exists and cites every module it followed`],
    });
  }
  if (!stages.length) {
    stages.push({
      id: 'modules',
      title: `${provider.label} - no modules detected`,
      titleAr: `${provider.label} — لا توجد وحدات`,
      agent: 'analyst',
      prompt: `No ${provider.label} modules were detected for the project at {PROJECT}. `
        + 'Inspect the project, describe what a first set of provider modules should contain, '
        + 'and write .workbench/artifacts/modules.md. Task: {TASK}',
      pre: [], post: [], gate: 'auto', artifact: 'modules.md',
      done: ['modules.md exists and proposes the modules this provider still needs'],
    });
  }

  stages[0].pre = ['scripts/collect-context.mjs'];
  const last = stages[stages.length - 1];
  last.gate = 'default';
  last.gateQuestion = `Detected ${provider.label} modules were applied - continue?`;
  last.gateQuestionAr = `اتطبقت وحدات ${provider.label} اللي اتلقت — نكمل؟`;

  return {
    name: `${id}-detected`,
    title: `${provider.label} - detected modules`,
    titleAr: `${provider.label} — الوحدات المكتشفة`,
    description: `Flow generated from the ${provider.label} modules detected on this machine and in the active project.`,
    defaultGate: 'terminal',
    providers: [id],
    detected: modules.length > 0,
    stages,
  };
}
