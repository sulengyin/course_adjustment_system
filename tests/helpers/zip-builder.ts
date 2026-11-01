import { crc32, deflateRawSync } from 'node:zlib';

interface ZipFile {
  name: string;
  content: string;
  deflate?: boolean;
}

/**
 * 测试用的最小 ZIP 构造器：不依赖外部 zip 命令，结果在任何环境一致。
 * 只为构造 XLSX 测试样本，不用于生产。
 */
export function buildZip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.content, 'utf8');
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const method = file.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 构造一个结构合法的最小 XLSX：共享字符串 + 内联字符串 + 数字单元格。
 * rows[0] 视为表头。
 */
export function buildXlsx(rows: readonly (readonly (string | number)[])[], opts: { deflate?: boolean } = {}): Buffer {
  const shared: string[] = [];
  const sharedIndex = (s: string): number => {
    const at = shared.indexOf(s);
    if (at >= 0) return at;
    shared.push(s);
    return shared.length - 1;
  };

  const colName = (i: number): string => {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  const rowXml = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (typeof value === 'number') {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          // 第 2 行用内联字符串，其余用共享字符串，覆盖两条解析路径
          if (r === 1) {
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
          }
          return `<c r="${ref}" t="s"><v>${sharedIndex(value)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join('')}</sst>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="课表" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;

  return buildZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', content: workbook, deflate: opts.deflate },
    { name: 'xl/sharedStrings.xml', content: sharedXml, deflate: opts.deflate },
    { name: 'xl/worksheets/sheet1.xml', content: sheet, deflate: opts.deflate },
  ]);
}
