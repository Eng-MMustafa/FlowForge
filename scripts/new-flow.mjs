// new-flow.mjs - Scaffold a new flow JSON in the flows/ directory of the workbench.
// Usage: node new-flow.mjs <name> [title]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = process.argv[2];
const TITLE = process.argv[3] || NAME;

if (!NAME || !/^[a-z0-9][a-z0-9-]*$/.test(NAME)) {
  console.error(`Flow name must be lowercase letters/digits/hyphens (got '${NAME || ''}')`);
  process.exit(1);
}

const flowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flows');
fs.mkdirSync(flowsDir, { recursive: true });
const target = path.join(flowsDir, `${NAME}.json`);
if (fs.existsSync(target)) {
  console.error(`Flow already exists: ${target}`);
  process.exit(1);
}

const template = {
  name: NAME,
  title: TITLE,
  description: 'Describe what this flow does.',
  defaultGate: 'terminal',
  stages: [
    {
      id: 'step-1',
      title: 'Step one',
      agent: 'analyst',
      prompt: "Describe exactly what this stage's agent must do for the project at {PROJECT}. Task: {TASK}",
      pre: [],
      post: [],
      gate: 'auto',
      artifact: 'step-1.md',
      done: ['step-1.md exists and covers the requested output'],
    },
    {
      id: 'step-2',
      title: 'Step two (gated)',
      agent: 'coder',
      prompt: 'Second stage instruction for {PROJECT}.',
      pre: [],
      post: [],
      gate: 'default',
      gateQuestion: 'Continue after step-2?',
      artifact: 'step-2.md',
      done: ['step-2.md exists'],
    },
  ],
};

fs.writeFileSync(target, JSON.stringify(template, null, 2) + '\n', 'utf8');
console.log(`OK: created ${target}`);
console.log(`Edit the stages, then run it with: /flow ${NAME} "<task>"`);
