// usage-sources.mjs - the usage of every AI tool besides Devin, read the way
// each tool officially exposes it. Zero dependencies.
//
// Local records, nothing to switch on:
//   Claude Code  ~/.claude/projects/**/*.jsonl            tokens per assistant message
//   Codex CLI    ~/.codex/(archived_)sessions/**/*.jsonl  token_count events
//   Gemini CLI   ~/.gemini/tmp/**/*.json(l)               tokens per model message
//   OpenCode     ~/.local/share/opencode                  tokens + OpenCode's own cost
//   Cline / Roo  <editor>/User/globalStorage/<ext>/tasks  tokens + cost per API request
//   Zed          <data>/Zed/threads/threads.db            token usage per request (zstd JSON)
//   Antigravity  ~/.gemini/antigravity*/conversations     token usage per call (protobuf)
// Switched on once, with consent - the tool only records while it is on:
//   Cursor       its official `stop` hook -> scripts/usage-hook.mjs -> cursor.jsonl
//   Aider        AIDER_ANALYTICS_LOG -> aider.jsonl (tokens + Aider's own cost)
//   Copilot CLI  COPILOT_OTEL_* file exporter -> copilot-otel.jsonl (tokens)
// Billed dollars from the vendor's official API:
//   GitHub Copilot  GET /users/{login}/settings/billing/premium_request/usage via `gh`
// No per-request usage exists anywhere for Windsurf, Kiro or Trae; the UI says so.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { dayKey, finalizeSession, withSqliteFile } from './usage.mjs';
import {
  toolRoots, usageLogDir, userEnvCommands, profileFiles, withProfileBlock, whichSync,
} from '../scripts/lib/platform.mjs';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const splitEnv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// A redirected home (tests) must never pick up the real machine's overrides.
const envFor = (env) => (env.FF_TOOL_HOME ? {} : env);

// Every file with one of `exts` under `dir`, bounded so a huge tree can't hang.
function walk(dir, exts, maxDepth = 6, out = [], depth = 0) {
  if (depth > maxDepth || out.length > 20000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, maxDepth, out, depth + 1);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// Parse results are kept per file and reused until the file changes.
const fileCache = new Map();
function cached(file, parse) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = parse(file);
  fileCache.set(file, { stamp, value });
  return value;
}
const lines = (file) => (readText(file) || '').split(/\r?\n/);

function call(ms, model, input, output, cacheRead = 0, cacheWrite = 0, usd, extra = {}) {
  return {
    ms, day: dayKey(ms), model: String(model || 'unknown'),
    input: Math.max(0, num(input)), output: Math.max(0, num(output)),
    cacheRead: Math.max(0, num(cacheRead)), cacheWrite: Math.max(0, num(cacheWrite)),
    acu: 0, usd, ...extra,
  };
}

// Sessions keyed by id, built call by call.
function collector(tool) {
  const map = new Map();
  return {
    add(id, meta, c) {
      if (!Number.isFinite(c.ms) || c.ms <= 0) return;
      let s = map.get(id);
      if (!s) {
        s = { id: `${tool}:${id}`, tool, project: '', model: '', title: '', kind: 'chat', flow: null, task: '', first: '', createdMs: 0, lastMs: 0, calls: [] };
        map.set(id, s);
      }
      if (meta.project && !s.project) s.project = meta.project;
      if (meta.title && !s.title) s.title = meta.title;
      if (c.model && c.model !== 'unknown') s.model = c.model;
      s.calls.push(c);
    },
    list() { return [...map.values()].map((s) => finalizeSession({ ...s, createdMs: 0 })); },
  };
}

// ---------- prices ----------
// Devin's official price list (already downloaded for the Devin rate) covers
// the frontier models at API list prices; LiteLLM's public table covers the
// long tail. Both are matched on a normalised model name.
export const LITELLM_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export function normModel(m) {
  let s = String(m || '').toLowerCase().trim();
  s = s.replace(/^.*\//, '').replace(/[@:].*$/, '').replace(/\./g, '-');
  s = s.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  // Cursor writes claude-4.6-opus, the price lists claude-opus-4-6.
  s = s.replace(/^claude-(\d+(?:-\d+)?)-(opus|sonnet|haiku)/, 'claude-$2-$1');
  return s;
}
const LEVEL = /-(thinking|high|low|medium|max|xhigh|minimal|none|fast|latest|preview|priority|1m)$/;
export function modelCandidates(m) {
  const out = [];
  let s = normModel(m);
  while (s && !out.includes(s)) {
    out.push(s);
    const next = s.replace(LEVEL, '');
    if (next === s) break;
    s = next;
  }
  return out;
}

export function parseLiteLLM(text) {
  const raw = parseJson(text);
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || typeof v.input_cost_per_token !== 'number') continue;
    const i = v.input_cost_per_token * 1e6;
    const row = [
      i, num(v.output_cost_per_token) * 1e6,
      typeof v.cache_creation_input_token_cost === 'number' ? v.cache_creation_input_token_cost * 1e6 : i,
      typeof v.cache_read_input_token_cost === 'number' ? v.cache_read_input_token_cost * 1e6 : i,
    ];
    const key = normModel(k);
    if (key && !out[key]) out[key] = row;
  }
  return Object.keys(out).length ? out : null;
}

const lite = { table: null, fetchedAt: null, source: null, loading: null };
export async function refreshLiteLLM({ cacheFile = null, maxAgeMs = 24 * 3600 * 1000, timeoutMs = 10000 } = {}) {
  const local = process.env.FF_LITELLM_PRICES;
  if (local) {
    Object.assign(lite, { table: parseLiteLLM(readText(local)), fetchedAt: new Date().toISOString(), source: local });
    return lite;
  }
  if (!lite.table && cacheFile) {
    const c = parseJson(readText(cacheFile) || 'null');
    if (c && c.models) Object.assign(lite, { table: c.models, fetchedAt: c.fetchedAt, source: c.source });
  }
  const age = lite.fetchedAt ? Date.now() - Date.parse(lite.fetchedAt) : Infinity;
  if (age < maxAgeMs || process.env.FF_NO_NETWORK === '1') return lite;
  if (lite.loading) return lite.loading;
  lite.loading = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(LITELLM_SOURCE, { signal: ctl.signal, headers: { 'User-Agent': 'FlowForge' } });
      clearTimeout(timer);
      const table = res.ok ? parseLiteLLM(await res.text()) : null;
      if (table) {
        Object.assign(lite, { table, fetchedAt: new Date().toISOString(), source: LITELLM_SOURCE });
        if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: lite.fetchedAt, source: LITELLM_SOURCE, models: table })); } catch { /* read-only */ } }
      }
    } catch { /* offline: keep the last good table */ }
    lite.loading = null;
    return lite;
  })();
  return lite.loading;
}
export const currentLiteLLM = () => lite;

// First match wins: Devin's list (exact vendor price), then LiteLLM.
export function makePricer(devinTable, liteTable) {
  const devin = new Map();
  for (const [uid, row] of Object.entries(devinTable || {})) {
    const p = row.enterprise || row.pro;
    if (p && !devin.has(normModel(uid))) devin.set(normModel(uid), p);
  }
  return (model) => {
    for (const c of modelCandidates(model)) {
      if (devin.has(c)) return { price: devin.get(c), source: 'devin' };
      if (liteTable && liteTable[c]) return { price: liteTable[c], source: 'litellm' };
    }
    return null;
  };
}
export const usdFor = (c, p) => (
  c.input * p[0] + c.output * p[1] + c.cacheWrite * (p[2] > 0 ? p[2] : p[0]) + c.cacheRead * (p[3] > 0 ? p[3] : p[0])
) / 1e6;

// Calls that brought no dollars of their own are priced from the tables;
// models no table knows stay at usd = null and are reported as unpriced.
export function priceSessions(sessions, pricer) {
  const unpriced = new Set();
  for (const s of sessions) {
    for (const c of s.calls) {
      if (typeof c.usd === 'number') continue;
      const hit = pricer ? pricer(c.model) : null;
      if (hit) { c.usd = usdFor(c, hit.price); c.priced = hit.source; } else { c.usd = null; unpriced.add(c.model); }
    }
    finalizeSession(s);
  }
  return [...unpriced];
}

// ---------- adapters ----------
function claudeCode(r, env) {
  const e = envFor(env);
  const dirs = (e.CLAUDE_CONFIG_DIR ? splitEnv(e.CLAUDE_CONFIG_DIR) : [path.join(r.xdgConfig, 'claude'), path.join(r.home, '.claude')])
    .map((d) => (path.basename(d) === 'projects' ? d : path.join(d, 'projects'))).filter(isDir);
  const col = collector('claude');
  const seen = new Set();
  const files = dirs.flatMap((d) => walk(d, ['.jsonl'], 3));
  for (const f of files) {
    const rows = cached(f, (file) => {
      const out = [];
      for (const line of lines(file)) {
        if (!line.includes('"usage"')) continue;
        const o = parseJson(line);
        const m = o && o.type === 'assistant' && o.message;
        if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
        out.push({
          key: `${m.id || ''}:${o.requestId || ''}`, sid: o.sessionId || path.basename(file, '.jsonl'), cwd: o.cwd || '',
          c: call(Date.parse(o.timestamp), m.model, m.usage.input_tokens, m.usage.output_tokens,
            m.usage.cache_read_input_tokens, m.usage.cache_creation_input_tokens,
            typeof o.costUSD === 'number' ? o.costUSD : undefined),
        });
      }
      return out;
    }) || [];
    for (const row of rows) {
      if (row.key !== ':' && seen.has(row.key)) continue;
      seen.add(row.key);
      col.add(row.sid, { project: row.cwd }, { ...row.c });
    }
  }
  return { sessions: col.list(), files: files.length };
}

function codex(r, env) {
  const e = envFor(env);
  const homes = e.CODEX_HOME ? splitEnv(e.CODEX_HOME) : [path.join(r.home, '.codex')];
  const files = homes.flatMap((h) => ['sessions', 'archived_sessions'].map((d) => path.join(h, d))).filter(isDir)
    .flatMap((d) => walk(d, ['.jsonl'], 5));
  const col = collector('codex');
  for (const f of files) {
    const parsed = cached(f, (file) => {
      let model = null;
      let cwd = '';
      let sid = path.basename(file, '.jsonl');
      let prev = null;
      const out = [];
      for (const line of lines(file)) {
        if (!line.trim()) continue;
        const o = parseJson(line);
        if (!o || !o.payload) continue;
        if (o.type === 'session_meta') { cwd = o.payload.cwd || cwd; sid = o.payload.id || sid; model = o.payload.model || model; continue; }
        if (o.type === 'turn_context') { model = o.payload.model || model; cwd = o.payload.cwd || cwd; continue; }
        if (o.type !== 'event_msg' || o.payload.type !== 'token_count' || !o.payload.info) continue;
        const { last_token_usage: last, total_token_usage: tot } = o.payload.info;
        // The same totals repeated mean no new model call happened.
        if (tot && prev && JSON.stringify(tot) === JSON.stringify(prev)) continue;
        let u = last;
        if (!u && tot) {
          u = Object.fromEntries(Object.keys(tot).map((k) => [k, num(tot[k]) - num(prev && prev[k])]));
        }
        if (tot) prev = tot;
        if (!u) continue;
        const cachedIn = Math.min(num(u.cached_input_tokens), num(u.input_tokens));
        out.push(call(Date.parse(o.timestamp), model || 'gpt-5', num(u.input_tokens) - cachedIn, u.output_tokens, cachedIn, 0));
      }
      return { sid, cwd, calls: out };
    });
    if (!parsed) continue;
    for (const c of parsed.calls) col.add(parsed.sid, { project: parsed.cwd }, { ...c });
  }
  return { sessions: col.list(), files: files.length };
}

function geminiTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const input = num(t.input ?? t.prompt ?? t.input_tokens ?? t.prompt_tokens);
  const cachedTok = num(t.cached ?? t.cached_tokens);
  const output = num(t.output ?? t.candidates ?? t.output_tokens) + num(t.thoughts ?? t.reasoning ?? t.thoughts_tokens);
  if (!input && !output && !cachedTok) return null;
  // Gemini counts cached tokens inside the prompt total.
  const overlap = Math.min(input, cachedTok);
  return { input: input - overlap, output, cacheRead: cachedTok };
}
function geminiCli(r, env) {
  const e = envFor(env);
  const roots = (e.GEMINI_DATA_DIR ? splitEnv(e.GEMINI_DATA_DIR) : [path.join(r.home, '.gemini', 'tmp')]).filter(isDir);
  const files = roots.flatMap((d) => walk(d, ['.json', '.jsonl'], 4));
  const col = collector('gemini');
  const seen = new Set();
  for (const f of files) {
    const rows = cached(f, (file) => {
      const out = [];
      const push = (m, sid, fallbackMs) => {
        const t = geminiTokens(m.tokens);
        if (!t) return;
        const ms = Date.parse(m.timestamp || m.created_at || '') || fallbackMs;
        out.push({ key: m.id ? `${sid}:${m.id}` : null, sid, c: call(ms, m.model || 'gemini', t.input, t.output, t.cacheRead, 0) });
      };
      if (file.endsWith('.jsonl')) {
        for (const line of lines(file)) {
          const o = parseJson(line);
          if (o && o.type === 'gemini') push(o, o.sessionId || path.basename(file, '.jsonl'), 0);
        }
      } else {
        const o = parseJson(readText(file));
        if (o && Array.isArray(o.messages)) {
          const sid = o.sessionId || path.basename(file, '.json');
          const start = Date.parse(o.startTime || o.lastUpdated || '') || 0;
          for (const m of o.messages) if (m && m.type === 'gemini') push(m, sid, start);
        }
      }
      return out;
    }) || [];
    for (const row of rows) {
      if (row.key && seen.has(row.key)) continue;
      if (row.key) seen.add(row.key);
      col.add(row.sid, {}, { ...row.c });
    }
  }
  return { sessions: col.list(), files: files.length };
}

function openCodeMessage(m, col, seen) {
  if (!m || !m.tokens || !m.modelID) return;
  if (m.id && seen.has(m.id)) return;
  if (m.id) seen.add(m.id);
  const t = m.tokens;
  const cache = t.cache || {};
  const ms = num(m.time && m.time.created) || 0;
  col.add(m.sessionID || 'opencode', { project: (m.path && (m.path.cwd || m.path.root)) || '' },
    call(ms, m.modelID, t.input, num(t.output) + num(t.reasoning), cache.read, cache.write,
      num(m.cost) > 0 ? num(m.cost) : undefined));
}
async function openCode(r, env) {
  const e = envFor(env);
  const roots = (e.OPENCODE_DATA_DIR ? splitEnv(e.OPENCODE_DATA_DIR) : [path.join(r.xdgData, 'opencode')]).filter(isDir);
  const col = collector('opencode');
  const seen = new Set();
  let files = 0;
  for (const root of roots) {
    const db = path.join(root, 'opencode.db');
    if (isFile(db)) {
      const res = await withSqliteFile(db, (d) => d.prepare('SELECT id, session_id, data FROM message').all());
      if (res.ok) {
        files += 1;
        for (const row of res.value) {
          const m = parseJson(String(row.data || ''));
          if (m) openCodeMessage({ id: row.id, sessionID: row.session_id, ...m }, col, seen);
        }
      }
    }
    const msgFiles = walk(path.join(root, 'storage', 'message'), ['.json'], 3);
    files += msgFiles.length;
    for (const f of msgFiles) openCodeMessage(cached(f, (file) => parseJson(readText(file))), col, seen);
  }
  return { sessions: col.list(), files };
}

// Cline, Roo Code and Kilo Code record every API request of a task in
// ui_messages.json, with the cost they computed themselves.
const CLINE_EXTENSIONS = { 'saoudrizwan.claude-dev': 'cline', 'rooveterinaryinc.roo-cline': 'roo', 'kilocode.kilo-code': 'kilo' };
const EDITOR_HOSTS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Trae', 'Kiro'];
function clineFamily(r) {
  const col = collector('cline');
  let files = 0;
  for (const host of EDITOR_HOSTS) {
    for (const [ext, label] of Object.entries(CLINE_EXTENSIONS)) {
      const tasks = path.join(r.appdata, host, 'User', 'globalStorage', ext, 'tasks');
      if (!isDir(tasks)) continue;
      let ids = [];
      try { ids = fs.readdirSync(tasks); } catch { ids = []; }
      for (const id of ids) {
        const f = path.join(tasks, id, 'ui_messages.json');
        if (!isFile(f)) continue;
        files += 1;
        const msgs = cached(f, (file) => parseJson(readText(file))) || [];
        if (!Array.isArray(msgs)) continue;
        const first = msgs.find((m) => m && m.say === 'task');
        for (const m of msgs) {
          if (!m || m.say !== 'api_req_started' || !m.text) continue;
          const info = parseJson(m.text);
          if (!info || (info.tokensIn == null && info.tokensOut == null)) continue;
          col.add(`${label}:${id}`, { title: first && first.text ? String(first.text).slice(0, 120) : `${label} task` },
            call(num(m.ts), info.model || label, info.tokensIn, info.tokensOut, info.cacheReads, info.cacheWrites,
              typeof info.cost === 'number' ? info.cost : undefined));
        }
      }
    }
  }
  return { sessions: col.list(), files };
}

function zedDbPath(r, plat) {
  if (plat === 'darwin') return path.join(r.appdata, 'Zed', 'threads', 'threads.db');
  if (plat === 'win32') return path.join(r.localData, 'Zed', 'threads', 'threads.db');
  return path.join(r.xdgData, 'zed', 'threads', 'threads.db');
}
async function zed(r, env, plat) {
  const file = zedDbPath(r, plat);
  if (!isFile(file)) return { sessions: [], files: 0 };
  const res = await withSqliteFile(file, (d) => {
    try { return d.prepare('SELECT id, summary, updated_at, data_type, data, folder_paths FROM threads').all(); } catch {
      return d.prepare('SELECT id, summary, updated_at, data_type, data FROM threads').all();
    }
  });
  if (!res.ok) return { sessions: [], files: 1, note: res.reason };
  const col = collector('zed');
  let undecodable = 0;
  for (const row of res.value) {
    let json = null;
    try {
      const buf = Buffer.from(row.data);
      if (row.data_type === 'zstd') {
        if (typeof zlib.zstdDecompressSync !== 'function') { undecodable += 1; continue; }
        json = parseJson(zlib.zstdDecompressSync(buf).toString('utf8'));
      } else json = parseJson(buf.toString('utf8'));
    } catch { json = null; }
    if (!json) continue;
    const ms = Date.parse(json.updated_at || row.updated_at || '') || 0;
    const model = (json.model && (json.model.model || json.model.name)) || 'zed';
    const usages = Object.values(json.request_token_usage || {});
    const list = usages.length ? usages : (json.cumulative_token_usage ? [json.cumulative_token_usage] : []);
    const project = String(row.folder_paths || '').split(/\r?\n/).filter(Boolean)[0] || '';
    for (const u of list) {
      col.add(row.id, { title: row.summary || json.title || '', project },
        call(ms, model, u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens));
    }
  }
  return {
    sessions: col.list(), files: 1,
    note: undecodable ? `${undecodable} threads need Node 22.15+ (zstd) to be read` : null,
  };
}

// ---- Antigravity: the protobuf field numbers ccusage recovered from the
// FileDescriptorProto blobs shipped inside the `agy` binary.
function* pbFields(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      v += (b & 0x7f) * 2 ** (7 * i);
      if (!(b & 0x80)) return v;
    }
    return null;
  };
  while (pos < buf.length) {
    const tag = varint();
    if (tag === null) return;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field) return;
    if (wire === 0) { const v = varint(); if (v === null) return; yield [field, v]; } else if (wire === 2) {
      const len = varint();
      if (len === null || pos + len > buf.length) return;
      yield [field, buf.subarray(pos, pos + len)];
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else return;
  }
}
const pbText = (b) => { const s = Buffer.isBuffer(b) || b instanceof Uint8Array ? Buffer.from(b).toString('utf8').trim() : ''; return s || null; };
function pbTimestamp(b) {
  let s = null;
  let n = 0;
  for (const [f, v] of pbFields(b)) { if (f === 1 && typeof v === 'number') s = v; if (f === 2 && typeof v === 'number' && v < 1e9) n = v; }
  return s && s > 0 ? s * 1000 + Math.floor(n / 1e6) : null;
}
function pbUsage(b) {
  const u = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0, response: 0, id: null };
  const ids = {};
  for (const [f, v] of pbFields(b)) {
    if (typeof v === 'number') {
      if (f === 2) u.input = v;
      else if (f === 3) u.output = v;
      else if (f === 4) u.cacheWrite = v;
      else if (f === 5) u.cacheRead = v;
      else if (f === 9) u.thinking = v;
      else if (f === 10) u.response = v;
    } else if (f === 11 || f === 12 || f === 7) ids[f] = pbText(v);
  }
  // response_id, then provider_assigned_message_id, then message_id.
  u.id = ids[11] || ids[12] || ids[7] || null;
  if (!u.output) u.output = u.thinking + u.response;
  return u;
}
const pbRetryUsage = (b) => { for (const [f, v] of pbFields(b)) if (f === 2 && typeof v !== 'number') return pbUsage(v); return null; };
export function antigravityStep(b) {
  let ts = null;
  let started = null;
  const usages = [];
  for (const [f, v] of pbFields(b)) {
    if (typeof v === 'number') continue;
    if (f === 1) ts = pbTimestamp(v);
    else if (f === 32) started = pbTimestamp(v);
    else if (f === 9) usages.push(pbUsage(v));
    else if (f === 28) { const u = pbRetryUsage(v); if (u) usages.push(u); }
  }
  return { ts: ts || started, usages };
}
export function antigravityGenerations(b) {
  const found = [];
  for (const [, wrapped] of pbFields(b)) {
    if (typeof wrapped === 'number') continue;
    const g = { model: null, ts: null, usages: [] };
    for (const [f, v] of pbFields(wrapped)) {
      if (typeof v === 'number') continue;
      if (f === 4) g.usages.push(pbUsage(v));
      else if (f === 17) { const u = pbRetryUsage(v); if (u) g.usages.push(u); } else if (f === 19) g.model = pbText(v);
      else if (f === 9) { for (const [ff, vv] of pbFields(v)) if (ff === 4 && typeof vv !== 'number') g.ts = pbTimestamp(vv); }
    }
    if (g.model && g.usages.some((u) => u.id)) found.push(g);
  }
  return found;
}
async function antigravity(r, env) {
  const e = envFor(env);
  const roots = e.ANTIGRAVITY_DATA_DIR ? splitEnv(e.ANTIGRAVITY_DATA_DIR)
    : ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map((d) => path.join(r.home, '.gemini', d))
      .concat(path.join(r.xdgConfig, 'antigravity'));
  const dbs = roots.map((d) => (path.basename(d) === 'conversations' ? d : path.join(d, 'conversations'))).filter(isDir)
    .flatMap((d) => walk(d, ['.db'], 1)).sort();
  const col = collector('antigravity');
  const seen = new Set();
  for (const db of dbs) {
    const res = await withSqliteFile(db, (d) => {
      const read = (sql) => { try { return d.prepare(sql).all(); } catch { return []; } };
      return {
        gens: read('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx'),
        steps: read('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx'),
      };
    });
    if (!res.ok) continue;
    const gens = res.value.gens.flatMap((row) => antigravityGenerations(Buffer.from(row.data)));
    const names = new Map();
    for (const g of gens) for (const u of g.usages) if (u.id) names.set(u.id, g.model);
    const sid = path.basename(db, '.db');
    const addUsage = (u, ts) => {
      if (u.id && seen.has(u.id)) return;
      if (u.id) seen.add(u.id);
      if (!(u.input || u.output || u.cacheRead || u.cacheWrite)) return;
      col.add(sid, {}, call(ts, (u.id && names.get(u.id)) || 'antigravity', u.input, u.output, u.cacheRead, u.cacheWrite));
    };
    for (const row of res.value.steps) {
      const step = antigravityStep(Buffer.from(row.metadata));
      if (step.ts) for (const u of step.usages) addUsage(u, step.ts);
    }
    for (const g of gens) if (g.ts) for (const u of g.usages) if (u.id) addUsage(u, g.ts);
  }
  return { sessions: col.list(), files: dbs.length };
}

// ---- recorders FlowForge switched on (hook / exporter / analytics log)
function aider(r, env, plat, logDir) {
  const files = [path.join(logDir, 'aider.jsonl')];
  const extra = envFor(env).AIDER_ANALYTICS_LOG;
  if (extra && !files.includes(extra)) files.push(extra);
  const col = collector('aider');
  const seen = new Set();
  let n = 0;
  for (const f of files.filter(isFile)) {
    n += 1;
    for (const line of lines(f)) {
      const o = parseJson(line);
      if (!o || o.event !== 'message_send' || !o.properties) continue;
      const p = o.properties;
      const key = `${o.time}:${p.total_cost}:${p.prompt_tokens}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = call(num(o.time) * 1000, p.main_model || 'aider', p.prompt_tokens, p.completion_tokens, 0, 0,
        typeof p.cost === 'number' ? p.cost : undefined);
      col.add(c.day, { title: `Aider · ${c.day}` }, c);
    }
  }
  return { sessions: col.list(), files: n };
}

function cursor(r, env, plat, logDir) {
  const f = path.join(logDir, 'cursor.jsonl');
  if (!isFile(f)) return { sessions: [], files: 0 };
  const col = collector('cursor');
  const seen = new Set();
  for (const line of lines(f)) {
    const o = parseJson(line);
    if (!o || (o.input_tokens == null && o.output_tokens == null)) continue;
    if (o.generation_id && seen.has(o.generation_id)) continue;
    if (o.generation_id) seen.add(o.generation_id);
    const cr = num(o.cache_read_tokens);
    const cw = num(o.cache_write_tokens);
    // Cursor's input_tokens already include both cache buckets.
    col.add(o.conversation_id || 'cursor', { project: o.workspace || '' },
      call(num(o.ts), o.model_id || o.model || 'cursor', Math.max(0, num(o.input_tokens) - cr - cw), o.output_tokens, cr, cw));
  }
  return { sessions: col.list(), files: 1 };
}

function otelAttrs(a) {
  if (Array.isArray(a)) {
    const out = {};
    for (const kv of a) {
      const v = kv && kv.value;
      out[kv.key] = v && (v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue);
    }
    return out;
  }
  return a && typeof a === 'object' ? a : null;
}
function otelMs(o) {
  for (const v of [o.endTime, o.startTime, o.hrTime, o.time]) {
    if (Array.isArray(v) && v.length >= 2) return num(v[0]) * 1000 + Math.floor(num(v[1]) / 1e6);
  }
  for (const v of [o.timestamp, o.observedTimestamp, o.timeUnixNano, o.endTimeUnixNano]) {
    const n = num(v);
    if (n > 1e17) return Math.floor(n / 1e6);
    if (n > 1e14) return Math.floor(n / 1e3);
    if (n > 1e11) return n;
    if (n > 0) return n * 1000;
  }
  return 0;
}
function copilotCli(r, env, plat, logDir) {
  const e = envFor(env);
  const files = [path.join(logDir, 'copilot-otel.jsonl'), ...walk(path.join(r.home, '.copilot', 'otel'), ['.jsonl'], 3)];
  if (e.COPILOT_OTEL_FILE_EXPORTER_PATH) files.push(e.COPILOT_OTEL_FILE_EXPORTER_PATH);
  const col = collector('copilot');
  const seen = new Set();
  const list = [...new Set(files)].filter(isFile);
  for (const f of list) {
    for (const line of lines(f)) {
      if (!line.includes('gen_ai')) continue;
      const o = parseJson(line);
      const a = o && otelAttrs(o.attributes);
      if (!a) continue;
      const isChat = a['gen_ai.operation.name'] === 'chat' || /^chat /.test(String(o.name || ''));
      if (!isChat) continue;
      const input = num(a['gen_ai.usage.input_tokens']);
      const output = num(a['gen_ai.usage.output_tokens']);
      if (!input && !output) continue;
      const id = a['gen_ai.response.id'] || o.spanId || (o.spanContext && o.spanContext.spanId);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const cr = num(a['gen_ai.usage.cache_read.input_tokens']);
      const cw = num(a['gen_ai.usage.cache_write.input_tokens'] || a['gen_ai.usage.cache_creation.input_tokens']);
      // Copilot bills premium requests, not tokens: the dollars come from
      // GitHub's billing report, so these calls carry tokens at $0.
      col.add(a['gen_ai.conversation.id'] || o.traceId || 'copilot-cli', {},
        call(otelMs(o), a['gen_ai.response.model'] || a['gen_ai.request.model'] || 'copilot', Math.max(0, input - cr), output, cr, cw, 0));
    }
  }
  return { sessions: col.list(), files: list.length };
}

// ---- GitHub Copilot billing: the official premium-request usage report.
export function resolveGh(env = process.env, plat = process.platform) {
  if (env.FF_GH) return env.FF_GH;
  const hit = whichSync('gh', env, plat);
  if (hit) return hit;
  const win = path.join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');
  return plat === 'win32' && isFile(win) ? win : null;
}
function runGh(gh, args, env = process.env, timeout = 20000) {
  const viaNode = /\.(mjs|js)$/i.test(gh);
  return new Promise((resolve) => {
    execFile(viaNode ? process.execPath : gh, viaNode ? [gh, ...args] : args, { timeout, windowsHide: true, maxBuffer: 4 << 20, env },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}
const billingState = { status: 'unknown', message: null, login: null, refreshing: null, checkedAt: 0 };
export function copilotBillingDays(cache, monthKeyStr) {
  return Object.entries((cache && cache.days) || {}).filter(([d]) => d.startsWith(monthKeyStr));
}
export function billingSessions(cache) {
  const col = collector('copilot');
  for (const [day, entry] of Object.entries((cache && cache.days) || {})) {
    const [y, m, d] = day.split('-').map(Number);
    const ms = new Date(y, m - 1, d, 12).getTime();
    for (const it of entry.items || []) {
      const net = num(it.netAmount);
      const gross = num(it.grossAmount);
      if (!net && !gross && !num(it.grossQuantity)) continue;
      col.add(`billing:${day.slice(0, 7)}`, { title: 'GitHub Copilot — premium requests (GitHub billing)' },
        call(ms, it.model || it.sku || 'copilot', 0, 0, 0, 0, net, { requests: num(it.grossQuantity), grossUsd: gross, billed: true }));
    }
  }
  return col.list();
}
// Past days are final once fetched after they ended; today is refreshed at
// most every 10 minutes. Up to 4 requests run at a time.
export async function refreshCopilotBilling({ cacheFile, month, env = process.env, plat = process.platform, now = Date.now() }) {
  if (billingState.refreshing) return billingState.refreshing;
  billingState.refreshing = (async () => {
    const gh = resolveGh(env, plat);
    if (!gh) { Object.assign(billingState, { status: 'no-gh', message: 'GitHub CLI (gh) is not installed' }); return billingState; }
    const cache = parseJson(readText(cacheFile) || 'null') || { login: null, days: {} };
    if (!cache.login) {
      const who = await runGh(gh, ['api', 'user', '--jq', '.login'], env);
      if (!who.ok || !who.out.trim()) {
        Object.assign(billingState, { status: 'not-logged-in', message: who.err.trim().slice(0, 200) || 'gh is not logged in' });
        return billingState;
      }
      cache.login = who.out.trim();
    }
    const [y, mo] = month.split('-').map(Number);
    const today = new Date(now);
    const isCurrent = today.getFullYear() === y && today.getMonth() + 1 === mo;
    const last = isCurrent ? today.getDate() : new Date(y, mo, 0).getDate();
    const due = [];
    for (let d = 1; d <= last; d++) {
      const key = `${month}-${String(d).padStart(2, '0')}`;
      const e = cache.days[key];
      const dayEnd = new Date(y, mo - 1, d + 1).getTime();
      const final = e && Date.parse(e.fetchedAt) > dayEnd + 3600000;
      const fresh = e && now - Date.parse(e.fetchedAt) < 600000;
      if (!final && !fresh) due.push([key, d]);
    }
    let failure = null;
    const worker = async () => {
      while (due.length && !failure) {
        const [key, d] = due.shift();
        const res = await runGh(gh, ['api', `/users/${cache.login}/settings/billing/premium_request/usage?year=${y}&month=${mo}&day=${d}`], env);
        if (!res.ok) { failure = res.err; break; }
        const body = parseJson(res.out) || {};
        cache.days[key] = { fetchedAt: new Date().toISOString(), items: Array.isArray(body.usageItems) ? body.usageItems : [] };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* read-only */ }
    if (failure) {
      const forbidden = /\b(403|404)\b/.test(failure);
      Object.assign(billingState, {
        status: forbidden ? 'forbidden' : 'error',
        message: forbidden
          ? 'GitHub refused the billing report: the gh login needs the "user" permission (Grant access), or your Copilot is billed through an organization.'
          : failure.trim().slice(0, 200),
      });
    } else Object.assign(billingState, { status: 'ok', message: null });
    billingState.login = cache.login;
    billingState.checkedAt = Date.now();
    return billingState;
  })().finally(() => { billingState.refreshing = null; });
  return billingState.refreshing;
}
export const copilotBillingState = () => billingState;

// ---------- registry ----------
// kind: 'local' - read as is; 'setup' - needs switching on once;
// 'billing' - vendor billing API; 'unsupported' - no per-request data exists.
export const TRACKERS = [
  { tool: 'claude', label: 'Claude Code', kind: 'local', read: claudeCode },
  { tool: 'codex', label: 'Codex CLI', kind: 'local', read: codex },
  { tool: 'gemini', label: 'Gemini CLI', kind: 'local', read: geminiCli },
  { tool: 'opencode', label: 'OpenCode', kind: 'local', read: openCode },
  { tool: 'cline', label: 'Cline / Roo / Kilo', kind: 'local', read: clineFamily },
  { tool: 'zed', label: 'Zed', kind: 'local', read: zed },
  { tool: 'antigravity', label: 'Antigravity', kind: 'local', read: antigravity },
  { tool: 'cursor', label: 'Cursor', kind: 'setup', setup: 'cursor-hook', read: cursor },
  { tool: 'aider', label: 'Aider', kind: 'setup', setup: 'env', read: aider },
  { tool: 'copilot', label: 'GitHub Copilot', kind: 'billing', setup: 'env', read: copilotCli },
  { tool: 'windsurf', label: 'Windsurf', kind: 'unsupported' },
  { tool: 'kiro', label: 'Kiro', kind: 'unsupported' },
  { tool: 'trae', label: 'Trae', kind: 'unsupported' },
];

export function envVarsFor(tool, logDir) {
  if (tool === 'aider') return { AIDER_ANALYTICS_LOG: path.join(logDir, 'aider.jsonl') };
  if (tool === 'copilot') {
    return {
      COPILOT_OTEL_ENABLED: 'true', COPILOT_OTEL_EXPORTER_TYPE: 'file',
      COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(logDir, 'copilot-otel.jsonl'),
    };
  }
  return {};
}

// Every tool's sessions, priced. Tools read in parallel; one broken source
// never hides the others.
export async function readAllSources({ plat = process.platform, env = process.env, pricer = null, billingCache = null } = {}) {
  const r = toolRoots(plat, env);
  const logDir = usageLogDir(plat, env);
  const results = await Promise.all(TRACKERS.filter((t) => t.read).map(async (t) => {
    try {
      const res = await t.read(r, env, plat, logDir);
      return { tool: t.tool, ...res };
    } catch (e) {
      return { tool: t.tool, sessions: [], files: 0, note: `could not be read: ${String(e.message || e).slice(0, 120)}` };
    }
  }));
  if (billingCache) {
    const copilot = results.find((x) => x.tool === 'copilot');
    copilot.sessions.push(...billingSessions(billingCache));
  }
  const status = {};
  const sessions = [];
  for (const res of results) {
    const unpriced = priceSessions(res.sessions, pricer);
    sessions.push(...res.sessions);
    const lastMs = res.sessions.reduce((m, s) => Math.max(m, s.lastMs || 0), 0);
    status[res.tool] = {
      found: res.sessions.length > 0, sessions: res.sessions.length, files: res.files || 0,
      lastSeen: lastMs ? new Date(lastMs).toISOString() : null, unpriced, note: res.note || null,
    };
  }
  return { sessions, status };
}

// ---------- switching recorders on and off ----------
const HOOK_MARK = 'usage-hook.mjs';
export function cursorHooksFile(plat = process.platform, env = process.env) {
  return path.join(toolRoots(plat, env).home, '.cursor', 'hooks.json');
}
// Adds (or removes) FlowForge's `stop` hook in Cursor's user-level hooks.json,
// leaving every other hook exactly as it was. A hooks.json that is not valid
// JSON is never overwritten.
export function setCursorHook(on, { hookScript, plat = process.platform, env = process.env, nodePath = process.execPath } = {}) {
  const file = cursorHooksFile(plat, env);
  let cfg = { version: 1, hooks: {} };
  if (isFile(file)) {
    const parsed = parseJson(readText(file));
    if (!parsed || typeof parsed !== 'object') throw new Error(`${file} is not valid JSON - left untouched`);
    cfg = parsed;
  }
  cfg.version = cfg.version || 1;
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  const stop = (Array.isArray(cfg.hooks.stop) ? cfg.hooks.stop : []).filter((h) => !String(h && h.command).includes(HOOK_MARK));
  if (on) stop.push({ command: `"${nodePath}" "${hookScript}" cursor` });
  if (stop.length) cfg.hooks.stop = stop; else delete cfg.hooks.stop;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { file, on };
}
export function cursorHookInstalled(plat = process.platform, env = process.env) {
  const cfg = parseJson(readText(cursorHooksFile(plat, env)) || 'null');
  return !!(cfg && cfg.hooks && Array.isArray(cfg.hooks.stop) && cfg.hooks.stop.some((h) => String(h && h.command).includes(HOOK_MARK)));
}

// The variables FlowForge manages live in tracking.json; each change rewrites
// them as a whole - one registry write per variable on Windows, one marked
// block in the shell profiles elsewhere. `run` executes a command (tests pass a
// recorder; FF_USAGE_DRY=1 only lists the commands).
export function trackingState(logDir) {
  return parseJson(readText(path.join(logDir, 'tracking.json')) || 'null') || { env: {} };
}
export function setTrackedEnv(tool, on, { plat = process.platform, env = process.env, run } = {}) {
  const logDir = usageLogDir(plat, env);
  const state = trackingState(logDir);
  const vars = envVarsFor(tool, logDir);
  if (on) state.env[tool] = vars; else delete state.env[tool];
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'tracking.json'), JSON.stringify(state, null, 2));
  const commands = plat === 'win32'
    ? userEnvCommands(on ? vars : {}, on ? [] : Object.keys(vars), plat)
    : [];
  if (plat !== 'win32') {
    const all = Object.assign({}, ...Object.values(state.env));
    for (const f of profileFiles(plat, env)) {
      const before = readText(f) || '';
      const after = withProfileBlock(before, all);
      if (after !== before) fs.writeFileSync(f, after);
    }
  }
  const dry = env.FF_USAGE_DRY === '1';
  if (!dry && run) for (const c of commands) run(c.cmd, c.args);
  return { tool, on, vars, commands, dry };
}
export const trackedEnvOn = (tool, plat = process.platform, env = process.env) => !!trackingState(usageLogDir(plat, env)).env[tool];

// Opt-in switches that are not environment variables (Copilot billing reads).
export function setTrackingFlag(key, value, { plat = process.platform, env = process.env } = {}) {
  const logDir = usageLogDir(plat, env);
  const state = trackingState(logDir);
  state.flags = { ...(state.flags || {}), [key]: !!value };
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'tracking.json'), JSON.stringify(state, null, 2));
  return state.flags;
}
export const trackingFlag = (key, plat = process.platform, env = process.env) => !!(trackingState(usageLogDir(plat, env)).flags || {})[key];
