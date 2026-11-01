/**
 * P3 导入管线的公共类型。
 * 解析器只负责"把文件变成二维表"，不理解业务；业务校验在 validate 层。
 */

export interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type ParseFailureCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EMPTY_FILE'
  | 'MALFORMED'
  | 'TOO_LARGE'
  | 'TOO_MANY_ROWS';

export type ParseResult =
  | { readonly ok: true; readonly table: ParsedTable }
  | { readonly ok: false; readonly code: ParseFailureCode; readonly message: string };

export interface TimetableParser {
  readonly name: string;
  /** 仅按扩展名判断能否处理；内容伪装的文件会在 parse 阶段报 MALFORMED */
  supports(fileName: string): boolean;
  parse(buffer: Buffer): ParseResult;
}

export type ImportField =
  | 'teacher'
  | 'class'
  | 'subject'
  | 'weekday'
  | 'period'
  | 'parity'
  | 'validFrom'
  | 'validTo';

export interface Mapping {
  readonly teacher: number;
  readonly class: number;
  readonly subject: number;
  readonly weekday: number;
  readonly period: number;
  readonly parity: number | null;
  readonly validFrom: number | null;
  readonly validTo: number | null;
}

export interface MappingProposal {
  readonly mapping: Mapping | null;
  readonly detected: Partial<Record<ImportField, string>>;
  readonly missing: readonly ImportField[];
  readonly unmappedHeaders: readonly string[];
}

export interface RowIssue {
  readonly line: number;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ValidatedRow {
  readonly line: number;
  readonly teacherId: string;
  readonly classId: string;
  readonly subjectId: string;
  readonly weekday: 1 | 2 | 3 | 4 | 5;
  readonly period: number;
  readonly parity: 'ALL' | 'ODD' | 'EVEN';
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly rows: readonly ValidatedRow[];
  readonly issues: readonly RowIssue[];
}

export interface DiffReport {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly addedKeys: readonly string[];
  readonly removedKeys: readonly string[];
}
