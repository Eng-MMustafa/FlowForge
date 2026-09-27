// CLI parser for the `flowforge` / `ff` dispatcher (bin/flowforge.mjs).
// Zero dependencies (node builtins only).
//
// ONE command table drives both the parser and the help screen, so a command
// can never be runnable but undocumented (or documented but unknown).
//
// parseCli takes the arguments, the user's folder and the install root as
// parameters - it never reads process.argv or process.cwd() itself - so the
// test suite can check every branch without spawning anything.
import fs from 'node:fs';
import path from 'node:path';

// `script` is relative to the install root, `/`-separated. Commands without a
// script are answered by the bin itself and load nothing else.
export const COMMANDS = [
  { name: 'start', aliases: [], usage: '[path]', script: 'start.mjs', does: 'start the dashboard (the default)' },
  { name: 'install', aliases: [], usage: '[--force]', script: 'install.mjs', does: 'wire skills and agents into Devin' },
  { name: 'uninstall', aliases: [], script: 'uninstall.mjs', does: 'remove that wiring' },
  { name: 'test', aliases: [], script: 'dashboard/test/run-tests.mjs', does: 'run the test suite' },
  { name: 'status', aliases: ['check'], script: 'start.mjs', args: ['--check'], does: 'print the install state as JSON and exit' },
  { name: 'where', aliases: [], does: 'print the install folder' },
  { name: 'version', aliases: ['-v', '--version'], does: 'print the version' },
  { name: 'help', aliases: ['-h', '--help'], does: 'show this help' },
];

const isDir0 = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Plain Levenshtein distance - only ever run on one short word against a
// handful of command names, so the simple O(n*m) table is plenty.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// A mistyped command looks exactly like a missing folder; naming the closest
// command turns "not found" into the fix. Flag-style aliases are never offered.
export function suggestCommand(word) {
  const w = String(word).toLowerCase();
  let best = null, bestD = 3;
  for (const c of COMMANDS) {
    for (const n of [c.name, ...c.aliases].filter((x) => !x.startsWith('-'))) {
      const d = editDistance(w, n);
      if (d < bestD) { best = n; bestD = d; }
    }
  }
  return best;
}

const find = (word) => COMMANDS.find((c) => c.name === word || c.aliases.includes(word));

// The start command: `-p N` / `--port N` become the `--port=N` start.mjs
// understands, and the project path is resolved HERE against the user's own
// folder - start.mjs later runs from the install root and would resolve a
// relative path against that instead. A missing folder fails before start.mjs
// loads, i.e. before it can touch the Devin wiring or open a browser.
function parseStart(rest, { cwd, root, isDir }) {
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-p' || a === '--port') {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) { args.push(`--port=${next}`); i++; continue; }
      if (a === '-p') return { kind: 'error', message: 'missing port number after -p (e.g. -p 5000)' };
    }
    args.push(a);
  }
  const at = args.findIndex((a) => !a.startsWith('--'));
  if (at === -1) {
    if (cwd !== root && isDir(cwd)) args.unshift(cwd);
    return { kind: 'run', script: 'start.mjs', args };
  }
  const abs = path.resolve(cwd, args[at]);
  if (!isDir(abs)) {
    const hint = suggestCommand(args[at]);
    return {
      kind: 'error',
      message: `project folder not found: ${abs}\n`
        + (hint ? `did you mean "${hint}"?` : 'pass an existing folder, or none at all to use the current one.'),
    };
  }
  args[at] = abs;
  return { kind: 'run', script: 'start.mjs', args };
}

// Returns {kind:'help'|'where'|'version'}, {kind:'run', script, args} or
// {kind:'error', message}. Help wins wherever it appears, as it always has -
// `flowforge install --help` shows this help rather than installing.
export function parseCli(argv, { cwd, root, isDir = isDir0 }) {
  if (argv.includes('-h') || argv.includes('--help')) return { kind: 'help' };
  const cmd = argv.length ? find(argv[0]) : null;
  if (!cmd || cmd.name === 'start') return parseStart(cmd ? argv.slice(1) : argv, { cwd, root, isDir });
  if (!cmd.script) return { kind: cmd.name };
  return { kind: 'run', script: cmd.script, args: [...(cmd.args || []), ...argv.slice(1)] };
}

// One short screen, generated from COMMANDS.
export function helpText(version) {
  const label = (c) => [c.name, ...c.aliases].join(', ') + (c.usage ? ` ${c.usage}` : '');
  const width = Math.max(...COMMANDS.map((c) => label(c).length)) + 2;
  return [
    `FlowForge ${version} - staged AI engineering pipelines`,
    '',
    'Usage: flowforge [command] [path] [flags]     (ff is the same command)',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${label(c).padEnd(width)}${c.does}`),
    '',
    'Flags: --port=N | -p N   --no-open   --check',
    'No path = this folder. Paths are relative to it; use ./<name> for a folder',
    'named like a command.',
    '',
    'Examples:',
    '  ff                   start on the current folder',
    '  ff ../api -p 5000    start on ../api, port 5000',
    '  ff status            is FlowForge wired into Devin?',
  ].join('\n');
}
