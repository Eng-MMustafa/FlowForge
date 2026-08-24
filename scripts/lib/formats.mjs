// formats.mjs - The format registry. Adding an output format = adding ONE entry
// here; the CLI, the /export skill, the dashboard menu and the tests all read
// this table instead of hard-coding a list.
//
// Entry:
//   ext      file extension written by default
//   label    short human description (shown by --help and the dashboard)
//   binary   true -> render() returns a Buffer, false -> a string
//   tabular  true -> render() receives rows, not blocks
//   render(payload, opts) -> Buffer | string
// A format may also declare `methods: ['builtin','browser']` when more than one
// engine can produce it; `convert-doc.mjs` resolves the method.
import { blocksToPlain } from './markdown.mjs';
import { renderDocx } from './docx.mjs';
import { renderHtml } from './html.mjs';
import { renderPdf } from './pdf.mjs';
import { renderCsv, renderXlsx } from './xlsx.mjs';

export const FORMATS = {
  pdf: {
    ext: '.pdf',
    label: 'PDF document (built-in writer or headless browser)',
    binary: true,
    methods: ['builtin', 'browser'],
    render: (doc, opts) => renderPdf(doc.blocks, opts),
  },
  docx: {
    ext: '.docx',
    label: 'Word document (OOXML)',
    binary: true,
    render: (doc, opts) => renderDocx(doc.blocks, opts),
  },
  xlsx: {
    ext: '.xlsx',
    label: 'Excel workbook (one sheet per table in the document)',
    binary: true,
    tabular: true,
    render: (doc, opts) => renderXlsx(
      doc.tables.map((rows, i) => ({ name: doc.tables.length > 1 ? `Table ${i + 1}` : (opts.title || 'Sheet1'), rows })),
      opts,
    ),
  },
  csv: {
    ext: '.csv',
    label: 'CSV (first table in the document)',
    binary: false,
    tabular: true,
    render: (doc) => renderCsv(doc.tables[0] || [['(empty)']]),
  },
  html: {
    ext: '.html',
    label: 'standalone HTML with print CSS',
    binary: false,
    render: (doc, opts) => renderHtml(doc.blocks, opts),
  },
  txt: {
    ext: '.txt',
    label: 'plain text',
    binary: false,
    render: (doc) => blocksToPlain(doc.blocks),
  },
  md: {
    ext: '.md',
    label: 'normalized Markdown',
    binary: false,
    render: (doc) => blocksToMarkdown(doc.blocks),
  },
  json: {
    ext: '.json',
    label: 'structured JSON (blocks + tables, for machine use)',
    binary: false,
    render: (doc, opts) => JSON.stringify({
      title: opts.title || '',
      rtl: !!opts.rtl,
      generated: new Date().toISOString(),
      blocks: doc.blocks.map((b) => ({
        type: b.type,
        text: b.text,
        ...(b.rows ? { rows: b.rows } : {}),
        ...(b.ordered !== undefined ? { ordered: b.ordered } : {}),
      })),
      tables: doc.tables,
    }, null, 2) + '\n',
  },
};

export const FORMAT_IDS = Object.keys(FORMATS);

export function formatFor(id) {
  return FORMATS[String(id || '').toLowerCase().replace(/^\./, '')] || null;
}

export function extensionFor(id) {
  const fmt = formatFor(id);
  return fmt ? fmt.ext : `.${id}`;
}

function blocksToMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'hr') { out.push('---', ''); continue; }
    if (b.type === 'code') { out.push('```' + (b.lang || ''), b.text, '```', ''); continue; }
    if (b.type === 'table') {
      b.rows.forEach((row, i) => {
        out.push(`| ${row.join(' | ')} |`);
        if (i === 0 && b.header) out.push(`|${row.map(() => '---').join('|')}|`);
      });
      out.push('');
      continue;
    }
    const text = (b.runs || [{ text: b.text }]).map((r) => {
      if (r.code) return `\`${r.text}\``;
      if (r.href) return `[${r.text}](${r.href})`;
      if (r.bold) return `**${r.text}**`;
      if (r.italic) return `*${r.text}*`;
      return r.text;
    }).join('');
    if (b.type === 'h1') out.push(`# ${text}`, '');
    else if (b.type === 'h2') out.push(`## ${text}`, '');
    else if (b.type === 'h3') out.push(`### ${text}`, '');
    else if (b.type === 'li') out.push(b.ordered ? `${b.index}. ${text}` : `- ${text}`);
    else if (b.type === 'quote') out.push(`> ${text}`, '');
    else out.push(text, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
