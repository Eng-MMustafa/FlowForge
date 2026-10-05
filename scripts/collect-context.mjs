// collect-context.mjs - Gather deterministic project facts (no AI) into .workbench/artifacts/context.md
// Usage: node collect-context.mjs "<path to project>" [--force]
// Cached: the file records a fingerprint of the project (git HEAD + working
// tree status, or the top-level listing outside git). When nothing changed
// since the last run the existing context.md is kept and the script returns
// at once - the pipeline's first stage no longer pays for a full tree walk
// on every run. --force rebuilds regardless.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_VERSION = 1; // bump when the context.md layout changes
const PROJECT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || '.');
const FORCE = process.argv.includes('--force');
const MAX_TREE = 400;
const TREE_DEPTH = 4;
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.workbench',
  'bin', 'obj', '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv', 'target']);

if (!fs.existsSync(PROJECT)) { console.error(`Project not found: ${PROJECT}`); process.exit(1); }
const artifactsDir = path.join(PROJECT, '.workbench', 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const lines = [];
const put = (s = '') => lines.push(s);

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: PROJECT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  } catch { return null; }
}

// ---- Cache check ----
const outFile = path.join(artifactsDir, 'context.md');
const inGit = git('rev-parse --is-inside-work-tree') === 'true';
function fingerprint() {
  const h = crypto.createHash('sha1').update(`v${CACHE_VERSION}\n${PROJECT}\n`);
  if (inGit) {
    h.update(git('rev-parse HEAD') || 'no-head');
    // .workbench/ is FlowForge's own scratch space - its churn is not a project change.
    h.update((git('status --porcelain') || '').split('\n').filter((l) => !l.includes('.workbench/')).join('\n'));
  } else {
    try {
      for (const e of fs.readdirSync(PROJECT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (EXCLUDE.has(e.name)) continue;
        const st = fs.statSync(path.join(PROJECT, e.name));
        h.update(`${e.name}:${st.size}:${Math.round(st.mtimeMs)}\n`);
      }
    } catch { h.update(String(Date.now())); }
  }
  return h.digest('hex').slice(0, 16);
}
const FP = fingerprint();
if (!FORCE) {
  try {
    const prev = fs.readFileSync(outFile, 'utf8');
    if (prev.includes(`- Fingerprint: ${FP}\n`)) {
      console.log(`OK: ${outFile} is up to date (cached, fingerprint ${FP})`);
      process.exit(0);
    }
  } catch { /* no previous context - build it */ }
}

put('# Project context (auto-generated)');
put('');
put(`- Project: ${PROJECT}`);
put(`- Generated: ${new Date().toISOString()}`);
put(`- Fingerprint: ${FP}`);
put('');

// ---- Git ----
put('## Git');
if (inGit) {
  put('```');
  put(`branch: ${git('rev-parse --abbrev-ref HEAD') || '?'}`);
  put('');
  put('--- status (short) ---');
  put((git('status --short') || '(clean)').split('\n').slice(0, 100).join('\n'));
  put('');
  put('--- last 15 commits ---');
  put(git('log --oneline -15') || '(no commits)');
  put('');
  put('--- uncommitted diff stat ---');
  put((git('diff --stat') || '(none)').split('\n').slice(0, 60).join('\n'));
  put('```');
} else {
  put('Not a git repository.');
}
put('');

// ---- File tree (bounded) ----
put(`## File tree (depth ${TREE_DEPTH}, excluding: ${[...EXCLUDE].join(', ')})`);
put('```');
let count = 0;
function walk(dir, depth, prefix) {
  if (depth > TREE_DEPTH || count >= MAX_TREE) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (count >= MAX_TREE) return;
    if (EXCLUDE.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      put(`${rel}/`); count++;
      walk(path.join(dir, e.name), depth + 1, rel);
    } else {
      put(rel); count++;
    }
  }
}
walk(PROJECT, 1, '');
if (count >= MAX_TREE) put(`... (truncated at ${MAX_TREE} entries)`);
put('```');
put('');

// ---- Manifests ----
put('## Manifests');
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'composer.json', 'pom.xml', 'build.gradle', 'Gemfile', 'tsconfig.json', '.nvmrc', 'Dockerfile', 'docker-compose.yml']);
const found = [];
function findManifests(dir, depth) {
  if (depth > 3 || found.length >= 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (found.length >= 12) return;
    if (e.isDirectory()) { if (!EXCLUDE.has(e.name)) findManifests(path.join(dir, e.name), depth + 1); }
    else if (MANIFESTS.has(e.name)) found.push(path.join(dir, e.name));
  }
}
findManifests(PROJECT, 1);
if (!found.length) put('No standard manifests found.');
for (const file of found) {
  const rel = path.relative(PROJECT, file);
  put('');
  put(`### ${rel}`);
  put('```');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'package.json') {
      const pkg = JSON.parse(raw);
      const slim = {};
      for (const k of ['name', 'version', 'scripts', 'dependencies', 'devDependencies', 'engines']) {
        if (pkg[k] !== undefined) slim[k] = pkg[k];
      }
      put(JSON.stringify(slim, null, 2));
    } else {
      put(raw.split('\n').slice(0, 120).join('\n').trimEnd());
    }
  } catch (e) { put(`(unreadable: ${e.message})`); }
  put('```');
}
put('');

// ---- README head ----
for (const name of ['README.md', 'README.txt', 'README.rst', 'readme.md', 'README']) {
  const f = path.join(PROJECT, name);
  if (fs.existsSync(f)) {
    put('## README (first 60 lines)');
    put('```');
    try { put(fs.readFileSync(f, 'utf8').split('\n').slice(0, 60).join('\n').trimEnd()); } catch {}
    put('```');
    break;
  }
}

fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(`OK: wrote ${outFile} (${count} tree entries)`);
