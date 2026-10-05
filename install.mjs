// install.mjs - Wire the FlowForge workbench into Devin's global config
// (%APPDATA%\devin on Windows, ~/Library/Application Support/devin on macOS,
// ~/.config/devin on Linux - see scripts/lib/platform.mjs).
// Creates directory links so edits in this repo apply live. No admin rights needed.
// Usage: node install.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentConfigDir, agentConfigCandidates, linkType, isLink, removeLink } from './scripts/lib/platform.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes('--force');
const LINK = linkType();

const DEVIN = agentConfigDir();
if (!DEVIN || !fs.existsSync(DEVIN)) {
  console.error(`Devin config directory not found - is Devin installed?`);
  console.error(`  looked in: ${agentConfigCandidates().join(', ')}`);
  console.error('  set DEVIN_CONFIG_DIR if it lives somewhere else.');
  process.exit(1);
}

function installLink(link, target, label) {
  if (fs.existsSync(link) || isLink(link)) {
    let reparse = isLink(link);
    try { reparse = reparse || fs.realpathSync(link) !== path.resolve(link); } catch {}
    if (reparse) {
      removeLink(link); // removes only the link, never target content
      fs.symlinkSync(target, link, LINK);
      console.log(`OK  ${label}: link repointed -> ${target}`);
      return;
    }
    // Real directory: link items individually
    console.log(`INFO ${label}: ${link} is a real directory - linking items individually`);
    for (const name of fs.readdirSync(target)) {
      const childLink = path.join(link, name);
      const childTarget = path.join(target, name);
      if (fs.existsSync(childLink) || isLink(childLink)) {
        let childReparse = isLink(childLink);
        try { childReparse = childReparse || fs.realpathSync(childLink) !== path.resolve(childLink); } catch {}
        if (childReparse) removeLink(childLink);
        else if (FORCE) fs.rmSync(childLink, { recursive: true, force: true });
        else { console.log(`SKIP ${label}: ${name} already exists (use --force to replace)`); continue; }
      }
      if (fs.statSync(childTarget).isDirectory()) {
        fs.symlinkSync(childTarget, childLink, LINK);
        console.log(`OK  ${label}: link ${name}`);
      } else {
        fs.copyFileSync(childTarget, childLink);
        console.log(`OK  ${label}: copied ${name} (file copy - rerun install after edits)`);
      }
    }
    return;
  }
  fs.symlinkSync(target, link, LINK);
  console.log(`OK  ${label}: link created -> ${target}`);
}

// Where the workbench lives differs per machine, so it must NOT be baked into
// the tracked skill files. Every skill reads WORKBENCH from this local config,
// which is rewritten on each install - clone anywhere, install, done.
const LOCATOR = path.join(DEVIN, 'flowforge.json');

function writeLocator() {
  const body = { workbench: REPO, installedAt: new Date().toISOString() };
  fs.writeFileSync(LOCATOR, JSON.stringify(body, null, 2), 'utf8');
  console.log(`OK  locator: ${LOCATOR} -> ${REPO}`);
}

// Older copies hard-coded an absolute path in the skill text. Strip it so a
// shared clone never carries someone else's machine layout.
function stripHardcodedPaths() {
  const stale = /`(?:[A-Za-z]:\\|\/)[^`\n]*?ai-workbench(?=[`\\/])/g;
  const skillsDir = path.join(REPO, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(stale, '`WORKBENCH');
    if (after !== before) { fs.writeFileSync(file, after, 'utf8'); console.log(`OK  skills: removed hard-coded path from ${name}`); }
  }
}

console.log('FlowForge install');
console.log(`  repo:  ${REPO}`);
console.log(`  devin: ${DEVIN}`);
console.log('');

stripHardcodedPaths();
writeLocator();
console.log('');

installLink(path.join(DEVIN, 'skills'), path.join(REPO, 'skills'), 'skills');
installLink(path.join(DEVIN, 'agents'), path.join(REPO, 'agents'), 'agents');

// Verify instead of listing: the doctor checks the links, the locator, every
// skill/agent/flow file and the state engine, and names the fix for anything
// wrong. --quick skips the slow probes (CLI login, dashboard) so install stays
// fast; `ff doctor` runs them all.
console.log('');
const doctor = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'doctor.mjs'), '--quick', '--json'], { cwd: REPO, encoding: 'utf8' });
let checks = [];
try { checks = JSON.parse(doctor.stdout).checks; } catch { console.log('WARN doctor could not run - check with: ff doctor'); }
const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: '    ' };
for (const c of checks) console.log(`${mark[c.status] || '    '} ${c.name}: ${c.detail}${c.status !== 'ok' && c.fix ? `  -> ${c.fix}` : ''}`);
console.log('');
// Only broken wiring fails the install; a damaged custom flow is reported but
// must not make start.mjs believe Devin was never wired.
if (checks.some((c) => c.status === 'fail' && /^(Locator|Link:)/.test(c.name))) {
  console.log('Wiring is incomplete (see above). Re-check any time with: ff doctor');
  process.exit(1);
}
console.log('Done. Start a NEW Devin session and try: /flow, /understand, /flow-status, /flow-resume');
console.log('From a terminal: ff run task "<what to do>"   ·   health check: ff doctor');
