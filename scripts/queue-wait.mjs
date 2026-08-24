// queue-wait.mjs - Daemon-mode queue listener.
// Blocks until the dashboard enqueues a run request in .workbench/queue.json,
// refreshing a heartbeat file so the dashboard can show the daemon as alive.
// Output/exit contract (consumed by the flow-daemon skill):
//   exit 0 + line `TASK: {json}`  -> a run request arrived (queue consumed)
//   exit 2 + line `STOP`          -> the dashboard asked the daemon to stop
//   exit 3 + line `IDLE`          -> timeout elapsed with no work (loop again)
// Usage: node queue-wait.mjs "C:\path\to\project" [timeoutSec]
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = path.resolve(process.argv[2] || '.');
const TIMEOUT_SEC = Number(process.argv[3] || 3300);
const POLL_MS = 2000;

const wbDir = path.join(PROJECT, '.workbench');
fs.mkdirSync(wbDir, { recursive: true });
const queueFile = path.join(wbDir, 'queue.json');
const heartbeatFile = path.join(wbDir, 'daemon.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function beat(status) {
  try {
    fs.writeFileSync(heartbeatFile, JSON.stringify({
      aliveAt: new Date().toISOString(), pid: process.pid, status,
    }, null, 2), 'utf8');
  } catch {}
}

function readQueue() {
  try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch { return null; }
}

function clearQueue() {
  try { fs.writeFileSync(queueFile, JSON.stringify({ pending: null, stop: false }, null, 2), 'utf8'); } catch {}
}

console.log(`QUEUE: listening for dashboard run requests (timeout ${TIMEOUT_SEC}s)...`);
beat('listening');

const deadline = Date.now() + TIMEOUT_SEC * 1000;
while (Date.now() < deadline) {
  const q = readQueue();
  if (q && q.stop === true) {
    clearQueue();
    beat('stopped');
    console.log('STOP');
    process.exit(2);
  }
  if (q && q.pending && q.pending.flow) {
    const task = q.pending;
    clearQueue();
    beat('working');
    console.log('TASK: ' + JSON.stringify(task));
    process.exit(0);
  }
  beat('listening');
  await sleep(POLL_MS);
}

beat('idle-restart');
console.log('IDLE');
process.exit(3);
