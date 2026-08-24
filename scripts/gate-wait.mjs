// gate-wait.mjs - Dashboard gate: publish an approval request in .workbench/commands.json and wait for the answer.
// The dashboard shows Approve/Reject buttons and writes the response into the same file.
// Exit codes: 0 = approved, 2 = rejected, 3 = timeout.
// Usage: node gate-wait.mjs "C:\path\to\project" <stage> [question] [questionAr] [timeoutSec]
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = path.resolve(process.argv[2] || '.');
const STAGE = process.argv[3];
const QUESTION = process.argv[4] || '';
const QUESTION_AR = process.argv[5] || '';
const TIMEOUT_SEC = Number(process.argv[6] || 900);
const POLL_MS = 2000;

if (!STAGE) { console.error('Usage: node gate-wait.mjs <project> <stage> [question] [questionAr] [timeoutSec]'); process.exit(1); }
const wbDir = path.join(PROJECT, '.workbench');
fs.mkdirSync(wbDir, { recursive: true });
const cmdFile = path.join(wbDir, 'commands.json');

const requestedAt = new Date().toISOString();
fs.writeFileSync(cmdFile, JSON.stringify({
  gate: { stage: STAGE, question: QUESTION, questionAr: QUESTION_AR, requestedAt },
  response: null,
}, null, 2), 'utf8');
console.log(`GATE: waiting for decision on stage '${STAGE}' (timeout ${TIMEOUT_SEC}s). Approve from the dashboard.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + TIMEOUT_SEC * 1000;

function clearFile() {
  try { fs.writeFileSync(cmdFile, JSON.stringify({ gate: null, response: null }, null, 2), 'utf8'); } catch {}
}

while (Date.now() < deadline) {
  await sleep(POLL_MS);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(cmdFile, 'utf8')); } catch { continue; } // mid-write; retry
  const resp = doc && doc.response;
  if (resp && resp.stage === STAGE && resp.at && Date.parse(resp.at) >= Date.parse(requestedAt)) {
    clearFile();
    console.log(`DECISION: ${resp.decision}`);
    if (resp.note) console.log(`NOTE: ${resp.note}`);
    process.exit(resp.decision === 'approve' ? 0 : 2);
  }
}

clearFile();
console.log('DECISION: timeout');
process.exit(3);
