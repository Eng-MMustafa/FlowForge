// render.mjs - Turn docs/social/cards.html into PNGs for LinkedIn.
// Zero dependencies: headless Edge/Chrome does the rendering, the same browser
// the PDF exporter already uses (scripts/convert-doc.mjs findBrowser()).
//
// Usage: node docs/social/render.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../../scripts/convert-doc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARDS = [
  { id: 1, out: '01-hero.png' },
  { id: 2, out: '02-flow-editor.png' },
  { id: 3, out: '03-install.png' },
];
const WIDTH = 1200;
const HEIGHT = 1500; // LinkedIn's 4:5 portrait - the tallest the feed allows

const browser = findBrowser();
if (!browser) {
  console.error('No Chrome/Edge found. Set CHROME_PATH or DEVIN_BROWSER.');
  process.exit(1);
}

const source = path.join(HERE, 'cards.html');
if (!fs.existsSync(source)) { console.error(`missing ${source}`); process.exit(1); }

for (const card of CARDS) {
  const out = path.join(HERE, card.out);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-'));
  const url = `file:///${source.replace(/\\/g, '/')}?c=${card.id}`;
  const r = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',   // 2400x3000 - crisp on retina feeds
    '--virtual-time-budget=4000',      // let the screenshots decode first
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profile}`,
    `--screenshot=${out}`,
    url,
  ], { encoding: 'utf8', timeout: 90000 });
  fs.rmSync(profile, { recursive: true, force: true });
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  if (!size) {
    console.error(`  FAIL  ${card.out} - ${(r.stderr || '').split('\n')[0] || 'no output'}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${card.out}  ${(size / 1024).toFixed(0)} kB`);
  }
}
