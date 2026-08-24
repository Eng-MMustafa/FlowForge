// convert-doc.mjs - Turn a document into a deliverable: PDF, Word, Excel, CSV,
// HTML, TXT, Markdown or JSON. Zero dependencies (node builtins only).
// This is the ONE entry point agents need for producing files.
//
// Usage:
//   node convert-doc.mjs <input.md|.html|.txt|directory> --to <format> [options]
// Options:
//   --to <fmt>        see --help for the live list (comes from lib/formats.mjs)
//   --out <path>      output file, or directory in batch mode
//   --method <m>      auto (default) | builtin | browser   (PDF only)
//   --title <text>    document title (default: first heading, else the file name)
//   --quiet           only print the OK/ERROR line
//   --formats         print the supported formats, one per line
//   --help            show this help
// Exit codes: 0 = written, 1 = failure.
//
// Adding a format means adding one entry to scripts/lib/formats.mjs - this file
// does not need to change.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { documentTitle, extractRows, looksRtl, parseHtml, parseMarkdown, parseText } from './lib/markdown.mjs';
import { FORMATS, FORMAT_IDS, formatFor } from './lib/formats.mjs';
import { renderHtml } from './lib/html.mjs';
import { pdfLosesText } from './lib/pdf.mjs';

const METHODS = ['auto', 'builtin', 'browser'];
const INPUT_EXT = ['.md', '.markdown', '.html', '.htm', '.txt'];
const BROWSER_TIMEOUT_MS = 60000;

const BROWSER_CANDIDATES = [
  process.env.DEVIN_BROWSER,
  process.env.CHROME_PATH,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function readDocument(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  const blocks = (ext === '.html' || ext === '.htm') ? parseHtml(src)
    : ext === '.txt' ? parseText(src)
      : parseMarkdown(src);
  return { blocks, tables: extractRows(blocks) };
}

function printPdfWithBrowser(html, outFile) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error('no headless browser found - install Edge/Chrome or set DEVIN_BROWSER to its path (or use --method builtin)');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-convert-'));
  const tmpHtml = path.join(tmpDir, 'page.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-pdf-header-footer',
    `--user-data-dir=${path.join(tmpDir, 'profile')}`,
    `--print-to-pdf=${outFile}`,
    pathToFileURL(tmpHtml).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: BROWSER_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir */ }
      if (!fs.existsSync(outFile)) {
        reject(new Error(`browser produced no PDF${err ? ` (${err.message})` : ''}${stderr ? `: ${String(stderr).trim().split('\n').pop()}` : ''}`));
        return;
      }
      resolve(path.basename(browser));
    });
  });
}

export async function convert({ input, to, out, method = 'auto', title, quiet = false } = {}) {
  const fmt = formatFor(to);
  if (!fmt) throw new Error(`unknown --to "${to}" (supported: ${FORMAT_IDS.join(', ')})`);
  if (!METHODS.includes(method)) throw new Error(`unknown --method "${method}" (supported: ${METHODS.join(', ')})`);
  const inFile = path.resolve(input);
  if (!fs.existsSync(inFile)) throw new Error(`input not found: ${inFile}`);

  const doc = readDocument(inFile);
  const docTitle = title || documentTitle(doc.blocks, path.basename(inFile, path.extname(inFile)));
  const rtl = looksRtl(doc.blocks.map((b) => b.text).join(' '));
  const outFile = path.resolve(out || inFile.replace(/\.[^.]+$/, '') + fmt.ext);
  // md -> md (or html -> html) would otherwise silently rewrite the source file.
  if (outFile.toLowerCase() === inFile.toLowerCase()) {
    throw new Error(`refusing to overwrite the input file: pass --out with a different path (${outFile})`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const opts = { title: docTitle, rtl };

  // Only PDF has a second engine; every other format is produced in-process.
  if (to === 'pdf') {
    const wanted = method === 'auto' ? (findBrowser() ? 'browser' : 'builtin') : method;
    if (wanted === 'browser') {
      const used = await printPdfWithBrowser(renderHtml(doc.blocks, opts), outFile);
      return { out: outFile, method: `browser:${used}`, format: to };
    }
    if (pdfLosesText(doc.blocks) && !quiet) {
      console.error('WARNING: the built-in PDF writer supports Latin text only (PDF core fonts).');
      console.error('         Non-Latin characters will render as "?". Use --method browser, or --to docx/xlsx/html.');
    }
  }

  const output = fmt.render(doc, opts);
  fs.writeFileSync(outFile, fmt.binary ? output : String(output), fmt.binary ? undefined : 'utf8');
  return { out: outFile, method: 'builtin', format: to };
}

function help() {
  const rows = FORMAT_IDS.map((id) => `  ${id.padEnd(6)} ${FORMATS[id].ext.padEnd(7)} ${FORMATS[id].label}`).join('\n');
  console.log(`convert-doc.mjs - one document in, any deliverable out (zero dependencies)

Usage:
  node convert-doc.mjs <input> --to <format> [options]

  <input>            .md, .markdown, .html, .htm, .txt file, or a directory (batch mode)

Formats (from scripts/lib/formats.mjs):
${rows}

Options:
  --to <format>      required
  --out <path>       output file; a directory in batch mode
  --method <method>  ${METHODS.join(' | ')}   (PDF only, default: auto)
  --title <text>     document title (default: first heading, else the file name)
  --quiet            suppress warnings, print only the result line
  --formats          list format ids, one per line
  --help             this help

Methods:
  builtin   pure Node writers. Always available. PDF is Latin-only (core fonts).
  browser   prints the HTML through headless Edge/Chrome: full Unicode, Arabic/RTL, CSS.
  auto      browser when one is installed, otherwise builtin (with a warning if text would be lost).
            Override the browser path with DEVIN_BROWSER or CHROME_PATH.

Tables: Markdown tables become real tables in pdf/docx/html and real rows in
xlsx/csv. A document with no table still exports to xlsx/csv as type + text rows.

Examples:
  node convert-doc.mjs .workbench/artifacts/review.md --to pdf
  node convert-doc.mjs report.md --to docx --title "Q3 report"
  node convert-doc.mjs data.md --to xlsx
  node convert-doc.mjs .workbench/artifacts --to pdf --out C:/deliverables
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { help(); process.exit(0); }
  if (argv.includes('--formats')) { console.log(FORMAT_IDS.join('\n')); process.exit(0); }

  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--') ? argv[idx + 1] : fallback;
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--') && a !== '--quiet') i++;
      continue;
    }
    positional.push(a);
  }

  const input = positional[0];
  const to = String(value('to', '')).toLowerCase();
  const method = String(value('method', 'auto')).toLowerCase();
  const quiet = flag('quiet');

  if (!input) { console.error('ERROR: no input given. Run with --help.'); process.exit(1); }
  if (!to) { console.error(`ERROR: --to is required (${FORMAT_IDS.join(', ')}). Run with --help.`); process.exit(1); }

  try {
    const target = path.resolve(input);
    if (!fs.existsSync(target)) throw new Error(`input not found: ${target}`);
    const fmt = formatFor(to);
    if (!fmt) throw new Error(`unknown --to "${to}" (supported: ${FORMAT_IDS.join(', ')})`);

    if (fs.statSync(target).isDirectory()) {
      const outDir = path.resolve(value('out', target));
      const files = fs.readdirSync(target)
        .filter((f) => INPUT_EXT.includes(path.extname(f).toLowerCase()))
        .map((f) => path.join(target, f));
      if (!files.length) throw new Error(`no convertible documents in ${target} (looked for ${INPUT_EXT.join(', ')})`);
      for (const file of files) {
        const out = path.join(outDir, path.basename(file).replace(/\.[^.]+$/, '') + fmt.ext);
        const res = await convert({ input: file, to, out, method, title: value('title'), quiet });
        if (!quiet) console.log(`  ${path.basename(file)} -> ${res.out} (method=${res.method})`);
      }
      console.log(`OK: converted ${files.length} document(s) to ${to} in ${outDir}`);
      process.exit(0);
    }

    const res = await convert({ input: target, to, out: value('out'), method, title: value('title'), quiet });
    console.log(`OK: wrote ${res.out} (method=${res.method})`);
    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
