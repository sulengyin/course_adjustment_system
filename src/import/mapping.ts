import type { ImportField, Mapping, MappingProposal, ParsedTable } from './types.js';

/**
 * 表头识别。只做"建议"，最终映射必须由调用方确认后传入。
 * 不根据列位置猜测，不根据内容猜列名。
 */
const ALIASES: Record<ImportField, readonly string[]> = {
  teacher: ['教师', '教师姓名', '任课教师', '授课教师', '老师', '教师工号', 'teacher', 'teacherid', 'teachername'],
  class: ['班级', '班级名称', '班', 'class', 'classid', 'classname'],
  subject: ['科目', '学科', '课程', '课程名称', 'subject', 'subjectid'],
  weekday: ['星期', '星期几', '周几', '上课星期', 'weekday', 'day'],
  period: ['节次', '第几节', '课节', '节', 'period'],
  parity: ['单双周', '周次', '周类型', 'parity'],
  validFrom: ['生效起', '开始日期', '起始日期', 'validfrom'],
  validTo: ['生效止', '结束日期', '终止日期', 'validto'],
};

const REQUIRED: readonly ImportField[] = ['teacher', 'class', 'subject', 'weekday', 'period'];

function normalize(header: string): string {
  return header
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()：:]/g, '')
    .toLowerCase();
}

export function proposeMapping(headers: readonly string[]): MappingProposal {
  const normalized = headers.map(normalize);
  const detected: Partial<Record<ImportField, string>> = {};
  const index: Partial<Record<ImportField, number>> = {};

  for (const field of Object.keys(ALIASES) as ImportField[]) {
    const aliases = ALIASES[field].map(normalize);
    const at = normalized.findIndex((h) => aliases.includes(h));
    if (at >= 0) {
      index[field] = at;
      detected[field] = headers[at] ?? '';
    }
  }

  const missing = REQUIRED.filter((f) => index[f] === undefined);
  const used = new Set(Object.values(index));
  const unmappedHeaders = headers.filter((_, i) => !used.has(i));

  if (missing.length > 0) {
    return { mapping: null, detected, missing, unmappedHeaders };
  }

  return {
    mapping: {
      teacher: index.teacher!,
      class: index.class!,
      subject: index.subject!,
      weekday: index.weekday!,
      period: index.period!,
      parity: index.parity ?? null,
      validFrom: index.validFrom ?? null,
      validTo: index.validTo ?? null,
    },
    detected,
    missing: [],
    unmappedHeaders,
  };
}

export interface RawMappedRow {
  readonly line: number;
  readonly values: Record<ImportField, string>;
}

export function applyMapping(table: ParsedTable, mapping: Mapping): RawMappedRow[] {
  const width = table.headers.length;
  return table.rows.map((row, i) => {
    const at = (idx: number | null): string => (idx === null || idx >= width ? '' : (row[idx] ?? ''));
    return {
      line: i + 2,
      values: {
        teacher: at(mapping.teacher),
        class: at(mapping.class),
        subject: at(mapping.subject),
        weekday: at(mapping.weekday),
        period: at(mapping.period),
        parity: at(mapping.parity),
        validFrom: at(mapping.validFrom),
        validTo: at(mapping.validTo),
      },
    };
  });
}
