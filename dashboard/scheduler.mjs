// scheduler.mjs - the queue of tasks waiting for an executor and the timetable
// of repeating jobs. Pure decisions here (what is due, what may start next);
// the server supplies "how to start a run" and reports how runs ended.
//
// Queue item:    { id, project, flow, task, gates, speed, status, createdAt,
//                  scheduleId?, runId?, startedAt?, endedAt?, exitCode?, error? }
//                status: queued | running | done | failed | cancelled
// Schedule:      { id, project, flow, task, gates, speed, enabled, repeat,
//                  nextAt, lastAt, lastStatus, createdAt }
// repeat:        { kind: 'once', at: ISO }
//              | { kind: 'hours', every: n }
//              | { kind: 'daily', at: 'HH:MM' }
//              | { kind: 'weekly', days: [0..6], at: 'HH:MM' }   (0 = Sunday)
// Times of day are the machine's local time - what the user sees on the clock.
import fs from 'node:fs/promises';

const QUEUE_KEEP = 300;
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function parseHm(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? [h, mi] : null;
}

// The next moment strictly after `fromMs` at which `repeat` fires, or null
// when it never will again.
export function nextRunAt(repeat, fromMs = Date.now()) {
  if (!repeat || typeof repeat !== 'object') return null;
  if (repeat.kind === 'once') {
    const t = Date.parse(repeat.at || '');
    return Number.isFinite(t) && t > fromMs ? t : null;
  }
  if (repeat.kind === 'hours') {
    const every = Number(repeat.every);
    if (!(every > 0)) return null;
    return fromMs + Math.round(every * 3600 * 1000);
  }
  const hm = parseHm(repeat.at);
  if (!hm) return null;
  const from = new Date(fromMs);
  if (repeat.kind === 'daily') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hm[0], hm[1], 0, 0);
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (repeat.kind === 'weekly') {
    const days = [...new Set((repeat.days || []).map(Number).filter((x) => x >= 0 && x <= 6))];
    if (!days.length) return null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hm[0], hm[1], 0, 0);
      if (days.includes(d.getDay()) && d.getTime() > fromMs) return d.getTime();
    }
  }
  return null;
}

export function describeRepeat(repeat) {
  if (!repeat) return '';
  if (repeat.kind === 'once') return `once at ${repeat.at}`;
  if (repeat.kind === 'hours') return `every ${repeat.every} h`;
  if (repeat.kind === 'daily') return `daily at ${repeat.at}`;
  if (repeat.kind === 'weekly') return `weekly (${(repeat.days || []).join(',')}) at ${repeat.at}`;
  return '';
}

// Which queued item may start now: first in line whose project has no active
// run, while fewer than `maxParallel` runs are active. One run per project
// because each project has exactly one state.json.
export function pickNext(queue, { activeProjects, activeCount, maxParallel }) {
  if (activeCount >= maxParallel) return null;
  const busy = new Set([...activeProjects].map((p) => norm(p)));
  return queue.find((q) => q.status === 'queued' && !busy.has(norm(q.project))) || null;
}
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

export function dueSchedules(schedules, nowMs = Date.now()) {
  return schedules.filter((s) => s.enabled && typeof s.nextAt === 'number' && s.nextAt <= nowMs);
}

// Persisted queue + schedules. Everything survives a dashboard restart; a
// run that was in progress when the process died is reported as failed.
export class JobStore {
  constructor({ queueFile, schedulesFile }) {
    this.queueFile = queueFile;
    this.schedulesFile = schedulesFile;
    this.queue = [];
    this.schedules = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    const read = async (f) => { try { const v = JSON.parse(await fs.readFile(f, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
    this.queue = await read(this.queueFile);
    this.schedules = await read(this.schedulesFile);
    for (const q of this.queue) {
      if (q.status === 'running') { q.status = 'failed'; q.error = 'dashboard restarted while the run was in progress'; q.endedAt = q.endedAt || new Date().toISOString(); }
    }
    for (const s of this.schedules) if (s.enabled && typeof s.nextAt !== 'number') s.nextAt = nextRunAt(s.repeat);
    this.loaded = true;
    return this;
  }

  async save() {
    this.queue = this.queue.slice(-QUEUE_KEEP);
    const write = async (f, v) => { try { await fs.writeFile(f, JSON.stringify(v, null, 1), 'utf8'); } catch { /* read-only install */ } };
    await Promise.all([write(this.queueFile, this.queue), write(this.schedulesFile, this.schedules)]);
  }

  enqueue(spec) {
    const item = {
      id: newId(), project: spec.project, flow: spec.flow, task: String(spec.task || '').trim(),
      gates: spec.gates || 'dashboard', speed: spec.speed || '', status: 'queued',
      createdAt: new Date().toISOString(), scheduleId: spec.scheduleId || null,
    };
    this.queue.push(item);
    return item;
  }

  cancel(id) {
    const q = this.queue.find((x) => x.id === id);
    if (!q || q.status !== 'queued') return false;
    q.status = 'cancelled';
    q.endedAt = new Date().toISOString();
    return true;
  }

  // Move a queued item before another queued item (or to the end).
  reorder(id, beforeId = null) {
    const i = this.queue.findIndex((x) => x.id === id && x.status === 'queued');
    if (i === -1) return false;
    const [item] = this.queue.splice(i, 1);
    const j = beforeId ? this.queue.findIndex((x) => x.id === beforeId) : -1;
    if (j === -1) this.queue.push(item); else this.queue.splice(j, 0, item);
    return true;
  }

  addSchedule(spec) {
    const repeat = spec.repeat || {};
    const nextAt = nextRunAt(repeat);
    if (nextAt === null) throw new Error('repeat never fires - check the time or the days');
    const s = {
      id: newId(), project: spec.project, flow: spec.flow, task: String(spec.task || '').trim(),
      gates: spec.gates || 'auto', speed: spec.speed || '', enabled: spec.enabled !== false, repeat,
      nextAt, lastAt: null, lastStatus: null, createdAt: new Date().toISOString(),
    };
    this.schedules.push(s);
    return s;
  }

  updateSchedule(id, patch) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    if (patch.repeat || patch.enabled) s.nextAt = nextRunAt(s.repeat);
    if (s.enabled && s.nextAt === null) s.enabled = false;
    return s;
  }

  removeSchedule(id) {
    const n = this.schedules.length;
    this.schedules = this.schedules.filter((x) => x.id !== id);
    return this.schedules.length !== n;
  }

  // A due schedule becomes a queue item, unless its previous item is still
  // waiting or running (a job must not pile up behind itself).
  fireDue(nowMs = Date.now()) {
    const fired = [];
    for (const s of dueSchedules(this.schedules, nowMs)) {
      const pending = this.queue.some((q) => q.scheduleId === s.id && (q.status === 'queued' || q.status === 'running'));
      if (!pending) fired.push(this.enqueue({ ...s, scheduleId: s.id }));
      s.lastAt = new Date(nowMs).toISOString();
      s.nextAt = nextRunAt(s.repeat, nowMs);
      if (s.nextAt === null) s.enabled = false;
    }
    return fired;
  }

  markStarted(id, runId) {
    const q = this.queue.find((x) => x.id === id);
    if (q) Object.assign(q, { status: 'running', runId, startedAt: new Date().toISOString() });
  }

  markEnded(id, exitCode, error = null) {
    const q = this.queue.find((x) => x.id === id);
    if (!q) return;
    Object.assign(q, { status: exitCode === 0 ? 'done' : 'failed', exitCode, error, endedAt: new Date().toISOString() });
    const s = q.scheduleId && this.schedules.find((x) => x.id === q.scheduleId);
    if (s) s.lastStatus = q.status;
  }
}
