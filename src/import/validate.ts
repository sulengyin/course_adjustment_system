import { parseDate } from '../domain/calendar.js';
import type { RawMappedRow } from './mapping.js';
import type { RowIssue, ValidatedRow, ValidationReport } from './types.js';

export interface RefLookup {
  readonly id: string;
  readonly name: string;
}

export interface RefResolver {
  teachers(): readonly RefLookup[];
  classes(): readonly RefLookup[];
  subjects(): readonly RefLookup[];
}

type Resolved = { ok: true; id: string } | { ok: false; code: 'UNKNOWN_REF' | 'AMBIGUOUS_REF' };

function resolveOne(list: readonly RefLookup[], value: string): Resolved {
  const v = value.trim();
  if (v === '') return { ok: false, code: 'UNKNOWN_REF' };
  const byId = list.filter((x) => x.id === v);
  if (byId.length === 1) return { ok: true, id: byId[0]!.id };
  const byName = list.filter((x) => x.name.trim() === v);
  if (byName.length === 1) return { ok: true, id: byName[0]!.id };
  if (byName.length > 1 || byId.length > 1) return { ok: false, code: 'AMBIGUOUS_REF' };
  return { ok: false, code: 'UNKNOWN_REF' };
}

const WEEKDAY_MAP: Record<string, 1 | 2 | 3 | 4 | 5> = {
  '1': 1, 一: 1, 周一: 1, 星期一: 1, mon: 1, monday: 1,
  '2': 2, 二: 2, 周二: 2, 星期二: 2, tue: 2, tuesday: 2,
  '3': 3, 三: 3, 周三: 3, 星期三: 3, wed: 3, wednesday: 3,
  '4': 4, 四: 4, 周四: 4, 星期四: 4, thu: 4, thursday: 4,
  '5': 5, 五: 5, 周五: 5, 星期五: 5, fri: 5, friday: 5,
};

export function parseWeekday(raw: string): 1 | 2 | 3 | 4 | 5 | null {
  const key = raw.trim().replace(/[\s\u3000]/g, '').toLowerCase();
  return WEEKDAY_MAP[key] ?? null;
}

export function parsePeriod(raw: string): number | null {
  const cleaned = raw.trim().replace(/^第/, '').replace(/节$/, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n >= 1 && n <= 30 ? n : null;
}

export function parseParity(raw: string): 'ALL' | 'ODD' | 'EVEN' | null {
  const v = raw.trim().toLowerCase();
  if (v === '') return 'ALL';
  if (['每周', '全周', 'all', '每周都上', '常态'].includes(v)) return 'ALL';
  if (['单周', '奇', 'odd', '单', '单周课'].includes(v)) return 'ODD';
  if (['双周', '偶', 'even', '双', '双周课'].includes(v)) return 'EVEN';
  return null;
}

function parsesAsDate(raw: string): boolean {
  try {
    parseDate(raw);
    return true;
  } catch {
    return false;
  }
}

function paritiesOverlap(a: 'ALL' | 'ODD' | 'EVEN', b: 'ALL' | 'ODD' | 'EVEN'): boolean {
  if (a === 'ALL' || b === 'ALL') return true;
  return a === b;
}

/**
 * 逐行校验 + 批内冲突检测。
 * 任何一条 ERROR 都会导致整批拒绝（调用方据此不写入任何数据）。
 */
export function validateRows(
  rows: readonly RawMappedRow[],
  refs: RefResolver,
): ValidationReport {
  const issues: RowIssue[] = [];
  const valid: ValidatedRow[] = [];
  const seen = new Map<string, number>();

  const teachers = refs.teachers();
  const classes = refs.classes();
  const subjects = refs.subjects();

  for (const row of rows) {
    const v = row.values;
    const push = (field: string, code: string, message: string): void => {
      issues.push({ line: row.line, field, code, message });
    };

    if (v.teacher.trim() === '') push('teacher', 'MISSING_VALUE', '教师为空');
    if (v.class.trim() === '') push('class', 'MISSING_VALUE', '班级为空');
    if (v.subject.trim() === '') push('subject', 'MISSING_VALUE', '科目为空');

    const teacher = resolveOne(teachers, v.teacher);
    if (!teacher.ok) {
      push(
        'teacher',
        teacher.code,
        teacher.code === 'AMBIGUOUS_REF' ? `教师"${v.teacher}"匹配到多个人员` : `未知教师"${v.teacher}"`,
      );
    }
    const klass = resolveOne(classes, v.class);
    if (!klass.ok) {
      push(
        'class',
        klass.code,
        klass.code === 'AMBIGUOUS_REF' ? `班级"${v.class}"匹配到多个` : `未知班级"${v.class}"`,
      );
    }
    const subject = resolveOne(subjects, v.subject);
    if (!subject.ok) {
      push(
        'subject',
        subject.code,
        subject.code === 'AMBIGUOUS_REF' ? `科目"${v.subject}"匹配到多个` : `未知科目"${v.subject}"`,
      );
    }

    const weekday = parseWeekday(v.weekday);
    if (weekday === null) push('weekday', 'INVALID_WEEKDAY', `无法识别星期"${v.weekday}"`);

    const period = parsePeriod(v.period);
    if (period === null) push('period', 'INVALID_PERIOD', `无法识别节次"${v.period}"`);

    const parity = parseParity(v.parity);
    if (parity === null) push('parity', 'INVALID_PARITY', `无法识别单双周"${v.parity}"`);

    const from = v.validFrom.trim() === '' ? null : v.validFrom.trim();
    const to = v.validTo.trim() === '' ? null : v.validTo.trim();
    if (from !== null && !parsesAsDate(from)) push('validFrom', 'INVALID_DATE', `生效起不是有效日期"${from}"`);
    if (to !== null && !parsesAsDate(to)) push('validTo', 'INVALID_DATE', `生效止不是有效日期"${to}"`);
    if (from !== null && to !== null && parsesAsDate(from) && parsesAsDate(to) && from > to) {
      push('validTo', 'INVALID_RANGE', `生效止 ${to} 早于生效起 ${from}`);
    }

    if (!teacher.ok || !klass.ok || !subject.ok || weekday === null || period === null || parity === null) {
      continue;
    }
    if (from !== null && !parsesAsDate(from)) continue;
    if (to !== null && !parsesAsDate(to)) continue;
    if (from !== null && to !== null && from > to) continue;

    const key = [teacher.id, klass.id, subject.id, weekday, period, parity, from ?? '', to ?? ''].join('|');
    const dup = seen.get(key);
    if (dup !== undefined) {
      push('teacher', 'DUPLICATE_ROW', `与第 ${dup} 行完全重复`);
      continue;
    }
    seen.set(key, row.line);

    valid.push({
      line: row.line,
      teacherId: teacher.id,
      classId: klass.id,
      subjectId: subject.id,
      weekday,
      period,
      parity,
      validFrom: from,
      validTo: to,
    });
  }

  // 批内结构性冲突：同一教师/同一班级同一时段被排两次
  const byTeacherSlot = new Map<string, ValidatedRow[]>();
  const byClassSlot = new Map<string, ValidatedRow[]>();
  const pushInto = (map: Map<string, ValidatedRow[]>, key: string, row: ValidatedRow): void => {
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  };
  for (const r of valid) {
    pushInto(byTeacherSlot, `${r.teacherId}|${r.weekday}|${r.period}`, r);
    pushInto(byClassSlot, `${r.classId}|${r.weekday}|${r.period}`, r);
  }

  for (const list of byTeacherSlot.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.classId !== b.classId && paritiesOverlap(a.parity, b.parity)) {
          issues.push({
            line: b.line,
            field: 'teacher',
            code: 'TEACHER_DOUBLE_BOOKING',
            message: `教师同一时段被排给多个班（第 ${a.line} 行与第 ${b.line} 行）`,
          });
        }
      }
    }
  }

  for (const list of byClassSlot.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.teacherId !== b.teacherId && paritiesOverlap(a.parity, b.parity)) {
          issues.push({
            line: b.line,
            field: 'class',
            code: 'CLASS_DOUBLE_BOOKING',
            message: `班级同一时段被排了两位教师（第 ${a.line} 行与第 ${b.line} 行）`,
          });
        }
      }
    }
  }

  return { ok: issues.length === 0, rows: valid, issues };
}
