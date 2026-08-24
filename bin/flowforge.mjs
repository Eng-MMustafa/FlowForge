#!/usr/bin/env node
// The `flowforge` command. Thin, dependency-free wrapper over the workbench
// scripts so the tool can be installed globally or run straight from npx.
//
//   flowforge                  start the dashboard on the current folder
//   flowforge <project path>   start it on that project
//   flowforge install          wire skills/agents into Devin
//   flowforge uninstall        remove that wiring
//   flowforge test             run the test suite
//   flowforge where            print where the workbench lives
//
// Any other flag (--port=, --no-open, --check) is passed through to start.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const cmd = argv[0];

const exec = (script, args = []) => {
  const child = spawn(process.execPath, [path.join(ROOT, ...script), ...args],
    { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 0));
};

if (cmd === 'help' || argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  FlowForge - staged AI engineering pipelines

    flowforge                    start the dashboard on the current folder
    flowforge <project path>     start it on that project
    flowforge install            wire skills and agents into Devin
    flowforge uninstall          remove that wiring
    flowforge test               run the test suite
    flowforge where              print the install folder

  Flags passed to the dashboard: --port=4820  --no-open  --check
`);
  process.exit(0);
}

if (cmd === 'where') { console.log(ROOT); process.exit(0); }
if (cmd === 'install') exec(['install.mjs'], argv.slice(1));
else if (cmd === 'uninstall') exec(['uninstall.mjs'], argv.slice(1));
else if (cmd === 'test') exec(['dashboard', 'test', 'run-tests.mjs'], argv.slice(1));
else {
  // Default: run the dashboard. With no path argument, the folder the user is
  // standing in becomes the project - that is the whole point of a global CLI.
  const args = [...argv];
  if (!args.some((a) => !a.startsWith('--'))) {
    const cwd = process.cwd();
    if (cwd !== ROOT && fs.existsSync(cwd)) args.unshift(cwd);
  }
  exec(['start.mjs'], args);
}
