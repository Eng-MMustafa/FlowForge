// pdf.mjs - Blocks -> PDF bytes, using only the 14 core fonts (no embedding).
// Zero dependencies: the file is assembled as Buffers so the xref byte offsets
// are exact. WinAnsi only - callers must route non-Latin text to the browser
// method (see convert-doc.mjs) because core fonts cannot represent it.
import { hasNonLatin } from './markdown.mjs';

const PAGE_W = 595.28, PAGE_H = 841.89;
const MARGIN = 56, BOTTOM = 62;
const COL = PAGE_W - MARGIN * 2;

const F = { base: '/F1', bold: '/F2', italic: '/F3', mono: '/F4' };

// AFM advance widths (units/1000) for ASCII 32..126.
const W_BASE = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

function widthOf(text, font, size) {
  const table = font === 'bold' ? W_BOLD : W_BASE;
  let units = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (font === 'mono') units += 600;
    else if (c >= 32 && c <= 126) units += table[c - 32];
    else units += 556;
  }
  return (units / 1000) * size;
}

function pdfString(text) {
  // Latin-1 bytes match WinAnsiEncoding closely enough for Western text;
  // anything else is replaced so the file stays valid instead of corrupt.
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c === 0x2022) out += '\\225';
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += '\\' + c.toString(8).padStart(3, '0');
    else out += '?';
  }
  return out;
}

const STYLE = {
  h1: { font: 'bold', size: 19, before: 16, after: 9 },
  h2: { font: 'bold', size: 15, before: 14, after: 7 },
  h3: { font: 'bold', size: 12.5, before: 12, after: 6 },
  p: { font: 'base', size: 10.5, before: 0, after: 8 },
  li: { font: 'base', size: 10.5, before: 0, after: 4 },
  quote: { font: 'italic', size: 10.5, before: 6, after: 8 },
  code: { font: 'mono', size: 9, before: 6, after: 8 },
};

function runsToWords(runs, fallbackFont) {
  const words = [];
  for (const run of (runs && runs.length ? runs : [{ text: '' }])) {
    const font = run.code ? 'mono' : run.bold ? 'bold' : run.italic ? 'italic' : fallbackFont;
    for (const piece of String(run.text).split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) { words.push({ space: true, font }); continue; }
      words.push({ text: piece, font });
    }
  }
  return words;
}

function wrap(words, size, maxWidth) {
  const lines = [];
  let line = [], used = 0;
  const spaceW = widthOf(' ', 'base', size);
  for (const w of words) {
    if (w.space) { if (line.length) { line.push(w); used += spaceW; } continue; }
    let text = w.text;
    let width = widthOf(text, w.font, size);
    // A single word longer than the column is hard-broken instead of overflowing.
    while (width > maxWidth && text.length > 1) {
      let cut = text.length;
      while (cut > 1 && widthOf(text.slice(0, cut), w.font, size) > maxWidth) cut--;
      lines.push([...line, { text: text.slice(0, cut), font: w.font }]);
      line = []; used = 0;
      text = text.slice(cut);
      width = widthOf(text, w.font, size);
    }
    if (used + width > maxWidth && line.length) { lines.push(line); line = []; used = 0; }
    line.push({ text, font: w.font });
    used += width;
  }
  if (line.length) lines.push(line);
  return lines.map((l) => (l[l.length - 1] && l[l.length - 1].space ? l.slice(0, -1) : l));
}

export function renderPdf(blocks, opts = {}) {
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => { pages.push(ops); ops = []; y = PAGE_H - MARGIN; };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };

  const drawLine = (segments, x, size) => {
    let cursor = x;
    const spaceW = widthOf(' ', 'base', size);
    for (const seg of segments) {
      if (seg.space) { cursor += spaceW; continue; }
      ops.push(`BT ${F[seg.font] || F.base} ${size} Tf 1 0 0 1 ${cursor.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(seg.text)}) Tj ET`);
      cursor += widthOf(seg.text, seg.font, size);
    }
  };

  for (const b of blocks) {
    const style = STYLE[b.type] || STYLE.p;
    const leading = style.size * 1.45;

    if (b.type === 'hr') {
      need(14);
      y -= 8;
      ops.push(`0.82 0.82 0.82 RG 0.8 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 10;
      continue;
    }

    if (b.type === 'table') {
      const cols = Math.max(1, (b.rows[0] || []).length);
      const cellW = COL / cols;
      const size = 9.5;
      const cellLead = size * 1.35;
      y -= 8;
      b.rows.forEach((row, rowIndex) => {
        const font = rowIndex === 0 && b.header ? 'bold' : 'base';
        const wrapped = row.map((cell) => wrap(runsToWords([{ text: String(cell) }], font), size, cellW - 10));
        const height = Math.max(1, ...wrapped.map((w) => w.length)) * cellLead + 4;
        need(height);
        const top = y;
        wrapped.forEach((linesInCell, colIndex) => {
          let cellY = top;
          for (const segments of linesInCell) {
            y = cellY;
            drawLine(segments, MARGIN + colIndex * cellW + 5, size);
            cellY -= cellLead;
          }
        });
        y = top - height;
        ops.push(`0.82 0.85 0.89 RG 0.6 w ${MARGIN} ${y.toFixed(2)} m ${(MARGIN + COL).toFixed(2)} ${y.toFixed(2)} l S`);
      });
      y -= 10;
      continue;
    }

    if (b.type === 'code') {
      const codeLines = String(b.text).split('\n');
      y -= style.before;
      for (const raw of codeLines) {
        need(leading);
        let text = raw;
        while (widthOf(text, 'mono', style.size) > COL - 12 && text.length > 1) {
          let cut = text.length;
          while (cut > 1 && widthOf(text.slice(0, cut), 'mono', style.size) > COL - 12) cut--;
          drawLine([{ text: text.slice(0, cut), font: 'mono' }], MARGIN + 12, style.size);
          y -= leading;
          need(leading);
          text = text.slice(cut);
        }
        drawLine([{ text, font: 'mono' }], MARGIN + 12, style.size);
        y -= leading;
      }
      y -= style.after;
      continue;
    }

    const indent = b.type === 'li' ? 18 + (b.level || 0) * 14 : b.type === 'quote' ? 16 : 0;
    const marker = b.type === 'li' ? (b.ordered ? `${b.index}.` : '\u2022') : '';
    const words = runsToWords(b.runs, style.font);
    const lines = wrap(words, style.size, COL - indent);

    y -= style.before;
    lines.forEach((segments, i) => {
      need(leading);
      if (i === 0 && marker) drawLine([{ text: marker, font: style.font }], MARGIN + indent - 14, style.size);
      if (i === 0 && b.type === 'quote') {
        ops.push(`0.76 0.79 0.84 RG 2 w ${MARGIN + 4} ${(y + style.size).toFixed(2)} m ${MARGIN + 4} ${(y - leading * (lines.length - 1) - 2).toFixed(2)} l S`);
      }
      drawLine(segments, MARGIN + indent, style.size);
      y -= leading;
    });
    y -= style.after;
  }
  pages.push(ops);

  return assemble(pages, opts.title || 'document');
}

function assemble(pages, title) {
  const total = pages.length;
  const objects = [];
  const put = (n, body) => { objects[n] = body; };

  const kids = pages.map((_, i) => `${7 + i * 2} 0 R`).join(' ');
  put(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  put(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
  put(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  put(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  put(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`);
  put(6, `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`);

  pages.forEach((ops, i) => {
    const pageNo = i + 1;
    const footer = `BT /F1 8 Tf 1 0 0 1 ${(PAGE_W / 2 - 12).toFixed(2)} 34 Tm 0.45 0.45 0.45 rg (${pdfString(`${pageNo} / ${total}`)}) Tj ET 0 0 0 rg`;
    const stream = [...ops, footer].join('\n');
    const streamBuf = Buffer.from(stream, 'latin1');
    put(7 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${8 + i * 2} 0 R >>`);
    put(8 + i * 2, { stream: streamBuf });
  });

  const infoNo = objects.length;
  put(infoNo, `<< /Title (${pdfString(title)}) /Producer (FlowForge convert-doc.mjs) /CreationDate (D:${stamp()}) >>`);

  const chunks = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  const offsets = [];

  push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  for (let n = 1; n < objects.length; n++) {
    const body = objects[n];
    offsets[n] = offset;
    if (body && body.stream) {
      push(Buffer.from(`${n} 0 obj\n<< /Length ${body.stream.length} >>\nstream\n`, 'latin1'));
      push(body.stream);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, 'latin1'));
    }
  }

  const xrefAt = offset;
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(Buffer.from(xref, 'latin1'));
  push(Buffer.from(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'));

  return Buffer.concat(chunks);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function pdfLosesText(blocks) {
  return blocks.some((b) => hasNonLatin(b.text));
}
