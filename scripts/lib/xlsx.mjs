// xlsx.mjs - Rows -> a real Excel workbook (SpreadsheetML inside a ZIP).
// Shares the container with docx through ./zip.mjs. Values are written as
// inline strings or numbers, so no sharedStrings part is needed.
import { xmlEscape as esc, zipSync } from './zip.mjs';

const COL_LETTERS = (index) => {
  let n = index + 1, out = '';
  while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

const isNumeric = (v) => typeof v === 'number'
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))));

function cellXml(value, row, col, header) {
  const ref = `${COL_LETTERS(col)}${row + 1}`;
  const style = header ? ' s="1"' : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;
  if (!header && isNumeric(value)) return `<c r="${ref}"${style}><v>${Number(String(value).replace(/,/g, ''))}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(rows, header) {
  const body = rows.map((cells, r) => {
    const isHeader = header && r === 0;
    return `<row r="${r + 1}">${cells.map((cell, c) => cellXml(cell, r, c, isHeader)).join('')}</row>`;
  }).join('');
  const widths = (rows[0] || []).map((_, c) => {
    const longest = Math.max(...rows.map((r) => String(r[c] ?? '').length), 8);
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`;
  }).join('');
  const freeze = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const sheetName = (name, index) => (String(name || `Sheet${index + 1}`)
  .replace(/[\\/?*[\]:]/g, ' ')
  .slice(0, 31) || `Sheet${index + 1}`);

// sheets: [{ name, rows: string[][] }] or a bare rows array for a single sheet.
export function renderXlsx(sheets, opts = {}) {
  const list = (Array.isArray(sheets) && sheets.length && Array.isArray(sheets[0]))
    ? [{ name: opts.title, rows: sheets }]
    : sheets;
  const clean = list.length ? list : [{ name: 'Sheet1', rows: [['(empty)']] }];
  const header = opts.header !== false;

  const parts = clean.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(sheet.rows && sheet.rows.length ? sheet.rows : [['(empty)']], header),
  }));

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${clean.map((s, i) => `<sheet name="${esc(sheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${clean.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF1F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${clean.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return zipSync([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
    ...parts,
  ]);
}

export function renderCsv(rows, opts = {}) {
  const sep = opts.separator || ',';
  const escapeCell = (cell) => {
    const value = cell === null || cell === undefined ? '' : String(cell);
    return /["\n\r]|,|;|\t/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  // BOM so Excel opens UTF-8 (Arabic) correctly on a double click.
  return '\uFEFF' + rows.map((row) => row.map(escapeCell).join(sep)).join('\r\n') + '\r\n';
}
