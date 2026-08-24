// install.mjs - Wire the FlowForge workbench into Devin's global config (%APPDATA%\devin).
// Creates directory junctions so edits in this repo apply live. No admin rights needed.
// Usage: node install.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const APPDATA = process.env.APPDATA;
const FORCE = process.argv.includes('--force');

if (!APPDATA) { console.error('APPDATA is not set.'); process.exit(1); }
const DEVIN = path.join(APPDATA, 'devin');
if (!fs.existsSync(DEVIN)) {
  console.error(`Devin config directory not found: ${DEVIN} - is Devin installed?`);
  process.exit(1);
}

function installLink(link, target, label) {
  if (fs.existsSync(link)) {
    let reparse = false;
    try { reparse = fs.realpathSync(link) !== path.resolve(link); } catch {}
    if (reparse) {
      fs.rmdirSync(link); // removes only the junction, never target content
      fs.symlinkSync(target, link, 'junction');
      console.log(`OK  ${label}: junction repointed -> ${target}`);
      return;
    }
    // Real directory: link items individually
    console.log(`INFO ${label}: ${link} is a real directory - linking items individually`);
    for (const name of fs.readdirSync(target)) {
      const childLink = path.join(link, name);
      const childTarget = path.join(target, name);
      if (fs.existsSync(childLink)) {
        let childReparse = false;
        try { childReparse = fs.realpathSync(childLink) !== path.resolve(childLink); } catch {}
        if (childReparse) fs.rmdirSync(childLink);
        else if (FORCE) fs.rmSync(childLink, { recursive: true, force: true });
        else { console.log(`SKIP ${label}: ${name} already exists (use --force to replace)`); continue; }
      }
      if (fs.statSync(childTarget).isDirectory()) {
        fs.symlinkSync(childTarget, childLink, 'junction');
        console.log(`OK  ${label}: junction ${name}`);
      } else {
        fs.copyFileSync(childTarget, childLink);
        console.log(`OK  ${label}: copied ${name} (file copy - rerun install after edits)`);
      }
    }
    return;
  }
  fs.symlinkSync(target, link, 'junction');
  console.log(`OK  ${label}: junction created -> ${target}`);
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
  const stale = /`[A-Za-z]:\\[^`\n]*?ai-workbench(?=[`\\])/g;
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

console.log('');
console.log('Verify:');
for (const kind of ['skills', 'agents']) {
  try {
    for (const name of fs.readdirSync(path.join(DEVIN, kind))) console.log(`  ${kind.slice(0, -1)}: ${name}`);
  } catch (e) { console.log(`  ${kind}: (unreadable: ${e.message})`); }
}
console.log('');
console.log('Done. Start a NEW Devin session and try: /flow, /understand, /flow-status, /flow-resume');
