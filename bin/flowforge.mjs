#!/usr/bin/env node
// The `flowforge` / `ff` command. A thin dispatcher: scripts/lib/cli.mjs
// decides what the arguments mean (`flowforge help` lists it all), and the
// chosen script then runs inside THIS process - one Node start, not two.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCli, helpText } from '../scripts/lib/cli.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const cmd = parseCli(process.argv.slice(2), { cwd: process.cwd(), root: ROOT });

if (cmd.kind === 'help') console.log(helpText(version()));
else if (cmd.kind === 'where') console.log(ROOT);
else if (cmd.kind === 'version') console.log(version());
else if (cmd.kind === 'error') { console.error(cmd.message); process.exit(1); }
else {
  // The scripts (and the server start.mjs spawns) expect the install folder as
  // their working directory. Move there only now: parseCli has already
  // resolved the user's own paths against the folder they are standing in.
  const script = path.join(ROOT, ...cmd.script.split('/'));
  process.chdir(ROOT);
  process.argv = [process.execPath, script, ...cmd.args];
  await import(pathToFileURL(script).href);
}
