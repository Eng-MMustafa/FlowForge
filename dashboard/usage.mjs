// usage.mjs - what a prompt will cost, and what every run actually cost.
//
// Two halves, zero dependencies:
//  1. estimateTokens(): a script-aware token estimator. No tokenizer ships
//     with Node, so this counts words, digit groups, Arabic/CJK runs and
//     symbols the way BPE tokenizers split them - close enough to budget with,
//     and always shown as "≈" in the UI.
//  2. Devin's own session log (<config>/cli/sessions.db, SQLite). The CLI
//     records every assistant turn with its exact input/output/cache tokens,
//     the model that answered and the ACU cost it committed. It is read through
//     node:sqlite (built into Node 22.13+), read-only, opened per read and
//     never written.
//
// A flow run's cost is dominated by the context the agent reads, not by the
// typed prompt, so the run forecast is calibrated on that ground truth: what
// your past runs of the same flow actually cost.
import fs from 'node:fs';
import { agentSessionsDbCandidates, samePath } from '../scripts/lib/platform.mjs';

// The first line of the dashboard's prompt-generator instruction. server.mjs
// builds the instruction from this constant, so a refine session in the log is
// always recognisable as one.
export const REFINE_MARK = 'You are a prompt engineer for a staged software pipeline.';

// ---------- token estimation ----------
const TOKEN_RE = new RegExp([
  '([A-Za-z]+)',
  '(\\d+)',
  '([\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]+)',
  '([\\u3040-\\u30FF\\u3400-\\u9FFF\\uAC00-\\uD7AF])',
  '(\\n+)',
  '([ \\t]+)',
  '([\\p{L}\\p{M}]+)',
  '([\\s\\S])',
].join('|'), 'gu');

export function estimateTokens(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  let n = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (m[1]) n += m[1].length <= 6 ? 1 : Math.ceil(m[1].length / 4);       // latin word
    else if (m[2]) n += Math.ceil(m[2].length / 3);                          // digits split in 3s
    else if (m[3]) n += Math.ceil(m[3].length / 2.5);                        // arabic run
    else if (m[4] || m[5]) n += 1;                                           // CJK char, newline run
    else if (m[6]) n += m[6].length > 1 ? Math.ceil((m[6].length - 1) / 4) : 0; // a space rides on the next word
    else if (m[7]) n += Math.ceil(m[7].length / 2.5);                        // other scripts
    else n += m[8].codePointAt(0) > 0xFFFF ? 2 : 1;                          // symbol / emoji
  }
  return n;
}

// Cache reads are billed at roughly a tenth of fresh input by every major
// provider, so "effective" tokens weight them that way. Rates per model are
// expressed per 1M effective tokens, learned from the user's own turns.
export const effectiveTokens = (t) => (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + 0.1 * (t.cacheRead || 0);
export const totalTokens = (t) => (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0);

// ---------- Devin's session log ----------
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const mtime = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };

export function sessionsDbPath(env = process.env) {
  if (env.FF_DEVIN_SESSIONS_DB) return env.FF_DEVIN_SESSIONS_DB;
  return agentSessionsDbCandidates(undefined, env).find(isFile) || null;
}

let sqliteMod; // undefined = not tried yet, null = this Node has no node:sqlite
async function loadSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  // node:sqlite announces itself with an ExperimentalWarning on first load; the
  // dashboard only reads a file, its console does not need that line.
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (/sqlite/i.test(String((w && w.message) || w))) return undefined;
    return emit.call(process, w, ...rest);
  };
  try { sqliteMod = await import('node:sqlite'); } catch { sqliteMod = null; } finally { process.emitWarning = emit; }
  return sqliteMod;
}

export const UNAVAILABLE = {
  'no-log': 'Devin has no local session log on this machine yet',
  'node-too-old': `Reading Devin's session log needs Node.js 22.13 or newer (this is ${process.version})`,
  unreadable: "Devin's session log could not be read",
};

// Any SQLite file, read-only, opened just for `fn` and closed again - never
// holding a lock on another program's database longer than one read.
export async function withSqliteFile(file, fn) {
  if (!file || !isFile(file)) return { ok: false, reason: 'no-log' };
  const mod = await loadSqlite();
  if (!mod || !mod.DatabaseSync) return { ok: false, reason: 'node-too-old' };
  let db = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    return { ok: true, file, value: fn(db) };
  } catch (e) {
    return { ok: false, reason: 'unreadable', error: String(e.message || e).slice(0, 200) };
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}
const withDb = (fn) => withSqliteFile(sessionsDbPath(), fn);

const TURN_COLS = `session_id AS sid, row_id AS rowId,
  json_extract(chat_message,'$.metadata.generation_model') AS model,
  json_extract(chat_message,'$.metadata.committed_acu_cost') AS acu,
  json_extract(chat_message,'$.metadata.metrics.input_tokens') AS inp,
  json_extract(chat_message,'$.metadata.metrics.output_tokens') AS outp,
  json_extract(chat_message,'$.metadata.metrics.cache_read_tokens') AS cr,
  json_extract(chat_message,'$.metadata.metrics.cache_creation_tokens') AS cw,
  json_extract(chat_message,'$.metadata.created_at') AS at,
  created_at AS nodeAt`;
const TURN_WHERE = `json_extract(chat_message,'$.role')='assistant'
  AND json_extract(chat_message,'$.metadata.metrics') IS NOT NULL`;
// Compaction and branching copy message nodes; the request id names the one
// model call behind every copy, so each call is counted exactly once.
const TURN_GROUP = `GROUP BY session_id, coalesce(json_extract(chat_message,'$.metadata.request_id'), row_id)`;
// Head and tail of the first prompt: the head says what kind of session it is,
// the tail of a prompt-generator instruction carries the user's own request.
const FIRST_SQL = `SELECT m.session_id AS sid,
    substr(json_extract(m.chat_message,'$.content'),1,800) AS c,
    substr(json_extract(m.chat_message,'$.content'),-600) AS tail
  FROM message_nodes m JOIN (SELECT session_id, min(node_id) AS nid FROM message_nodes
    WHERE json_extract(chat_message,'$.role')='user' GROUP BY session_id) f
  ON f.session_id = m.session_id AND f.nid = m.node_id`;

// Seconds or milliseconds, whichever the log used.
const toMs = (v) => (typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v) || 0);
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localStamp = (ms) => { const d = new Date(ms); return `${dayKey(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const monthKey = (ms) => dayKey(ms).slice(0, 7);

function firstText(c) {
  const s = String(c ?? '');
  if (!/^\s*[[{]/.test(s)) return s;
  try {
    const v = JSON.parse(s);
    const parts = Array.isArray(v) ? v : [v];
    return parts.map((p) => (typeof p === 'string' ? p : p && (p.text || p.content) || '')).join(' ');
  } catch { return s; }
}

export function classifyPrompt(first, tail = first) {
  const s = String(first || '').trim();
  const flow = /^\/flow\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:"([^"]*)")?/.exec(s);
  if (flow) return { kind: 'flow', flow: flow[1], task: (flow[2] || '').trim() };
  if (/^\/understand\b/.test(s)) return { kind: 'flow', flow: 'understand', task: '' };
  if (s.startsWith(REFINE_MARK)) {
    const req = /(?:User request|Prompt to optimize):\s*\n([\s\S]*)$/.exec(String(tail || ''));
    return { kind: 'refine', flow: null, task: req ? req[1].trim().slice(0, 200) : '' };
  }
  return { kind: 'chat', flow: null, task: '' };
}

// One turn (turns = 1) or a whole totals object (turns = its own count).
// `usd` is the call's dollar cost when known: Devin's is its ACU at the
// account's rate, other tools carry list-price or billed dollars of their own.
function sumTurn(acc, t, turns = 1) {
  acc.turns += turns;
  acc.input += t.input || 0;
  acc.output += t.output || 0;
  acc.cacheRead += t.cacheRead || 0;
  acc.cacheWrite += t.cacheWrite || 0;
  acc.acu += t.acu || 0;
  acc.usd += t.usd || 0;
  acc.requests += t.requests || 0;
  return acc;
}
const addTotals = (acc, t) => sumTurn(acc, t, t.turns);
export const emptyTotals = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, acu: 0, usd: 0, requests: 0 });

// Totals and first/last activity for a session an adapter assembled.
export function finalizeSession(s) {
  s.calls.sort((a, b) => a.ms - b.ms);
  Object.assign(s, s.calls.reduce((acc, t) => sumTurn(acc, t), emptyTotals()));
  if (s.calls.length) {
    s.createdMs = s.createdMs || s.calls[0].ms;
    s.lastMs = Math.max(s.lastMs || 0, s.calls[s.calls.length - 1].ms);
  }
  return s;
}

function buildSessions(db) {
  const byId = new Map();
  for (const r of db.prepare('SELECT * FROM sessions').all()) {
    let meta = {};
    try { meta = JSON.parse(r.metadata || '{}') || {}; } catch { meta = {}; }
    byId.set(r.id, {
      id: r.id,
      tool: 'devin',
      project: r.working_directory || '',
      model: r.model || '',
      title: r.title || '',
      createdMs: toMs(r.created_at),
      lastMs: toMs(r.last_activity_at || r.created_at),
      reportedAcu: typeof meta.total_acu_cost === 'number' ? meta.total_acu_cost : null,
      kind: 'chat', flow: null, task: '', first: '',
      calls: [], // one entry per model call; `turns` is their count
    });
  }
  for (const r of db.prepare(FIRST_SQL).all()) {
    const s = byId.get(r.sid);
    if (!s) continue;
    s.first = firstText(r.c).slice(0, 400);
    Object.assign(s, classifyPrompt(s.first, firstText(r.tail)));
  }
  for (const r of db.prepare(`SELECT ${TURN_COLS} FROM message_nodes WHERE ${TURN_WHERE} ${TURN_GROUP}`).all()) {
    const s = byId.get(r.sid);
    if (!s) continue;
    const ms = r.at ? toMs(r.at) : toMs(r.nodeAt);
    s.calls.push({
      ms, day: dayKey(ms), model: r.model || 'unknown',
      input: r.inp || 0, output: r.outp || 0, cacheRead: r.cr || 0, cacheWrite: r.cw || 0,
      acu: typeof r.acu === 'number' ? r.acu : 0,
    });
  }
  const out = [];
  for (const s of byId.values()) {
    s.calls.sort((a, b) => a.ms - b.ms);
    Object.assign(s, s.calls.reduce((acc, t) => sumTurn(acc, t), emptyTotals()));
    out.push(s);
  }
  return out.sort((a, b) => b.createdMs - a.createdMs);
}

let cache = null; // { stamp, at, result }
// The log is 100s of MB on a busy machine: re-read only when it changed, and
// then at most every few seconds.
export async function readDevinSessions({ force = false } = {}) {
  const file = sessionsDbPath();
  const stamp = file ? `${file}|${mtime(file)}|${mtime(file + '-wal')}` : 'none';
  if (cache && !force && (cache.stamp === stamp || Date.now() - cache.at < 8000)) return cache.result;
  const res = await withDb(buildSessions);
  const result = res.ok
    ? { available: true, file: res.file, sessions: res.value }
    : { available: false, reason: res.reason, message: UNAVAILABLE[res.reason] || res.reason, sessions: [] };
  cache = { stamp, at: Date.now(), result };
  return result;
}

// One session, fresh - for the live counter of a run in progress.
export async function readSessionUsage(id) {
  if (!id) return null;
  const res = await withDb((db) => {
    const rows = db.prepare(`SELECT ${TURN_COLS} FROM message_nodes WHERE session_id = ? AND ${TURN_WHERE} ${TURN_GROUP}`).all(id);
    const acc = emptyTotals();
    const models = {};
    for (const r of rows) {
      sumTurn(acc, { input: r.inp || 0, output: r.outp || 0, cacheRead: r.cr || 0, cacheWrite: r.cw || 0, acu: r.acu || 0 });
      if (r.model) models[r.model] = (models[r.model] || 0) + 1;
    }
    return { ...acc, models };
  });
  return res.ok ? { sessionId: id, ...res.value } : null;
}

// The newest session Devin opened in `project` since `sinceMs` - how a run
// started through the CLI (which never prints its session id) finds its log.
export async function findSessionFor(project, sinceMs) {
  const res = await withDb((db) => db.prepare(
    'SELECT id, working_directory AS dir, created_at AS c FROM sessions ORDER BY created_at DESC LIMIT 25').all());
  if (!res.ok) return null;
  const hit = res.value.find((r) => toMs(r.c) >= sinceMs - 15000 && samePath(r.dir || '', project));
  return hit ? hit.id : null;
}

// The dashboard's own run log adds what the session log cannot know: that a
// session WAS a FlowForge run (even if Devin rewrote the first prompt), and how
// it ended.
export function linkRuns(sessions, runs = []) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const r of runs) {
    let s = r.sessionId ? byId.get(r.sessionId) : null;
    if (!s && r.project && r.startedAt) {
      const t0 = Date.parse(r.startedAt);
      s = sessions.find((x) => !x.run && Math.abs(x.createdMs - t0) < 120000 && samePath(x.project, r.project));
    }
    if (!s) continue;
    s.run = { exitCode: r.exitCode ?? null, mode: r.mode || null, startedAt: r.startedAt, endedAt: r.endedAt || null };
    if (s.kind === 'chat' && r.flow) Object.assign(s, { kind: 'flow', flow: r.flow, task: r.task || '' });
  }
  return sessions;
}

// ---------- aggregation ----------
const addTo = (map, key, t) => sumTurn(map[key] || (map[key] = emptyTotals()), t);
const prevMonthOf = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};
const daysIn = (mk) => { const [y, m] = mk.split('-').map(Number); return new Date(y, m, 0).getDate(); };

// `usdPerAcu` turns Devin's ACUs into dollars (measured or contract rate);
// every other tool's calls already carry their own dollars. `tool` narrows to
// one tool. Every total therefore has both `acu` (Devin only) and `usd` (all).
export function aggregateUsage(sessions, { month, scope = 'all', tool = '', usdPerAcu = DEFAULT_USD_PER_ACU, now = Date.now() } = {}) {
  const mk = /^\d{4}-\d{2}$/.test(month || '') ? month : monthKey(now);
  const prev = prevMonthOf(mk);
  const inScope = (s) => (scope === 'all' || s.kind !== 'chat') && (!tool || (s.tool || 'devin') === tool);
  const priced = (t) => (typeof t.usd === 'number' ? t : { ...t, usd: (t.acu || 0) * usdPerAcu });
  const totals = { ...emptyTotals(), sessions: 0, runs: 0 };
  const prevTotals = { ...emptyTotals(), sessions: 0 };
  const daily = {};
  const byModel = {};
  const byProject = {};
  const byFlow = {};
  const byTool = {};
  const byKind = { flow: 0, refine: 0, chat: 0 };
  const months = new Set();
  const tasks = [];
  for (const s of sessions) {
    if (!inScope(s)) continue;
    const part = emptyTotals();
    const models = {};
    let inPrev = false;
    for (const raw of s.calls) {
      const tm = raw.day.slice(0, 7);
      months.add(tm);
      if (tm !== prev && tm !== mk) continue;
      const t = priced(raw);
      if (tm === prev) { sumTurn(prevTotals, t); inPrev = true; continue; }
      sumTurn(part, t);
      addTo(daily, t.day, t);
      addTo(byModel, t.model, t);
      models[t.model] = (models[t.model] || 0) + (t.usd || 0);
    }
    if (inPrev) prevTotals.sessions += 1;
    if (!part.turns) continue;
    addTotals(totals, part);
    totals.sessions += 1;
    const p = byProject[s.project] || (byProject[s.project] = { ...emptyTotals(), sessions: 0 });
    addTotals(p, part);
    p.sessions += 1;
    const tk = s.tool || 'devin';
    const tt = byTool[tk] || (byTool[tk] = { ...emptyTotals(), sessions: 0 });
    addTotals(tt, part);
    tt.sessions += 1;
    byKind[s.kind] = (byKind[s.kind] || 0) + part.usd;
    if (s.kind === 'flow') {
      totals.runs += 1;
      const f = byFlow[s.flow] || (byFlow[s.flow] = { ...emptyTotals(), runs: 0 });
      addTotals(f, part);
      f.runs += 1;
    }
    tasks.push({
      id: s.id, tool: tk, kind: s.kind, flow: s.flow, task: s.task, title: s.title || (s.first || '').slice(0, 80),
      project: s.project, model: s.model, createdAt: new Date(s.createdMs).toISOString(),
      durationSec: Math.max(0, Math.round((s.lastMs - s.createdMs) / 1000)),
      ...part,
      reportedAcu: s.reportedAcu ?? null,
      topModel: Object.entries(models).sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || s.model,
      run: s.run || null,
    });
  }
  const eff = (t) => effectiveTokens(t);
  const n = daysIn(mk);
  const dailyArr = Array.from({ length: n }, (_, i) => {
    const day = `${mk}-${pad(i + 1)}`;
    const d = daily[day] || emptyTotals();
    return { day, acu: d.acu, usd: d.usd, tokens: totalTokens(d), turns: d.turns };
  });
  const isCurrent = mk === monthKey(now);
  const elapsed = isCurrent ? new Date(now).getDate() : n;
  const pace = (v) => (isCurrent && elapsed > 0 ? (v / elapsed) * n : null);
  const byUsd = (a, b) => b.usd - a.usd;
  return {
    month: mk, prevMonth: prev, scope, tool: tool || '',
    months: [...months].sort().reverse(),
    totals: {
      ...totals, tokens: totalTokens(totals),
      avgPerRun: totals.runs ? Object.values(byFlow).reduce((a, f) => a + f.acu, 0) / totals.runs : 0,
      avgUsdPerRun: totals.runs ? byKind.flow / totals.runs : 0,
    },
    prev: { ...prevTotals, tokens: totalTokens(prevTotals) },
    projection: pace(totals.acu),
    projectionUsd: pace(totals.usd),
    daily: dailyArr,
    byModel: Object.entries(byModel).map(([model, t]) => ({
      model, ...t, tokens: totalTokens(t),
      share: totals.usd ? t.usd / totals.usd : (totals.acu ? t.acu / totals.acu : 0),
      acuPerMTok: t.acu && eff(t) ? (t.acu / eff(t)) * 1e6 : null,
    })).sort(byUsd),
    byProject: Object.entries(byProject).map(([project, t]) => ({ project, ...t, tokens: totalTokens(t) })).sort(byUsd),
    byFlow: Object.entries(byFlow).map(([flow, t]) => ({
      flow, ...t, tokens: totalTokens(t), avgAcu: t.runs ? t.acu / t.runs : 0, avgUsd: t.runs ? t.usd / t.runs : 0,
    })).sort(byUsd),
    byTool: Object.entries(byTool).map(([name, t]) => ({
      tool: name, ...t, tokens: totalTokens(t), share: totals.usd ? t.usd / totals.usd : 0,
    })).sort(byUsd),
    byKind,
    tasks: tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

// ---------- monthly report ----------
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(v));
}
export const fmtAcu = (n) => { const v = Number(n) || 0; return v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4); };

const REPORT_TEXT = {
  en: {
    title: 'Usage report', scope: 'Scope', all: 'all tools and sessions', ff: 'FlowForge runs and prompt generation only',
    generated: 'Generated', source: "Sources: Devin's local session log and each tool's own usage records - exact tokens per model call.",
    byTool: 'By tool', tool: 'Tool',
    summary: 'Summary', metric: 'Metric', value: 'Value', acu: 'ACUs spent', usd: 'Cost (USD)', at: 'at',
    prev: 'Previous month', change: 'Change', projection: 'Projected month total', sessions: 'Sessions',
    runs: 'Flow runs', avg: 'avg', io: 'Tokens in / out', cache: 'Cache read / write', busiest: 'Busiest day',
    model: 'Model', turns: 'Calls', input: 'Input', output: 'Output', cacheRead: 'Cache read', share: 'Share',
    byModel: 'By model', byProject: 'By project', project: 'Project', byFlow: 'By flow', flow: 'Flow',
    daily: 'Daily', day: 'Day', tokens: 'Tokens', tasks: 'Tasks', date: 'Date', kind: 'Kind', task: 'Task',
    none: 'No usage recorded in this month.',
    usdMeasured: 'Dollars at Devin\'s official list prices: 1 ACU = ${rate}, verified on {ok} of {n} calls against the published per-token price list.',
    usdContract: 'Dollars at your contract rate of ${rate} per ACU.',
    usdDefault: 'Dollars at Devin\'s list-price conversion of ${rate} per ACU (price list not reachable for verification).',
  },
  ar: {
    title: 'تقرير الاستخدام', scope: 'النطاق', all: 'كل الأدوات والجلسات', ff: 'تشغيلات FlowForge وتوليد البرومبت بس',
    generated: 'اتعمل في', source: 'المصادر: سجل جلسات Devin المحلي وسجلات استهلاك كل أداة — التوكنز بالظبط لكل نداء موديل.',
    byTool: 'حسب الأداة', tool: 'الأداة',
    summary: 'الملخص', metric: 'المقياس', value: 'القيمة', acu: 'الـ ACU المصروفة', usd: 'التكلفة (دولار)', at: 'بسعر',
    prev: 'الشهر اللي فات', change: 'التغيير', projection: 'المتوقع لآخر الشهر', sessions: 'الجلسات',
    runs: 'تشغيلات الفلو', avg: 'متوسط', io: 'توكنز داخلة / خارجة', cache: 'كاش مقروء / مكتوب', busiest: 'أكتر يوم',
    model: 'الموديل', turns: 'نداءات', input: 'داخل', output: 'خارج', cacheRead: 'كاش مقروء', share: 'النسبة',
    byModel: 'حسب الموديل', byProject: 'حسب المشروع', project: 'المشروع', byFlow: 'حسب الفلو', flow: 'الفلو',
    daily: 'يوم بيوم', day: 'اليوم', tokens: 'توكنز', tasks: 'التاسكات', date: 'التاريخ', kind: 'النوع', task: 'التاسك',
    none: 'مفيش استخدام متسجل في الشهر ده.',
    usdMeasured: 'الدولارات بأسعار Devin الرسمية: الـ ACU = ${rate}، ومتأكد منها على {ok} من {n} نداء مقارنة بجدول أسعار التوكن المنشور.',
    usdContract: 'الدولارات بسعر عقدك: ${rate} لكل ACU.',
    usdDefault: 'الدولارات بتحويل Devin للسعر الرسمي: ${rate} لكل ACU (جدول الأسعار مش متاح للتأكيد).',
  },
};

// Dollars come from the aggregation itself (Devin's ACUs already converted at
// `usdPerAcu`, every other tool at its own list or billed price); the rate
// arguments only explain in the header how Devin's dollars were derived.
export function usageReportMarkdown(agg, { usdPerAcu = null, lang = 'en', now = Date.now(), usdBasis = null, verified = 0, priced = 0 } = {}) {
  const T = REPORT_TEXT[lang] || REPORT_TEXT.en;
  const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;
  const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const table = (head, rows) => rows.length
    ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
    : '';
  const t = agg.totals;
  const busiest = agg.daily.reduce((b, d) => (d.usd > (b ? b.usd : 0) ? d : b), null);
  const change = agg.prev.usd ? `${(((t.usd - agg.prev.usd) / agg.prev.usd) * 100).toFixed(0)}%` : '—';
  const out = [
    `# ${T.title} — ${agg.month}`,
    '',
    `${T.scope}: ${agg.scope === 'flowforge' ? T.ff : T.all}${agg.tool ? ` · ${agg.tool}` : ''}  `,
    `${T.generated}: ${localStamp(now)}  `,
    `${T.source}  `,
    ...(usdPerAcu && usdBasis ? [(usdBasis === 'measured' ? T.usdMeasured : usdBasis === 'contract' ? T.usdContract : T.usdDefault)
      .replace('{rate}', String(usdPerAcu)).replace('{ok}', verified).replace('{n}', priced)] : []),
    '',
    `## ${T.summary}`,
    '',
    table([T.metric, T.value], [
      [T.usd, money(t.usd)],
      [T.acu, fmtAcu(t.acu)],
      [T.prev, money(agg.prev.usd)],
      [T.change, change],
      ...(agg.projectionUsd !== null && agg.projectionUsd !== undefined ? [[T.projection, money(agg.projectionUsd)]] : []),
      [T.sessions, t.sessions],
      [T.runs, `${t.runs}${t.runs ? ` (${T.avg} ${money(t.avgUsdPerRun)})` : ''}`],
      [T.io, `${fmtTokens(t.input)} / ${fmtTokens(t.output)}`],
      [T.cache, `${fmtTokens(t.cacheRead)} / ${fmtTokens(t.cacheWrite)}`],
      ...(busiest ? [[T.busiest, `${busiest.day} — ${money(busiest.usd)}`]] : []),
    ]),
    '',
  ];
  if (!t.turns) return [...out, T.none, ''].join('\n');
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (agg.byTool && agg.byTool.length) {
    out.push(`## ${T.byTool}`, '', table([T.tool, T.sessions, T.tokens, 'USD', T.share],
      agg.byTool.map((x) => [x.tool, x.sessions, fmtTokens(x.tokens), money(x.usd), pct(x.share)])), '');
  }
  out.push(`## ${T.byModel}`, '', table([T.model, T.turns, T.input, T.output, T.cacheRead, 'USD', 'ACU', T.share],
    agg.byModel.map((m) => [m.model, m.turns, fmtTokens(m.input), fmtTokens(m.output), fmtTokens(m.cacheRead), money(m.usd), m.acu ? fmtAcu(m.acu) : '—', pct(m.share)])), '');
  out.push(`## ${T.byProject}`, '', table([T.project, T.sessions, T.tokens, 'USD'],
    agg.byProject.map((p) => [p.project || '—', p.sessions, fmtTokens(p.tokens), money(p.usd)])), '');
  if (agg.byFlow.length) {
    out.push(`## ${T.byFlow}`, '', table([T.flow, T.runs, T.tokens, 'USD', T.avg],
      agg.byFlow.map((f) => [f.flow, f.runs, fmtTokens(f.tokens), money(f.usd), money(f.avgUsd)])), '');
  }
  out.push(`## ${T.daily}`, '', table([T.day, 'USD', T.tokens, T.turns],
    agg.daily.filter((d) => d.turns).map((d) => [d.day, money(d.usd), fmtTokens(d.tokens), d.turns])), '');
  out.push(`## ${T.tasks}`, '', table([T.date, T.tool, T.kind, T.task, T.project, T.model, T.tokens, 'USD', 'ACU'],
    agg.tasks.map((x) => [
      localStamp(Date.parse(x.createdAt)), x.tool || 'devin', x.kind === 'flow' ? `flow:${x.flow}` : x.kind,
      (x.task || x.title || '').slice(0, 90), (x.project || '').split(/[\\/]/).filter(Boolean).pop() || '—',
      x.topModel, fmtTokens(totalTokens(x)), money(x.usd), x.acu ? fmtAcu(x.acu) : '—',
    ])), '');
  return out.join('\n');
}

// ---------- model rates + run forecast ----------
// The name segments before the first one carrying a version number:
// claude-opus-5-high / claude-opus-5-5-xhigh -> claude-opus, swe-1-7-lightning
// -> swe, gemini-3-7-flash-high -> gemini, kimi-k2-7 -> kimi.
export function modelFamily(m) {
  const segs = String(m || '').toLowerCase().split('-');
  const i = segs.findIndex((s) => /\d/.test(s));
  return (i === -1 ? segs : segs.slice(0, Math.max(1, i))).join('-');
}

// ACU per 1M effective tokens, per model, from the user's own turns.
export function modelRates(sessions) {
  const by = {};
  for (const s of sessions) for (const t of s.calls) addTo(by, t.model.toLowerCase(), t);
  const out = {};
  for (const [m, t] of Object.entries(by)) {
    const e = effectiveTokens(t);
    if (e > 0 && t.acu > 0) out[m] = { ...t, rate: (t.acu / e) * 1e6, acuPerTurn: t.acu / t.turns };
  }
  return out;
}

// Exact model first, then its family (claude-opus-5-high ~ claude-opus-5-5-xhigh),
// then a bare alias (`opus`) matched inside the recorded names.
export function rateFor(model, rates) {
  const m = String(model || '').toLowerCase();
  if (!m || m === 'default') return null;
  if (rates[m]) return { rate: rates[m].rate, acuPerTurn: rates[m].acuPerTurn, basis: 'exact', models: [m] };
  const fam = modelFamily(m);
  const hits = Object.entries(rates).filter(([k]) => modelFamily(k) === fam || (fam.length >= 3 && k.includes(fam)));
  if (!hits.length) return null;
  const pooled = hits.reduce((a, [, t]) => addTotals(a, t), emptyTotals());
  const e = effectiveTokens(pooled);
  return { rate: e ? (pooled.acu / e) * 1e6 : null, acuPerTurn: pooled.acu / pooled.turns, basis: 'family', models: hits.map(([k]) => k) };
}

// ---------- dollars ----------
// Devin publishes its official per-model price list (USD per 1M input /
// output / cache-write / cache-read tokens, per plan tier) on its models page.
// For local agents (Devin CLI) each call's ACU is that token cost converted at
// a fixed rate - so pricing the log's own calls with the table both gives
// exact list-price dollars and MEASURES this account's ACU -> $ rate, call by
// call, instead of trusting a number typed in by hand.
export const PRICE_SOURCE = 'https://docs.devin.ai/desktop/models.md';
const TIER_KEYS = { TEAMS_TIER_ENTERPRISE_SAAS: 'enterprise', TEAMS_TIER_PRO: 'pro' };

// The page embeds `modelCostData = [...]`; take that array and nothing else.
export function parsePriceTable(text) {
  const s = String(text || '');
  const at = s.search(/modelCostData\s*=\s*\[/);
  if (at < 0) return null;
  const start = s.indexOf('[', at);
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (!depth) { end = i; break; } }
  }
  if (end < 0) return null;
  let rows;
  try { rows = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const models = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const tier = TIER_KEYS[r.tier];
    const id = String(r.model_uid || '').toLowerCase();
    if (!tier || !id) continue;
    (models[id] || (models[id] = {}))[tier] = [
      r.input_cost_per_million_usd, r.output_cost_per_million_usd,
      r.cache_write_cost_per_million_usd, r.cache_read_cost_per_million_usd,
    ].map((v) => Number(v) || 0);
  }
  return Object.keys(models).length ? models : null;
}

const priceState = { table: null, fetchedAt: null, source: null, loading: null };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// Cached for a day in `cacheFile`; offline keeps the last good table.
// FF_DEVIN_PRICES points at a local copy (tests, air-gapped machines) and
// then nothing is fetched at all.
export async function refreshPrices({ cacheFile = null, maxAgeMs = 24 * 3600 * 1000, force = false, timeoutMs = 8000 } = {}) {
  const local = process.env.FF_DEVIN_PRICES;
  if (local) {
    priceState.table = parsePriceTable(readText(local));
    priceState.fetchedAt = new Date(fs.existsSync(local) ? fs.statSync(local).mtimeMs : Date.now()).toISOString();
    priceState.source = local;
    return priceState;
  }
  if (!priceState.table && cacheFile) {
    try {
      const c = JSON.parse(readText(cacheFile) || 'null');
      if (c && c.models && Object.keys(c.models).length) Object.assign(priceState, { table: c.models, fetchedAt: c.fetchedAt, source: c.source });
    } catch { /* a broken cache is simply refetched */ }
  }
  const age = priceState.fetchedAt ? Date.now() - Date.parse(priceState.fetchedAt) : Infinity;
  if ((!force && age < maxAgeMs) || process.env.FF_NO_NETWORK === '1') return priceState;
  if (priceState.loading) return priceState.loading;
  priceState.loading = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(PRICE_SOURCE, { signal: ctl.signal, headers: { 'User-Agent': 'FlowForge' } });
      clearTimeout(timer);
      const table = res.ok ? parsePriceTable(await res.text()) : null;
      if (table) {
        Object.assign(priceState, { table, fetchedAt: new Date().toISOString(), source: PRICE_SOURCE });
        if (cacheFile) {
          try { fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: priceState.fetchedAt, source: PRICE_SOURCE, models: table })); } catch { /* read-only install */ }
        }
      }
    } catch { /* offline: keep the last good table */ }
    priceState.loading = null;
    return priceState;
  })();
  return priceState.loading;
}
export const currentPrices = () => priceState;

export function priceFor(model, table, tier = 'enterprise') {
  const row = table && model ? table[String(model).toLowerCase()] : null;
  return row ? (row[tier] || row.enterprise || row.pro || null) : null;
}
export const callUsd = (c, p) => (c.input * p[0] + c.output * p[1] + c.cacheWrite * p[2] + c.cacheRead * p[3]) / 1e6;

// Price every logged call at the official table, per tier, and keep the tier
// under which the ratio list-price / committed-ACU is one constant. That
// constant is this account's dollars per ACU, verified call by call.
export const DEFAULT_USD_PER_ACU = 2;
export function dollarRate(sessions, table) {
  const fallback = { usdPerAcu: DEFAULT_USD_PER_ACU, basis: 'default', tier: null, verified: 0, priced: 0 };
  if (!table) return fallback;
  let best = null;
  for (const tier of ['enterprise', 'pro']) {
    const ratios = [];
    let zero = 0;
    for (const s of sessions) {
      for (const c of s.calls || []) {
        if (!(c.acu > 0)) continue;
        const row = table[String(c.model).toLowerCase()];
        const p = row && row[tier];
        if (!p) continue;
        const usd = callUsd(c, p);
        if (usd > 0) ratios.push(usd / c.acu); else zero += 1;
      }
    }
    if (!ratios.length) continue;
    const med = median(ratios);
    const ok = ratios.filter((r) => Math.abs(r / med - 1) < 0.01).length;
    const score = ok - (ratios.length - ok) - zero;
    if (!best || score > best.score) best = { tier, usdPerAcu: med, verified: ok, priced: ratios.length + zero, score };
  }
  if (!best) return fallback;
  return { usdPerAcu: Math.round(best.usdPerAcu * 1e4) / 1e4, basis: 'measured', tier: best.tier, verified: best.verified, priced: best.priced };
}

// ---------- pipeline model ----------
// A bottom-up estimate from the flow file itself, for when there is no run
// history yet (and as the per-stage breakdown when there is). Each agent stage
// is one sub-agent context: it opens with Devin's system context + its role
// profile + its prompt + the task + the artifacts earlier stages wrote, then
// grows by the tool output of every call. Calls per stage come from the role
// and effort; tokens per call and context growth are measured on this account
// when its log has enough calls, otherwise sane defaults (and marked so).
const ROLE_CALLS = { thinker: 12, researcher: 16, analyst: 16, coder: 28, tester: 14, debugger: 18, optimizer: 18, shipper: 8, security: 20 };
const ROLE_OUTPUT = { coder: 1.8, debugger: 1.4, thinker: 1.2 };
const EFFORT_MULT = { low: 0.6, medium: 1, high: 1.3, xhigh: 1.45, max: 1.6 };
const ARTIFACT_TOKENS = 1500;
const SCRIPT_ARTIFACT_TOKENS = 3000;
// The --speed table of skills/flow/SKILL.md, mirrored so the estimate prices
// the models that will actually run.
export const SPEED_OVERRIDES = {
  fast: { model: 'swe-1-7-lightning', testerModel: 'gemini-3-7-flash-high', effort: 'low', maxLoops: 1 },
  balanced: { model: 'claude-sonnet-5-high', effort: 'medium' },
  quality: { model: 'claude-opus-5-max', effort: 'max' },
};

const median = (v) => { const q = quantiles(v); return q ? q.p50 : null; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How big a reply is, and how much the context grows per call, on this account.
export function callShape(sessions) {
  const outs = [];
  const growths = [];
  for (const s of sessions) {
    let prev = null;
    for (const c of s.calls || []) {
      if (c.model === 'compactor') { prev = null; continue; }
      const ctx = c.input + c.cacheRead + c.cacheWrite;
      if (c.output > 0) outs.push(c.output);
      if (prev !== null && ctx > prev) growths.push(ctx - prev);
      prev = ctx;
    }
  }
  const out = outs.length >= 20 ? median(outs) : null;
  const growth = growths.length >= 20 ? median(growths) : null;
  return {
    outPerCall: Math.round(clamp(out ?? 450, 150, 1500)),
    growthPerCall: Math.round(clamp(growth ?? 2500, 800, 6000)),
    measured: out !== null && growth !== null,
  };
}

// One sub-agent context of n calls: the first call writes the prefix, every
// later call re-reads what came before (cache) and adds the last reply plus new
// tool output (fresh).
function contextCost(n, open, growth, out) {
  if (n <= 0) return { calls: 0, fresh: 0, cacheRead: 0, output: 0, tokens: 0 };
  const ctxTotal = n * open + (growth * n * (n - 1)) / 2;
  const fresh = Math.min(ctxTotal, open + (n - 1) * (growth + out));
  return { calls: n, fresh, cacheRead: ctxTotal - fresh, output: n * out, tokens: ctxTotal + n * out };
}

export function pipelineEstimate({
  flowDef, speed = '', parts = [], promptTokens = 0, baseline = null, rates = {}, account = null, shape,
  prices = null, tier = 'enterprise', usdPerAcu = DEFAULT_USD_PER_ACU,
}) {
  const stagesDef = (flowDef && Array.isArray(flowDef.stages)) ? flowDef.stages : [];
  const sp = SPEED_OVERRIDES[speed] || null;
  const tok = Object.fromEntries(parts.map((p) => [p.name, estimateTokens(p.text)]));
  const base = baseline || 11000;
  const price = (model) => rateFor(model, rates) || account;
  const byId = Object.fromEntries(stagesDef.map((s) => [s.id, s]));
  // A model on Devin's price list is priced token-class by token-class at its
  // official rate: new context is written to the cache (or billed as plain
  // input when the model has no cache-write price), re-read context is a cache
  // read, replies are output. Anything else falls back to the rate measured on
  // this account.
  const cost = (model, c, fallbackRate) => {
    const p = priceFor(model, prices, tier);
    if (p) {
      const usd = (c.fresh * (p[2] > 0 ? p[2] : p[0]) + c.cacheRead * p[3] + c.output * p[1]) / 1e6;
      return { usd, acu: usd / usdPerAcu, basis: 'price-list', price: p };
    }
    if (fallbackRate && fallbackRate.rate) {
      const acu = ((c.fresh + c.output + 0.1 * c.cacheRead) * fallbackRate.rate) / 1e6;
      return { usd: acu * usdPerAcu, acu, basis: fallbackRate.basis, price: null };
    }
    return { usd: null, acu: null, basis: null, price: null };
  };
  let artifacts = 0;
  const stages = stagesDef.map((st) => {
    const isScript = !st.agent;
    const retryOnly = !!st.runOnlyWhenJumpedTo;
    let model = st.model || '';
    let effort = st.effort || 'medium';
    if (sp && !isScript) {
      model = st.agent === 'tester' && sp.testerModel ? sp.testerModel : sp.model;
      effort = sp.effort;
    }
    const r = isScript ? null : price(model);
    const calls = isScript ? 0 : Math.max(2, Math.round((ROLE_CALLS[st.agent] || 12) * (EFFORT_MULT[effort] || 1)));
    const out = Math.round(shape.outPerCall * (ROLE_OUTPUT[st.agent] || 1));
    const open = base + (tok[`agent:${st.agent}`] || 0) + estimateTokens(st.prompt || '') + promptTokens + artifacts;
    const c = contextCost(calls, open, shape.growthPerCall, out);
    const k = isScript ? { usd: null, acu: null, basis: null, price: null } : cost(model, c, r);
    if (!retryOnly) artifacts += isScript ? SCRIPT_ARTIFACT_TOKENS : ARTIFACT_TOKENS;
    return {
      id: st.id, title: st.title || st.id, titleAr: st.titleAr || '', agent: st.agent || '',
      kind: isScript ? 'script' : retryOnly ? 'retry-only' : 'agent',
      model: isScript ? '' : model, effort: isScript ? '' : effort,
      calls: c.calls, tokens: Math.round(c.tokens), fresh: Math.round(c.fresh), cacheRead: Math.round(c.cacheRead), output: Math.round(c.output),
      rate: r ? r.rate : null, basis: k.basis, price: k.price,
      acu: k.acu, usd: k.usd,
      onFail: st.onFail || null,
      maxLoops: sp && sp.maxLoops ? Math.min(sp.maxLoops, st.maxLoops || 1) : (st.maxLoops || 1),
    };
  });
  // The orchestrator: the main session reads the skill and the flow once, then
  // dispatches, verifies and records every stage.
  const agentStages = stages.filter((s) => s.kind === 'agent').length;
  const orchCalls = 3 + 3 * agentStages;
  const orchOpen = base + (tok.skill || 0) + promptTokens;
  const oc = contextCost(orchCalls, orchOpen, Math.round(shape.growthPerCall / 2), shape.outPerCall);
  // The main session runs on the account's own model choice, so it is priced
  // at the account's measured average.
  const ok = cost('', oc, account);
  const orchestrator = {
    id: 'orchestrator', kind: 'orchestrator', calls: oc.calls, tokens: Math.round(oc.tokens),
    fresh: Math.round(oc.fresh), cacheRead: Math.round(oc.cacheRead), output: Math.round(oc.output),
    rate: account ? account.rate : null, basis: ok.basis, acu: ok.acu, usd: ok.usd,
  };
  const add = (x, y) => (x === null || y === null ? null : x + y);
  const sum = (list) => list.reduce((a, s) => ({
    calls: a.calls + s.calls, tokens: a.tokens + s.tokens,
    acu: s.calls ? add(a.acu, s.acu) : a.acu,
    usd: s.calls ? add(a.usd, s.usd) : a.usd,
  }), { calls: 0, tokens: 0, acu: 0, usd: 0 });
  const happy = sum([orchestrator, ...stages.filter((s) => s.kind !== 'retry-only')]);
  // One failed check: its onFail target runs, then the check runs again.
  const retryPaths = [];
  for (const s of stages) {
    if (!s.onFail || !byId[s.onFail]) continue;
    const target = stages.find((x) => x.id === s.onFail);
    const extra = sum([target, s]);
    retryPaths.push({ from: s.id, to: target.id, maxLoops: s.maxLoops, acu: extra.acu, usd: extra.usd, tokens: extra.tokens, calls: extra.calls });
  }
  const retry = retryPaths.reduce((a, e) => ({
    calls: a.calls + e.calls, tokens: a.tokens + e.tokens, acu: add(a.acu, e.acu), usd: add(a.usd, e.usd),
  }), { calls: 0, tokens: 0, acu: 0, usd: 0 });
  const withRetry = {
    calls: happy.calls + retry.calls, tokens: happy.tokens + retry.tokens,
    acu: add(happy.acu, retry.acu), usd: add(happy.usd, retry.usd),
  };
  return {
    speed: sp ? speed : '', stages, orchestrator, happy, withRetry, retryPaths,
    pricing: { tier, usdPerAcu, table: !!prices },
    assumptions: { ...shape, baseline: base, artifactTokens: ARTIFACT_TOKENS },
  };
}

function quantiles(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo);
  };
  return { p25: q(0.25), p50: q(0.5), p75: q(0.75), min: v[0], max: v[v.length - 1] };
}

// Everything the pre-run chip shows. `parts` are the texts every run of this
// flow sends besides the task (skill, role profiles, stage prompts);
// `stageCounts` maps flow name -> number of stages, for the cross-flow fallback.
export function estimateRun({ flow, task, flowDef, parts = [], sessions = [], stageCounts = {}, agentModels = {}, speed = '', prices = null }) {
  const promptTokens = estimateTokens(task);
  const overhead = parts.map((p) => ({ name: p.name, tokens: estimateTokens(p.text) }));
  const overheadTokens = overhead.reduce((a, p) => a + p.tokens, 0);
  const rates = modelRates(sessions);
  // Devin re-sends its own system context with every turn; the first turn of
  // each session shows how big that floor is on this account.
  const firsts = sessions.filter((s) => s.calls.length).map((s) => {
    const t = s.calls[0];
    return t.input + t.cacheRead + t.cacheWrite;
  });
  const baseline = quantiles(firsts);
  const stagesDef = (flowDef && Array.isArray(flowDef.stages)) ? flowDef.stages : [];
  // A model never used on this account yet is priced at the account's average
  // rate - marked as such, never passed off as measured.
  const pooled = Object.values(rates).reduce((a, t) => addTotals(a, t), emptyTotals());
  const avgRate = effectiveTokens(pooled) ? (pooled.acu / effectiveTokens(pooled)) * 1e6 : null;
  const account = avgRate ? { rate: avgRate, acuPerTurn: pooled.turns ? pooled.acu / pooled.turns : null, basis: 'account' } : null;
  const stages = stagesDef.map((st) => {
    const model = st.model || agentModels[st.agent] || '';
    const r = rateFor(model, rates) || account;
    const sent = (baseline ? baseline.p50 : 0) + overheadTokens + promptTokens;
    return {
      id: st.id, title: st.title || st.id, titleAr: st.titleAr || '', agent: st.agent || '', model,
      rate: r ? r.rate : null, acuPerTurn: r ? r.acuPerTurn : null, basis: r ? r.basis : null,
      // What opening this stage costs before the agent reads anything:
      // system context + skill/role text + the task, once, at this model's rate.
      openTokens: sent,
      openAcu: r && r.rate ? (sent * r.rate) / 1e6 : null,
    };
  });
  const promptAcu = stages.reduce((a, s) => a + (s.rate ? (promptTokens * s.rate) / 1e6 : 0), 0);
  const runsOf = (name) => sessions.filter((s) => s.kind === 'flow' && s.flow === name && s.turns);
  const own = runsOf(flow);
  let forecast = null;
  if (own.length) {
    forecast = {
      basis: 'this-flow', runs: own.length,
      acu: quantiles(own.map((s) => s.acu)),
      tokens: quantiles(own.map((s) => totalTokens(s))),
      turns: quantiles(own.map((s) => s.turns)),
      durationSec: quantiles(own.map((s) => (s.lastMs - s.createdMs) / 1000)),
    };
  } else {
    // No run of this flow yet: scale what other flows cost per stage.
    const others = sessions.filter((s) => s.kind === 'flow' && s.turns && stageCounts[s.flow]);
    const n = stagesDef.length || 1;
    if (others.length) {
      const per = (fn) => quantiles(others.map((s) => (fn(s) / stageCounts[s.flow]) * n));
      forecast = {
        basis: 'other-flows', runs: others.length,
        acu: per((s) => s.acu), tokens: per((s) => totalTokens(s)), turns: per((s) => s.turns),
        durationSec: per((s) => (s.lastMs - s.createdMs) / 1000),
      };
    }
  }
  // The bottom-up pipeline estimate. Once this flow has real runs, its numbers
  // are scaled so the default-speed happy path matches their median - the
  // stage split stays, the level becomes measured.
  const shape = callShape(sessions);
  const dollars = dollarRate(sessions, prices);
  const pipeArgs = {
    flowDef, parts, promptTokens, baseline: baseline ? baseline.p50 : null, rates, account, shape,
    prices, tier: dollars.tier || 'enterprise', usdPerAcu: dollars.usdPerAcu,
  };
  const pipeline = pipelineEstimate({ ...pipeArgs, speed });
  if (forecast && forecast.acu) {
    const toUsd = (q) => q && Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v * dollars.usdPerAcu]));
    forecast.usd = toUsd(forecast.acu);
  }
  if (forecast && forecast.basis === 'this-flow' && forecast.acu) {
    const ref = speed ? pipelineEstimate({ ...pipeArgs, speed: '' }) : pipeline;
    if (ref.happy.acu) {
      const f = forecast.acu.p50 / ref.happy.acu;
      const scale = (o) => {
        if (!o) return;
        if (typeof o.acu === 'number') o.acu *= f;
        if (typeof o.usd === 'number') o.usd *= f;
        if (typeof o.tokens === 'number') o.tokens = Math.round(o.tokens * f);
      };
      [...pipeline.stages, pipeline.orchestrator, pipeline.happy, pipeline.withRetry, ...pipeline.retryPaths].forEach(scale);
      pipeline.calibration = { factor: f, runs: forecast.runs };
    }
  }
  return {
    flow, promptTokens, promptAcu: promptAcu || null,
    overhead, overheadTokens,
    baselineTokens: baseline ? Math.round(baseline.p50) : null,
    stages, forecast, pipeline, dollars,
  };
}
