import { parseCsv } from './csv.js';
import { parseXlsx } from './xlsx.js';
import type { ParseResult, TimetableParser } from './types.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20000;

const csvParser: TimetableParser = {
  name: 'csv',
  supports: (fileName) => /\.csv$/i.test(fileName),
  parse: (buffer) => parseCsv(decodeUtf8(buffer), MAX_ROWS),
};

const xlsxParser: TimetableParser = {
  name: 'xlsx',
  supports: (fileName) => /\.xlsx$/i.test(fileName),
  parse: (buffer) => parseXlsx(buffer),
};

export const PARSERS: readonly TimetableParser[] = [csvParser, xlsxParser];

/** 明确知道但首版不支持的格式：给出可操作的提示，而不是"未知错误" */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  '.docx': 'Word 文件不受支持，请另存为 CSV 或 XLSX 后重新上传',
  '.doc': 'Word 文件不受支持，请另存为 CSV 或 XLSX 后重新上传',
  '.pdf': 'PDF 不受支持，请提供 CSV 或 XLSX',
  '.xls': '旧版 .xls 不受支持，请另存为 .xlsx',
  '.png': '图片不受支持，首版不做识别',
  '.jpg': '图片不受支持，首版不做识别',
};

export function extensionOf(fileName: string): string {
  const m = /(\.[A-Za-z0-9]+)$/.exec(fileName);
  return m ? m[1]!.toLowerCase() : '';
}

export function selectParser(fileName: string): TimetableParser | null {
  return PARSERS.find((p) => p.supports(fileName)) ?? null;
}

/**
 * 统一入口：先判类型与大小，再交给解析器。
 * 未识别格式一律 UNSUPPORTED_FORMAT，不尝试"猜格式"。
 */
export function parseTimetableFile(fileName: string, buffer: Buffer): ParseResult {
  if (buffer.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '文件为空' };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `文件 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`,
    };
  }

  const parser = selectParser(fileName);
  if (!parser) {
    const ext = extensionOf(fileName);
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: KNOWN_UNSUPPORTED[ext] ?? `不支持的文件类型：${ext || '（无扩展名）'}`,
    };
  }

  // 扩展名对但内容不是（例如把 xlsx 改名成 csv）：由解析器报 MALFORMED
  try {
    return parser.parse(buffer);
  } catch (err) {
    return {
      ok: false,
      code: 'MALFORMED',
      message: err instanceof Error ? err.message : '解析失败',
    };
  }
}

/** 去掉 UTF-8 BOM 并做严格解码；非法字节直接报错，不做替换字符修补 */
export function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('文件不是有效的 UTF-8 编码');
  }
}
