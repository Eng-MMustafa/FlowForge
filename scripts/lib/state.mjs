// State engine for a FlowForge run - the single writer of .workbench/state.json.
//
// The orchestrator is a model: before this module it rewrote the whole state
// document by hand at every transition (15-25 times per run), which cost a
// model turn and thousands of output tokens each time and occasionally broke
// the JSON the dashboard polls. Now every transition is one short command
// (scripts/state.mjs) and the document is built here, deterministically.
//
// Pure functions take and return plain state objects so the test suite can
// check every rule without a filesystem; readState/writeState do the I/O and
// write atomically (temp file + rename) so the dashboard never reads half a
// file. Zero dependencies (node builtins only).
import fs from 'node:fs';
import path from 'node:path';

export const STAGE_STATUSES = ['pending', 'running', 'waiting_gate', 'done', 'failed', 'skipped'];
export const FLOW_STATUSES = ['running', 'waiting_gate', 'done', 'failed', 'stopped'];
export const SIZES = ['tiny', 'small', 'full'];
export const LOG_MAX = 100;

// --speed rows (mirrors the table in skills/flow/SKILL.md). Applied once at
// init so state.json shows what actually runs and the orchestrator never has
// to recompute it per stage.
export const SPEED_TABLE = {
  fast: { model: 'swe-1-7-lightning', judge: 'gemini-3-7-flash-high', effort: 'low', loopCap: 1 },
  balanced: { model: 'claude-sonnet-5-high', effort: 'medium' },
  quality: { model: 'claude-opus-5-max', effort: 'max' },
};
const JUDGES = new Set(['tester', 'critic']);

const iso = (now) => new Date(now ?? Date.now()).toISOString();

// Stages a size drops, from the flow's optional `sizes` field:
//   "sizes": { "tiny": { "skip": ["think", "analyze"] }, "small": { "skip": ["think"] } }
// Unknown ids are ignored; a stage with an onFail loop or a gate the user must
// answer is never dropped (sizing only removes preparation, never judgement).
export function sizeSkips(flow, size) {
  const spec = flow && flow.sizes && flow.sizes[size];
  if (!spec || !Array.isArray(spec.skip)) return [];
  const byId = new Map((flow.stages || []).map((s) => [s.id, s]));
  return spec.skip.filter((id) => {
    const s = byId.get(id);
    return s && !s.onFail && !s.runOnlyWhenJumpedTo;
  });
}

export function initState(flow, opts = {}) {
  const {
    task = '', taskRaw, project = '', gateMode = flow.defaultGate || 'terminal',
    speed = '', size = 'full', skip = [], now,
  } = opts;
  const t = iso(now);
  const row = SPEED_TABLE[speed] || null;
  const dropped = new Set([...sizeSkips(flow, size), ...skip]);
  const stages = (flow.stages || []).map((s) => {
    const st = {
      id: s.id, title: s.title || s.id, titleAr: s.titleAr || s.title || s.id,
      agent: s.agent || null, status: 'pending', startedAt: null, endedAt: null,
      artifact: s.artifact || '', note: '', noteAr: '',
    };
    let model = s.model || null, effort = s.effort || null, maxLoops = s.onFail ? (Number(s.maxLoops) || 3) : null;
    if (row && s.agent) {
      model = (row.judge && JUDGES.has(s.agent)) ? row.judge : row.model;
      effort = row.effort;
      if (row.loopCap && maxLoops) maxLoops = Math.min(maxLoops, row.loopCap);
    }
    if (model) st.model = model;
    if (effort) st.effort = effort;
    if (maxLoops) st.maxLoops = maxLoops;
    if (s.parallel) st.parallel = s.parallel;
    if (s.runOnlyWhenJumpedTo) { st.status = 'skipped'; st.jumpOnly = true; }
    if (dropped.has(s.id) && !s.runOnlyWhenJumpedTo) {
      st.status = 'skipped';
      st.note = `skipped: ${size} task`;
      st.noteAr = `اتخطّت: تاسك ${size === 'tiny' ? 'صغير جدًا' : 'صغير'}`;
    }
    return st;
  });
  const state = {
    flow: flow.name || '', flowTitle: flow.title || flow.name || '', flowTitleAr: flow.titleAr || flow.title || '',
    task, taskRaw: taskRaw ?? task, project, gateMode,
    speed: speed || null, size,
    status: 'running', currentStage: null, startedAt: t, updatedAt: t,
    stages, loops: {}, log: [],
  };
  addLog(state, `flow ${state.flow} started (size ${size}${speed ? `, speed ${speed}` : ''}, gates ${gateMode})`, now);
  const skipped = stages.filter((s) => s.note.startsWith('skipped:')).map((s) => s.id);
  if (skipped.length) addLog(state, `sizing ${size}: skipped ${skipped.join(', ')}`, now);
  return state;
}

export function addLog(state, msg, now) {
  if (!msg) return state;
  state.log = Array.isArray(state.log) ? state.log : [];
  state.log.push({ t: iso(now), msg: String(msg).replace(/\s+/g, ' ').trim().slice(0, 400) });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  state.updatedAt = iso(now);
  return state;
}

function findStage(state, id) {
  const st = (state.stages || []).find((s) => s.id === id);
  if (!st) throw new Error(`unknown stage "${id}" (have: ${(state.stages || []).map((s) => s.id).join(', ')})`);
  return st;
}

// The flow-level status and currentStage follow from the stages: a waiting
// gate anywhere wins, then any running stage, else the run stays "running"
// between stages. Terminal flow states are only set by setFlow().
function settle(state) {
  if (['done', 'failed', 'stopped'].includes(state.status)) return state;
  const waiting = state.stages.find((s) => s.status === 'waiting_gate');
  const running = state.stages.filter((s) => s.status === 'running');
  state.status = waiting ? 'waiting_gate' : 'running';
  const cur = waiting || (running.find((s) => s.id === state.currentStage)) || running[0];
  state.currentStage = cur ? cur.id : null;
  return state;
}

export function setStage(state, id, status, { note, noteAr, now } = {}) {
  if (!STAGE_STATUSES.includes(status)) throw new Error(`bad stage status "${status}" (use ${STAGE_STATUSES.join('|')})`);
  const st = findStage(state, id);
  const t = iso(now);
  if (status === 'running' && st.status !== 'running' && st.status !== 'waiting_gate') { st.startedAt = t; st.endedAt = null; }
  if (status === 'pending') { st.startedAt = null; st.endedAt = null; }
  if (['done', 'failed', 'skipped'].includes(status)) st.endedAt = t;
  st.status = status;
  if (note !== undefined) st.note = String(note);
  if (noteAr !== undefined) st.noteAr = String(noteAr);
  // A stage that starts (again) is where the run is; resuming from a stopped
  // or failed run brings the flow back to life.
  if (status === 'running' || status === 'waiting_gate') {
    if (state.status !== 'done') state.status = status === 'waiting_gate' ? 'waiting_gate' : 'running';
    state.currentStage = id;
  }
  state.updatedAt = t;
  return settle(state);
}

// Increments the loop counter of an onFail stage. `exceeded` tells the
// orchestrator to fail the flow instead of jumping again.
export function bumpLoop(state, id, now) {
  const st = findStage(state, id);
  state.loops = state.loops || {};
  const n = (Number(state.loops[id]) || 0) + 1;
  state.loops[id] = n;
  state.updatedAt = iso(now);
  const max = Number(st.maxLoops) || 3;
  return { count: n, max, exceeded: n > max };
}

export function setFlow(state, status, now) {
  if (!FLOW_STATUSES.includes(status)) throw new Error(`bad flow status "${status}" (use ${FLOW_STATUSES.join('|')})`);
  state.status = status;
  if (status === 'done') state.currentStage = null;
  if (status === 'running' || status === 'waiting_gate') settle(state);
  state.updatedAt = iso(now);
  return state;
}

export function skipStages(state, ids, reason, now) {
  for (const id of ids) {
    const st = findStage(state, id);
    st.status = 'skipped';
    st.endedAt = iso(now);
    if (reason) st.note = `skipped: ${reason}`;
  }
  state.updatedAt = iso(now);
  return settle(state);
}

const SETTABLE = new Set(['task', 'taskRaw', 'gateMode', 'size', 'speed']);
export function setField(state, key, value, now) {
  if (!SETTABLE.has(key)) throw new Error(`cannot set "${key}" (settable: ${[...SETTABLE].join(', ')})`);
  state[key] = value;
  state.updatedAt = iso(now);
  return state;
}

// One line per stage: the cheapest way for the orchestrator (or a human) to
// see where the run is without reading the JSON.
export function summary(state) {
  const icon = { pending: '·', running: '▶', waiting_gate: '?', done: '✓', failed: '✗', skipped: '–' };
  const head = `${state.flow} [${state.status}] size=${state.size || 'full'}${state.speed ? ` speed=${state.speed}` : ''} gates=${state.gateMode}`
    + (state.currentStage ? ` at=${state.currentStage}` : '');
  const rows = (state.stages || []).map((s) => {
    const loops = state.loops && state.loops[s.id] ? ` loops=${state.loops[s.id]}/${s.maxLoops || 3}` : '';
    const model = s.agent ? ` ${s.agent}${s.model ? `:${s.model}` : ''}${s.effort ? `/${s.effort}` : ''}` : ' script';
    return `  ${icon[s.status] || '?'} ${s.id}${model}${s.parallel ? ` ||${s.parallel}` : ''}${loops}${s.note ? ` - ${s.note}` : ''}`;
  });
  return [head, ...rows].join('\n');
}

// ---------- I/O ----------

export const statePath = (project) => path.join(project, '.workbench', 'state.json');

export function readState(project) {
  const raw = fs.readFileSync(statePath(project), 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

// Atomic: the dashboard polls this file every 1.5s and must never see a torn
// write. rename() replaces the target in one step on every OS Node supports;
// on Windows a reader holding the file open can make it fail briefly (EPERM),
// so retry a few times before falling back to a direct write.
export function writeState(project, state) {
  const file = statePath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(file), 'artifacts'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(tmp, file); return file; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) { /* brief spin: a sync CLI has nothing else to do */ }
    }
  }
  fs.writeFileSync(file, fs.readFileSync(tmp, 'utf8'), 'utf8');
  fs.rmSync(tmp, { force: true });
  return file;
}

// Reads and empties .workbench/inbox.md in one step (returns '' when empty).
export function drainInbox(project) {
  const file = path.join(project, '.workbench', 'inbox.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  if (text) fs.writeFileSync(file, '', 'utf8');
  return text;
}
