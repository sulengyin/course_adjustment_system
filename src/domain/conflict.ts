import type { Occurrence } from './model.js';

export type ConflictKind = 'TEACHER' | 'CLASS';

export interface ConflictGroup {
  readonly kind: ConflictKind;
  readonly key: string;
  readonly date: string;
  readonly period: number;
  readonly occurrenceIds: readonly string[];
  /** HARD = 可确定是事实矛盾；UNRESOLVED = 至少一方时间不确定，不能断言冲突 */
  readonly level: 'HARD' | 'UNRESOLVED';
  readonly reason: string | null;
}

export interface ConflictReport {
  readonly hard: readonly ConflictGroup[];
  readonly unresolved: readonly ConflictGroup[];
}

/**
 * 结构性冲突检测：同一教师 / 同一班级在同一日期同一节次出现两条以上课次。
 *
 * 只按 (date, period) 判等，不做时段重叠推算 —— 结束时间缺失时无法判断是否重叠，
 * 这类课次一律进入 unresolved，不计入 hard。
 */
export function detectConflicts(occurrences: readonly Occurrence[]): ConflictReport {
  const hard: ConflictGroup[] = [];
  const unresolved: ConflictGroup[] = [];

  for (const kind of ['TEACHER', 'CLASS'] as const) {
    const buckets = new Map<string, Occurrence[]>();
    for (const o of occurrences) {
      const subject = kind === 'TEACHER' ? o.teacherId : o.classId;
      const key = `${kind}:${subject}:${o.date}:${o.period}`;
      const list = buckets.get(key);
      if (list) list.push(o);
      else buckets.set(key, [o]);
    }

    for (const [key, list] of buckets) {
      if (list.length < 2) continue;
      const first = list[0];
      if (!first) continue;
      const allKnown = list.every((o) => o.certainty === 'KNOWN');
      const group: ConflictGroup = {
        kind,
        key,
        date: first.date,
        period: first.period,
        occurrenceIds: list.map((o) => o.id).sort(),
        level: allKnown ? 'HARD' : 'UNRESOLVED',
        reason: allKnown ? null : 'CERTAINTY_UNKNOWN',
      };
      if (allKnown) hard.push(group);
      else unresolved.push(group);
    }
  }

  const bySlot = (a: ConflictGroup, b: ConflictGroup): number =>
    a.date.localeCompare(b.date) || a.period - b.period || a.key.localeCompare(b.key);

  return {
    hard: hard.sort(bySlot),
    unresolved: unresolved.sort(bySlot),
  };
}
