// markdown.mjs - Turn source text into the small block list every writer consumes.
// Block = { type:'h1'|'h2'|'h3'|'p'|'li'|'code'|'hr'|'quote'|'table', text, runs?, ordered?, level?, lang?, rows?, header? }
// Run   = { text, bold?, italic?, code?, href? }
// Deliberately small: headings, paragraphs, lists, fenced code, quotes, rules,
// and inline bold/italic/code/link. Anything richer is out of scope by design.

const RTL_RANGE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RANGE = /[A-Za-z]/;

export function looksRtl(text) {
  let rtl = 0, ltr = 0;
  for (const ch of String(text)) {
    if (RTL_RANGE.test(ch)) rtl++;
    else if (LATIN_RANGE.test(ch)) ltr++;
  }
  return rtl > ltr;
}

export function hasNonLatin(text) {
  // Anything outside WinAnsi cannot be drawn by the built-in PDF core fonts.
  return /[^\u0000-\u00FF]/.test(String(text));
}

function inline(text) {
  const runs = [];
  let rest = String(text);
  // Order matters: code spans win over emphasis so `**x**` inside backticks stays literal.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;
  while (rest) {
    const m = pattern.exec(rest);
    if (!m) { runs.push({ text: rest }); break; }
    if (m.index > 0) runs.push({ text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) runs.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      runs.push({ text: tok.slice(1, cut), href: tok.slice(cut + 2, -1) });
    } else if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ text: tok.slice(2, -2), bold: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    rest = rest.slice(m.index + tok.length);
  }
  return runs.filter((r) => r.text !== '');
}

// Windows editors and PowerShell write a UTF-8 BOM; left in place it glues
// itself to the first character and the opening heading silently becomes a
// paragraph. Normalize newlines here too so no parser sees a stray \r.
function normalize(src) {
  return String(src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function block(type, text, extra = {}) {
  return { type, text, runs: type === 'code' ? null : inline(text), ...extra };
}

export function parseMarkdown(src) {
  const lines = normalize(src).split('\n');
  const blocks = [];
  let para = [];
  let orderedCounter = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(block('p', para.join(' ').trim()));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      blocks.push({ type: 'code', text: body.join('\n'), runs: null, lang: fence[1] || '' });
      continue;
    }

    if (!line.trim()) { flushPara(); orderedCounter = 0; continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr', text: '', runs: [] }); continue; }

    // A table is a pipe row followed by a |---|---| separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushPara();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      const padded = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
      blocks.push({ type: 'table', text: padded.map((r) => r.join(' ')).join('\n'), runs: null, rows: padded, header: true });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 3);
      blocks.push(block(`h${level}`, heading[2].trim(), { level }));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flushPara(); blocks.push(block('quote', quote[1].trim())); continue; }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      blocks.push(block('li', bullet[2].trim(), { ordered: false, level: Math.floor(bullet[1].length / 2) }));
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      orderedCounter++;
      blocks.push(block('li', numbered[3].trim(), { ordered: true, index: orderedCounter, level: Math.floor(numbered[1].length / 2) }));
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

function splitRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1'));
}

// Every table in the document, for the writers that are tabular by nature
// (csv, xlsx). Documents with no table fall back to one row per block.
export function extractRows(blocks) {
  const tables = blocks.filter((b) => b.type === 'table');
  if (tables.length) return tables.map((t) => t.rows);
  const rows = [['type', 'text']];
  for (const b of blocks) {
    if (b.type === 'hr') continue;
    const text = b.runs && b.runs.length ? b.runs.map((r) => r.text).join('') : b.text;
    if (String(text).trim()) rows.push([b.type, String(text)]);
  }
  return [rows];
}

export function parseText(src) {
  return normalize(src)
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({ type: 'p', text: chunk, runs: [{ text: chunk }] }));
}

// Very small HTML -> blocks reader: enough to re-export an HTML document to
// PDF/DOCX/TXT without pulling in a parser.
export function parseHtml(src) {
  const src2 = normalize(src);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(src2);
  let text = body ? body[1] : src2;
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${strip(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${strip(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${strip(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${strip(t)}`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\`\`\`\n${strip(t)}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n');
  return parseMarkdown(strip(text));
}

function strip(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function blocksToPlain(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'hr') { out.push('-'.repeat(60), ''); continue; }
    if (b.type === 'table') {
      const width = (b.rows[0] || []).map((_, c) => Math.max(...b.rows.map((r) => String(r[c] || '').length)));
      for (const row of b.rows) out.push(row.map((cell, c) => String(cell).padEnd(width[c])).join('  ').trimEnd());
      out.push('');
      continue;
    }
    if (b.type === 'code') { out.push(b.text, ''); continue; }
    const text = (b.runs || [{ text: b.text }]).map((r) => r.text).join('');
    if (b.type === 'li') out.push(`${b.ordered ? `${b.index}.` : '-'} ${text}`);
    else if (b.type === 'quote') out.push(`> ${text}`, '');
    else { out.push(text, ''); }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function documentTitle(blocks, fallback) {
  const h = blocks.find((b) => b.type === 'h1') || blocks.find((b) => b.type === 'h2');
  return h ? (h.runs || []).map((r) => r.text).join('') || fallback : fallback;
}
