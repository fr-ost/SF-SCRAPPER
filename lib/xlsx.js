// Minimal, dependency-free XLSX writer/reader (first sheet only) for the dashboard.
// Uses the browser's CompressionStream / DecompressionStream ('deflate-raw') for ZIP.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));

// ------------------------------------------------------------------ ZIP writer
async function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    const comp = await deflate(raw);
    const crc = crc32(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameBytes, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 8, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ------------------------------------------------------------------ ZIP reader
async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (n) => entries.has(n),
    names: () => [...entries.keys()],
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = u8.subarray(start, start + e.compSize);
      return dec.decode(e.method === 0 ? data : await inflate(data));
    },
  };
}

// ------------------------------------------------------------------ helpers
const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ------------------------------------------------------------------ public: write
/** rows: array of arrays (first row = header). Returns a Blob. */
export async function writeXlsx(rows, sheetName = 'Sheet1') {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>');
  rows.forEach((row, r) => {
    const cells = [];
    row.forEach((v, c) => {
      if (v === null || v === undefined || v === '') return;
      const ref = colName(c) + (r + 1);
      const style = r === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) cells.push(`<c r="${ref}"${style}><v>${v}</v></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`);
      else {
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        cells.push(`<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(s.slice(0, 32767))}</t></is></c>`);
      }
    });
    out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData>');
  if (rows.length && rows[0].length) out.push(`<autoFilter ref="A1:${colName(rows[0].length - 1)}${rows.length}"/>`);
  out.push('</worksheet>');
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>${rows.length && rows[0].length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(sheetName.slice(0, 31))}'!$A$1:$${colName(rows[0].length - 1)}$${rows.length}</definedName></definedNames>` : ''}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: out.join('') },
  ];
  return zip(files);
}

// ------------------------------------------------------------------ public: read
const byLocal = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
const textOf = (el) => byLocal(el, 't').map((t) => t.textContent).join('');

/** Read the first worksheet of an .xlsx file into an array of arrays. */
export async function readXlsx(arrayBuffer) {
  const z = await unzip(arrayBuffer);
  const parser = new DOMParser();
  const parse = (x) => parser.parseFromString(x, 'application/xml');

  let sheetPath = null;
  const wb = await z.text('xl/workbook.xml');
  const rels = await z.text('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = byLocal(parse(wb), 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = byLocal(parse(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) {
      const t = rel.getAttribute('Target');
      sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
  }
  if (!sheetPath || !z.has(sheetPath)) sheetPath = z.names().filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
  if (!sheetPath) throw new Error('No worksheet found in file');

  const sstXml = await z.text('xl/sharedStrings.xml');
  const shared = sstXml ? byLocal(parse(sstXml), 'si').map(textOf) : [];

  const sheet = parse(await z.text(sheetPath));
  const rows = [];
  for (const row of byLocal(sheet, 'row')) {
    const ri = Number(row.getAttribute('r')) - 1;
    const arr = [];
    let next = 0;
    for (const c of byLocal(row, 'c')) {
      let ci = colIndex(c.getAttribute('r'));
      if (ci < 0) ci = next;
      next = ci + 1;
      const t = c.getAttribute('t');
      const vEl = byLocal(c, 'v')[0];
      const v = vEl ? vEl.textContent : null;
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(c);
      else if (t === 'b') val = v === '1';
      else if (t === 'str' || t === 'e') val = v ?? '';
      else val = v === null ? '' : (Number.isFinite(Number(v)) ? Number(v) : v);
      arr[ci] = val;
    }
    rows[Number.isFinite(ri) && ri >= 0 ? ri : rows.length] = arr;
  }
  return rows.filter(Boolean).map((r) => Array.from(r, (x) => (x === undefined ? '' : x)));
}
