import { resolveDay } from '../domain/calendar.js';
import { detectConflicts } from '../domain/conflict.js';
import type { ConflictReport } from '../domain/conflict.js';
import { generateRange } from '../domain/generate.js';
import type { GenerationContext, UnresolvedItem } from '../domain/generate.js';
import type { Occurrence, SchoolSnapshot } from '../domain/model.js';
import type { CourseDatabase, TimetableRow } from '../store/database.js';

export interface UnknownDay {
  readonly date: string;
  readonly reason: string;
}

/** 课次 ID 内部含 "|"，比较行时用不会冲突的分隔符 */
export const ROW_SEP = '\u001f';

export interface TimetableView {
  readonly rows: readonly TimetableRow[];
  readonly unresolved: readonly UnresolvedItem[];
  readonly unknownDays: readonly UnknownDay[];
  /** 视图是否完整：存在无法判定的日期或课次时为 false */
  readonly complete: boolean;
}

export interface BuildResult {
  readonly termId: string;
  readonly from: string;
  readonly to: string;
  readonly occurrenceCount: number;
  readonly unresolved: readonly UnresolvedItem[];
  readonly unknownDays: readonly UnknownDay[];
  readonly conflicts: ConflictReport;
}

export class TimetableService {
  constructor(private readonly db: CourseDatabase) {}

  load(snapshot: SchoolSnapshot): void {
    this.db.loadSnapshot(snapshot);
  }

  private context(termId: string): GenerationContext {
    const found = this.db.getTerm(termId);
    if (!found) throw new Error(`TERM_NOT_FOUND:${termId}`);
    return {
      term: found.term,
      bell: this.db.getBell(termId),
      templates: this.db.getTemplates(termId),
      exceptions: this.db.getExceptions(termId),
    };
  }

  /** 由模板 + 校历 + 作息重建派生课次，并给出结构性冲突报告。 */
  build(termId: string, from: string, to: string): BuildResult {
    const ctx = this.context(termId);
    const result = generateRange(ctx, from, to);
    this.db.materialize(termId, from, to, result.occurrences);
    return {
      termId,
      from,
      to,
      occurrenceCount: result.occurrences.length,
      unresolved: result.unresolved,
      unknownDays: result.unknownDays.map((d) => ({ date: d.date, reason: d.unknownReason ?? 'UNKNOWN_CALENDAR' })),
      conflicts: detectConflicts(result.occurrences),
    };
  }

  teacherView(termId: string, teacherId: string, from: string, to: string): TimetableView {
    return this.view(termId, from, to, this.db.queryByTeacher(termId, teacherId, from, to), teacherId);
  }

  classView(termId: string, classId: string, from: string, to: string): TimetableView {
    return this.view(termId, from, to, this.db.queryByClass(termId, classId, from, to), classId);
  }

  private view(
    termId: string,
    from: string,
    to: string,
    rows: readonly TimetableRow[],
    subjectId: string,
  ): TimetableView {
    const ctx = this.context(termId);
    const result = generateRange(ctx, from, to);
    const unresolved = result.unresolved.filter((u) => {
      // 只返回与该教师/班级相关的未决课次
      const template = ctx.templates.find((t) => t.id === u.templateId);
      if (!template) return false;
      return template.teacherId === subjectId || template.classId === subjectId;
    });
    const unknownDays: UnknownDay[] = result.unknownDays.map((d) => ({
      date: d.date,
      reason: d.unknownReason ?? 'UNKNOWN_CALENDAR',
    }));
    return {
      rows,
      unresolved,
      unknownDays,
      complete: unresolved.length === 0 && unknownDays.length === 0,
    };
  }

  /** 只读：当前库内已生成的课次 */
  storedOccurrences(termId: string, from: string, to: string): readonly TimetableRow[] {
    return this.db.queryAll(termId, from, to);
  }

  /** 单日解释：某天为什么有/没有课（用于查询页展示"待核验"） */
  explainDay(termId: string, date: string): {
    status: string;
    weekday: number | null;
    parity: string | null;
    certainty: string;
    reason: string | null;
  } {
    const ctx = this.context(termId);
    const plan = resolveDay(ctx.term, ctx.exceptions, date);
    return {
      status: plan.status,
      weekday: plan.effectiveWeekday,
      parity: plan.parity,
      certainty: plan.certainty,
      reason: plan.unknownReason,
    };
  }
}

/** 便于测试与演示：把课次转成稳定字符串，用于比较两个视图是否一致 */
export function canonicalRow(row: TimetableRow): string {
  return [
    row.occurrenceId,
    row.date,
    row.period,
    row.startsAt ?? '-',
    row.endsAt ?? '-',
    row.certainty,
    row.classId,
    row.teacherId,
    row.subjectId,
  ].join(ROW_SEP);
}

export function canonicalOccurrence(o: Occurrence): string {
  return [
    o.id,
    o.date,
    o.period,
    o.startsAt ?? '-',
    o.endsAt ?? '-',
    o.certainty,
    o.classId,
    o.teacherId,
    o.subjectId,
  ].join(ROW_SEP);
}
