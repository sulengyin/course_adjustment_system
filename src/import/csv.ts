import type { ParseResult } from './types.js';

/**
 * CSV 解析（RFC 4180）：
 * - 支持引号包裹、字段内逗号、双引号转义、CRLF/LF
 * - 自动去掉 UTF-8 BOM
 * - 空行忽略
 * 不做"修复"：列数不齐直接报 MALFORMED，不猜缺失字段。
 */
export function parseCsv(text: string, maxRows = 20000): ParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src.trim().length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '文件为空' };
  }

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let lineStart = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    const isBlank = row.length === 1 && row[0] === '';
    if (!isBlank) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) throw new Error('TOO_MANY_ROWS');
  };

  try {
    while (i < src.length) {
      const ch = src[i] ?? '';
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        if (field.length > 0) {
          return { ok: false, code: 'MALFORMED', message: `第 ${rows.length + 1} 行：引号出现在字段中间` };
        }
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        pushField();
        i += 1;
        continue;
      }
      if (ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '\n') {
        pushRow();
        i += 1;
        lineStart = i;
        continue;
      }
      field += ch;
      i += 1;
    }
    if (inQuotes) {
      return { ok: false, code: 'MALFORMED', message: `第 ${rows.length + 1} 行：引号未闭合` };
    }
    if (field.length > 0 || row.length > 0) pushRow();
  } catch (err) {
    if (err instanceof Error && err.message === 'TOO_MANY_ROWS') {
      return { ok: false, code: 'TOO_MANY_ROWS', message: `超过 ${maxRows} 行上限` };
    }
    throw err;
  }

  void lineStart;
  const header = rows.shift();
  if (!header || header.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '缺少表头' };
  }
  if (rows.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '只有表头，没有数据行' };
  }

  const width = header.length;
  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r];
    if (!cols) continue;
    if (cols.length !== width) {
      return {
        ok: false,
        code: 'MALFORMED',
        message: `第 ${r + 2} 行有 ${cols.length} 列，表头有 ${width} 列`,
      };
    }
  }

  return {
    ok: true,
    table: {
      headers: header.map((h) => h.trim()),
      rows: rows.map((r) => r.map((c) => c.trim())),
    },
  };
}
