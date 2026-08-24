// uninstall.mjs - Remove the FlowForge links from Devin's global config. Repo files are untouched.
// Usage: node uninstall.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentConfigDir, isLink, removeLink as dropLink } from './scripts/lib/platform.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const DEVIN = agentConfigDir();

function isJunction(p) {
  if (isLink(p)) return true;
  try { return fs.realpathSync(p) !== path.resolve(p); } catch { return false; }
}

function removeLink(link, repoDir, label) {
  if (!fs.existsSync(link) && !isLink(link)) { console.log(`SKIP ${label}: ${link} does not exist`); return; }
  if (isJunction(link)) {
    dropLink(link);
    console.log(`OK  ${label}: link removed`);
    return;
  }
  for (const name of fs.readdirSync(repoDir)) {
    const childLink = path.join(link, name);
    if (!fs.existsSync(childLink)) continue;
    if (isJunction(childLink)) {
      dropLink(childLink);
      console.log(`OK  ${label}: link ${name} removed`);
    } else if (fs.statSync(childLink).isFile()) {
      fs.rmSync(childLink);
      console.log(`OK  ${label}: copied file ${name} removed`);
    } else {
      console.log(`SKIP ${label}: ${name} is a real directory not created by install`);
    }
  }
}

removeLink(path.join(DEVIN, 'skills'), path.join(REPO, 'skills'), 'skills');
removeLink(path.join(DEVIN, 'agents'), path.join(REPO, 'agents'), 'agents');
console.log('Done.');
