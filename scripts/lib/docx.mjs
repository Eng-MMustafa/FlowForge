// docx.mjs - Blocks -> a real Word .docx (OOXML inside a ZIP), zero dependencies.
// The container itself comes from ./zip.mjs, shared with the .xlsx writer.
import { looksRtl } from './markdown.mjs';
import { xmlEscape as esc, zipSync } from './zip.mjs';

function runXml(run, rtl) {
  const props = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/>');
  if (run.href) props.push('<w:color w:val="0B5DD4"/><w:u w:val="single"/>');
  if (rtl) props.push('<w:rtl/>');
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(run.text)}</w:t></w:r>`;
}

function paragraph(blocksRuns, { style, indent, rtl, keepNext } = {}) {
  const pr = [];
  if (style) pr.push(`<w:pStyle w:val="${style}"/>`);
  if (rtl) pr.push('<w:bidi/>');
  if (indent) pr.push(`<w:ind w:left="${indent}"/>`);
  if (keepNext) pr.push('<w:keepNext/>');
  const pPr = pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${blocksRuns}</w:p>`;
}

function tableXml(block, rtl) {
  const width = Math.max(1, (block.rows[0] || []).length);
  const colWidth = Math.floor(9360 / width);
  const rows = block.rows.map((cells, rowIndex) => {
    const isHeader = rowIndex === 0 && block.header;
    const tcs = cells.map((cell) => {
      const shading = isHeader ? '<w:shd w:val="clear" w:fill="EDF1F7"/>' : '';
      const runs = `<w:r>${isHeader ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(cell)}</w:t></w:r>`;
      return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${shading}</w:tcPr><w:p>${rtl ? '<w:pPr><w:bidi/></w:pPr>' : ''}${runs}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
  }).join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="C8CFDA"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${rtl ? '<w:bidiVisual/>' : ''}<w:tblBorders>${borders}</w:tblBorders></w:tblPr>${rows}</w:tbl><w:p/>`;
}

export function renderDocx(blocks, opts = {}) {
  const rtl = opts.rtl === undefined ? looksRtl(blocks.map((b) => b.text).join(' ')) : !!opts.rtl;
  const body = [];

  for (const b of blocks) {
    if (b.type === 'table') {
      body.push(tableXml(b, rtl));
      continue;
    }
    if (b.type === 'hr') {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8CFDA"/></w:pBdr></w:pPr></w:p>');
      continue;
    }
    if (b.type === 'code') {
      const lines = String(b.text).split('\n');
      const runs = lines.map((line, i) => {
        const br = i ? '<w:br/>' : '';
        return `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr>${br}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`;
      }).join('');
      body.push(paragraph(runs, { style: 'CodeBlock', indent: 240 }));
      continue;
    }

    const runs = (b.runs && b.runs.length ? b.runs : [{ text: b.text }]);
    if (b.type === 'li') {
      const marker = { text: b.ordered ? `${b.index}. ` : '\u2022 ' };
      const xml = [marker, ...runs].map((r) => runXml(r, rtl)).join('');
      body.push(paragraph(xml, { indent: 360 + (b.level || 0) * 360, rtl }));
      continue;
    }

    const xml = runs.map((r) => runXml(r, rtl)).join('');
    if (b.type === 'h1') body.push(paragraph(xml, { style: 'Heading1', rtl, keepNext: true }));
    else if (b.type === 'h2') body.push(paragraph(xml, { style: 'Heading2', rtl, keepNext: true }));
    else if (b.type === 'h3') body.push(paragraph(xml, { style: 'Heading3', rtl, keepNext: true }));
    else if (b.type === 'quote') body.push(paragraph(xml, { style: 'Quote', indent: 360, rtl }));
    else body.push(paragraph(xml, { rtl }));
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>${rtl ? '<w:bidi/>' : ''}</w:sectPr>
</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const heading = (id, name, size, color, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${id.slice(-1) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${heading('Heading1', 'heading 1', 40, '14181F', 320)}
${heading('Heading2', 'heading 2', 30, '10305C', 280)}
${heading('Heading3', 'heading 3', 25, '14181F', 240)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="46505F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:fill="F5F7FA"/><w:spacing w:after="160"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(opts.title || 'document')}</dc:title>
<dc:creator>FlowForge convert-doc.mjs</dc:creator>
<cp:lastModifiedBy>FlowForge convert-doc.mjs</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

  return zipSync([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/document.xml', data: document },
  ]);
}
