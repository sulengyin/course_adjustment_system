import { eachDate, resolveDay } from './calendar.js';
import type { DayPlan } from './calendar.js';
import type {
  BellEntry,
  CalendarException,
  Certainty,
  Occurrence,
  TeachingTemplate,
  Term,
  UnknownReason,
} from './model.js';

export interface GenerationContext {
  readonly term: Term;
  readonly bell: readonly BellEntry[];
  readonly templates: readonly TeachingTemplate[];
  readonly exceptions: readonly CalendarException[];
}

/** 契约层（V2.3 / R05）使用的未决代码，与内部 reason 一一对应 */
export type ContractCode = 'UNKNOWN_ROTATION' | 'UNKNOWN_PARITY';

export interface UnresolvedItem {
  readonly templateId: string;
  readonly date: string;
  /** 为什么这节无法生成课次 */
  readonly reason: UnknownReason;
  /** 对外契约代码；非单双周/轮换类未决为 null */
  readonly contractCode: ContractCode | null;
}

export interface DayResult {
  readonly plan: DayPlan;
  readonly occurrences: readonly Occurrence[];
  readonly unresolved: readonly UnresolvedItem[];
}

export interface RangeResult {
  readonly occurrences: readonly Occurrence[];
  readonly unresolved: readonly UnresolvedItem[];
  /** 日历本身无法判定的日期 */
  readonly unknownDays: readonly DayPlan[];
}

function bellFor(ctx: GenerationContext, period: number): BellEntry | undefined {
  return ctx.bell.find((b) => b.period === period);
}

function inValidity(t: TeachingTemplate, date: string): boolean {
  if (t.validFrom !== null && date < t.validFrom) return false;
  if (t.validTo !== null && date > t.validTo) return false;
  return true;
}

function isSuspended(plan: DayPlan, period: number): boolean {
  if (plan.status !== 'SUSPENDED') return false;
  if (plan.suspendedPeriods === 'ALL') return true;
  return plan.suspendedPeriods !== null && plan.suspendedPeriods.includes(period);
}

export function generateDay(ctx: GenerationContext, date: string): DayResult {
  const plan = resolveDay(ctx.term, ctx.exceptions, date);

  if (plan.status === 'OUTSIDE_TERM' || plan.status === 'HOLIDAY' || plan.status === 'UNKNOWN_CALENDAR') {
    return { plan, occurrences: [], unresolved: [] };
  }
  const weekday = plan.effectiveWeekday;
  if (weekday === null) {
    return { plan, occurrences: [], unresolved: [] };
  }

  const occurrences: Occurrence[] = [];
  const unresolved: UnresolvedItem[] = [];

  for (const t of ctx.templates) {
    if (t.termId !== ctx.term.id) continue;
    if (t.weekday !== weekday) continue;
    if (!inValidity(t, date)) continue;
    if (isSuspended(plan, t.period)) continue;

    if (t.rotation === 'CUSTOM') {
      // 轮换口径未定：不生成课次，也不推算出任何值
      unresolved.push({
        templateId: t.id,
        date,
        reason: 'ROTATION_RULE_NOT_CONFIGURED',
        contractCode: 'UNKNOWN_ROTATION',
      });
      continue;
    }

    if (t.parity !== 'ALL') {
      if (plan.parity === null) {
        unresolved.push({
          templateId: t.id,
          date,
          reason: 'PARITY_BASE_NOT_CONFIGURED',
          contractCode: 'UNKNOWN_PARITY',
        });
        continue;
      }
      if (t.parity !== plan.parity) continue;
    }

    const bell = bellFor(ctx, t.period);
    let startsAt: string | null = null;
    let endsAt: string | null = null;
    let unknownReason: UnknownReason | null = null;

    if (!bell) {
      unknownReason = 'BELL_NOT_CONFIGURED';
    } else {
      startsAt = bell.startsAt;
      endsAt = bell.endsAt;
      if (startsAt === null) unknownReason = 'BELL_START_NOT_CONFIGURED';
      else if (endsAt === null) unknownReason = 'BELL_END_NOT_CONFIGURED';
    }

    const certainty: Certainty = unknownReason === null ? 'KNOWN' : 'UNKNOWN';

    occurrences.push({
      id: `${ctx.term.id}|${t.id}|${date}`,
      termId: ctx.term.id,
      templateId: t.id,
      date,
      period: t.period,
      classId: t.classId,
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      startsAt,
      endsAt,
      certainty,
      unknownReason,
      dataOrigin: t.dataOrigin,
    });
  }

  occurrences.sort((a, b) => a.period - b.period || a.classId.localeCompare(b.classId));
  return { plan, occurrences, unresolved };
}

export function generateRange(ctx: GenerationContext, from: string, to: string): RangeResult {
  const occurrences: Occurrence[] = [];
  const unresolved: UnresolvedItem[] = [];
  const unknownDays: DayPlan[] = [];

  for (const date of eachDate(from, to)) {
    const day = generateDay(ctx, date);
    occurrences.push(...day.occurrences);
    unresolved.push(...day.unresolved);
    if (day.plan.status === 'UNKNOWN_CALENDAR') unknownDays.push(day.plan);
  }

  return { occurrences, unresolved, unknownDays };
}
