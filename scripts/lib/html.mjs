// html.mjs - Blocks -> one standalone, print-ready HTML file.
// Used both as an output format and as the page the browser PDF method prints.
import { looksRtl } from './markdown.mjs';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function runsToHtml(runs, fallback) {
  if (!runs || !runs.length) return esc(fallback || '');
  return runs.map((r) => {
    const text = esc(r.text);
    if (r.code) return `<code>${text}</code>`;
    if (r.href) return `<a href="${esc(r.href)}">${text}</a>`;
    if (r.bold) return `<strong>${text}</strong>`;
    if (r.italic) return `<em>${text}</em>`;
    return text;
  }).join('');
}

export function renderHtml(blocks, opts = {}) {
  const title = opts.title || 'document';
  const rtl = opts.rtl === undefined
    ? looksRtl(blocks.map((b) => b.text).join(' '))
    : !!opts.rtl;

  const out = [];
  const put = (s = '') => out.push(s);
  let list = null; // 'ul' | 'ol'

  const closeList = () => { if (list) { put(`</${list}>`); list = null; } };

  for (const b of blocks) {
    if (b.type === 'li') {
      const want = b.ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); put(`<${want}>`); list = want; }
      put(`<li>${runsToHtml(b.runs, b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.type === 'table') {
      put('<table>');
      b.rows.forEach((row, i) => {
        const tag = i === 0 && b.header ? 'th' : 'td';
        put(`<tr>${row.map((cell) => `<${tag}>${esc(cell)}</${tag}>`).join('')}</tr>`);
      });
      put('</table>');
    } else if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') put(`<${b.type}>${runsToHtml(b.runs, b.text)}</${b.type}>`);
    else if (b.type === 'code') put(`<pre><code>${esc(b.text)}</code></pre>`);
    else if (b.type === 'quote') put(`<blockquote>${runsToHtml(b.runs, b.text)}</blockquote>`);
    else if (b.type === 'hr') put('<hr>');
    else put(`<p>${runsToHtml(b.runs, b.text)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  :root { color-scheme: light; }
  body {
    font-family: ${rtl ? '"Segoe UI","Tahoma",Arial,sans-serif' : '"Segoe UI",Helvetica,Arial,sans-serif'};
    font-size: 11.5pt; line-height: 1.65; color: #14181f; background: #fff;
    max-width: 860px; margin: 0 auto; padding: 28px 22px;
  }
  h1, h2, h3 { line-height: 1.3; margin: 1.4em 0 .5em; page-break-after: avoid; }
  h1 { font-size: 22pt; border-bottom: 1px solid #d8dee7; padding-bottom: .25em; }
  h2 { font-size: 16pt; color: #10305c; }
  h3 { font-size: 13pt; }
  p, li { orphans: 2; widows: 2; }
  ul, ol { padding-inline-start: 1.6em; margin: .6em 0; }
  li { margin: .25em 0; }
  code { font-family: Consolas, "Courier New", monospace; font-size: .92em; background: #f2f4f8; border: 1px solid #e0e5ec; border-radius: 4px; padding: 1px 4px; }
  pre { background: #f7f9fc; border: 1px solid #e0e5ec; border-radius: 6px; padding: 12px 14px; overflow-x: auto; page-break-inside: avoid; direction: ltr; text-align: left; }
  pre code { background: none; border: none; padding: 0; }
  blockquote { margin: .8em 0; padding-inline-start: 14px; border-inline-start: 3px solid #c3ccd8; color: #46505f; }
  hr { border: none; border-top: 1px solid #d8dee7; margin: 1.6em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; page-break-inside: avoid; }
  th, td { border: 1px solid #d8dee7; padding: 6px 10px; text-align: start; vertical-align: top; }
  th { background: #edf1f7; font-weight: 600; }
  a { color: #0b5dd4; }
  @media print { body { padding: 0; max-width: none; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;
}
