// state.mjs - the orchestrator's one-line way to update .workbench/state.json.
//
//   node state.mjs <PROJECT> <command> [args] [--flags] [+ <command> ...]
//
// Several commands joined with a lone `+` run in ONE process and ONE atomic
// write - a whole transition (finish a stage, start the next, log it) is a
// single tool call:
//
//   node state.mjs P stage code done --note "3 files" --note-ar "3 ملفات" + stage test running --log "tester started"
//
// Commands:
//   init <flow-name|flow.json> --task "..." [--raw "..."] [--gate=M] [--speed=S] [--size=tiny|small|full] [--skip=a,b]
//   stage <id> <pending|running|waiting_gate|done|failed|skipped> [--note "..."] [--note-ar "..."]
//   loop <id>              count one more onFail loop; prints LOOP id n/max (EXCEEDED when over maxLoops)
//   flow <running|waiting_gate|done|failed|stopped>
//   skip <id[,id...]> [--reason "..."]
//   set <task|taskRaw|gateMode|size|speed> <value>
//   log "<message>"
//   inbox                  print and empty .workbench/inbox.md (logged)
//   show                   one line per stage
// Any command also takes --log "<message>" to append a log line.
// Exit: 0 ok, 1 usage/state error (nothing is written on error).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib/state.mjs';

const WORKBENCH = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const die = (msg) => { console.error(`state.mjs: ${msg}`); process.exit(1); };

export function parseOps(argv) {
  const ops = [];
  let cur = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '+') { cur = null; continue; }
    if (!cur) { cur = { cmd: a, args: [], flags: {} }; ops.push(cur); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) cur.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && argv[i + 1] !== '+' && !argv[i + 1].startsWith('--')) cur.flags[a.slice(2)] = argv[++i];
      else cur.flags[a.slice(2)] = true;
    } else cur.args.push(a);
  }
  return ops;
}

function resolveFlowFile(ref) {
  if (!ref) die('init needs a flow name or file');
  const direct = path.resolve(ref);
  if (/\.json$/i.test(ref) && fs.existsSync(direct)) return direct;
  const named = path.join(WORKBENCH, 'flows', `${String(ref).replace(/\.json$/i, '')}.json`);
  if (fs.existsSync(named)) return named;
  die(`flow not found: ${ref}`);
}

// Applies the ops to a state object; returns { state, out[] }.
export function applyOps(project, state, ops, now) {
  const out = [];
  for (const op of ops) {
    const f = op.flags;
    switch (op.cmd) {
      case 'init': {
        const file = resolveFlowFile(op.args[0]);
        const flow = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const size = S.SIZES.includes(f.size) ? f.size : 'full';
        state = S.initState(flow, {
          task: typeof f.task === 'string' ? f.task : '', taskRaw: typeof f.raw === 'string' ? f.raw : undefined,
          project, gateMode: typeof f.gate === 'string' ? f.gate : undefined,
          speed: typeof f.speed === 'string' && S.SPEED_TABLE[f.speed] ? f.speed : '',
          size, skip: typeof f.skip === 'string' ? f.skip.split(',').map((x) => x.trim()).filter(Boolean) : [], now,
        });
        out.push(S.summary(state));
        break;
      }
      case 'stage': {
        need(state);
        const [id, status] = op.args;
        if (!id || !status) die('usage: stage <id> <status>');
        S.setStage(state, id, status, {
          note: typeof f.note === 'string' ? f.note : undefined,
          noteAr: typeof f['note-ar'] === 'string' ? f['note-ar'] : undefined, now,
        });
        out.push(`${id}=${status}`);
        break;
      }
      case 'loop': {
        need(state);
        const r = S.bumpLoop(state, op.args[0], now);
        out.push(`LOOP ${op.args[0]} ${r.count}/${r.max}${r.exceeded ? ' EXCEEDED' : ''}`);
        break;
      }
      case 'flow': need(state); S.setFlow(state, op.args[0], now); out.push(`flow=${op.args[0]}`); break;
      case 'skip': {
        need(state);
        const ids = String(op.args[0] || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!ids.length) die('usage: skip <id[,id]>');
        S.skipStages(state, ids, typeof f.reason === 'string' ? f.reason : '', now);
        out.push(`skipped ${ids.join(',')}`);
        break;
      }
      case 'set': need(state); S.setField(state, op.args[0], op.args.slice(1).join(' '), now); out.push(`${op.args[0]} set`); break;
      case 'log': need(state); S.addLog(state, op.args.join(' '), now); break;
      case 'inbox': {
        need(state);
        const text = S.drainInbox(project);
        if (text) S.addLog(state, `inbox: ${text.slice(0, 160)}`, now);
        out.push(text ? `INBOX:\n${text}` : 'INBOX: (empty)');
        break;
      }
      case 'show': need(state); out.push(S.summary(state)); break;
      default: die(`unknown command "${op.cmd}" (init|stage|loop|flow|skip|set|log|inbox|show)`);
    }
    if (typeof f.log === 'string') S.addLog(state, f.log, now);
  }
  return { state, out };
}

function need(state) { if (!state) die('no state.json yet - run "init" first'); }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [projectArg, ...rest] = process.argv.slice(2);
  if (!projectArg || !rest.length) die('usage: node state.mjs <PROJECT> <command> [args] [+ <command> ...]');
  const project = path.resolve(projectArg);
  if (!fs.existsSync(project)) die(`project not found: ${project}`);
  const ops = parseOps(rest);
  let state = null;
  if (ops[0].cmd !== 'init') {
    try { state = S.readState(project); } catch (e) { if (e.code !== 'ENOENT') die(`state.json unreadable: ${e.message}`); }
  }
  let res;
  try { res = applyOps(project, state, ops); } catch (e) { die(e.message); }
  const readOnly = ops.every((o) => o.cmd === 'show');
  if (!readOnly) S.writeState(project, res.state);
  const lines = res.out.filter(Boolean);
  console.log(readOnly ? lines.join('\n') : `OK ${lines.join(' | ')}`.replace(/^OK $/, 'OK'));
}
