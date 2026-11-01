import { readZipEntries } from './zip.js';
import type { ParsedTable, ParseResult } from './types.js';

const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeXmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITY[m] ?? m);
}

/** 读取 <si>/<t> 全部文本节点，兼容富文本被拆成多个 <t> 的情况 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    const parts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner)) !== null) parts.push(decodeXmlText(t[1] ?? ''));
    out.push(parts.join(''));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * 最小 XLSX 读取器：只取第一个工作表，支持 sharedStrings / inlineStr / 数字单元格。
 * 不支持合并单元格回填、公式计算、多工作表选择 —— 这些需要在真实文件上另行确认。
 */
export function parseXlsx(buffer: Buffer): ParseResult {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buffer);
  } catch (err) {
    return { ok: false, code: 'MALFORMED', message: `不是有效的 XLSX 容器：${String(err)}` };
  }

  const sheetName =
    [...entries.keys()].find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) ??
    [...entries.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) {
    return { ok: false, code: 'MALFORMED', message: 'XLSX 内未找到工作表' };
  }

  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const shared = sharedEntry ? parseSharedStrings(sharedEntry.toString('utf8')) : [];
  const sheet = entries.get(sheetName)?.toString('utf8') ?? '';

  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(sheet)) !== null) {
    const inner = r[1];
    if (inner === undefined) continue;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(inner)) !== null) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const idx = ref ? colIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : (shared[Number(v)] ?? '');
      } else if (type === 'inlineStr') {
        const parts: string[] = [];
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(body)) !== null) parts.push(decodeXmlText(t[1] ?? ''));
        value = parts.join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : decodeXmlText(v);
        if (NUMERIC.test(value) && value.includes('.')) {
          // 保持原始数字文本，不做四舍五入
        }
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value.trim();
    }
    if (cells.some((x) => x !== '')) rows.push(cells);
  }

  const header = rows.shift();
  if (!header || header.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '工作表为空' };
  }
  if (rows.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '只有表头，没有数据行' };
  }

  const width = header.length;
  const table: ParsedTable = {
    headers: header.map((h) => h.trim()),
    rows: rows.map((row) => {
      const normalized = [...row];
      while (normalized.length < width) normalized.push('');
      return normalized.slice(0, width).map((v) => v.trim());
    }),
  };
  return { ok: true, table };
}
