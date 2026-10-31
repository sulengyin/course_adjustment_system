import type {
  CalendarException,
  Certainty,
  Term,
  UnknownReason,
  Weekday,
  WeekParity,
} from './model.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 严格解析 YYYY-MM-DD，非法日期（如 2026-02-31）直接抛错，不做静默修正。 */
export function parseDate(date: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`INVALID_DATE_FORMAT:${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`INVALID_DATE:${date}`);
  }
  return dt;
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, days: number): string {
  return formatDate(new Date(parseDate(date).getTime() + days * DAY_MS));
}

/** 0=周日 … 6=周六 */
export function weekdayOf(date: string): number {
  return parseDate(date).getUTCDay();
}

/** to - from，按整天计，DST 无关（全部 UTC）。 */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
}

export function isWeekday(n: number): n is Weekday {
  return n >= 1 && n <= 5;
}

/** 学期内第几周，首周为 0。 */
export function weekIndexOf(term: Term, date: string): number {
  return Math.floor(diffDays(term.startMonday, date) / 7);
}

/**
 * 该周是单周还是双周。
 * 首周口径未声明时返回 null —— 不得回退成"首周为单周"。
 */
export function parityOf(term: Term, weekIndex: number): WeekParity | null {
  if (term.firstWeekParity === null) return null;
  const even = weekIndex % 2 === 0;
  if (even) return term.firstWeekParity;
  return term.firstWeekParity === 'ODD' ? 'EVEN' : 'ODD';
}

export type DayStatus =
  | 'CLASS_DAY'
  | 'SUSPENDED'
  | 'HOLIDAY'
  | 'OUTSIDE_TERM'
  | 'UNKNOWN_CALENDAR';

export interface DayPlan {
  readonly date: string;
  readonly status: DayStatus;
  /** 学期序号；不在学期内为 null */
  readonly weekIndex: number | null;
  /** 单双周；首周口径未配置为 null */
  readonly parity: WeekParity | null;
  /** 实际按哪一天上课；非上课日为 null */
  readonly effectiveWeekday: Weekday | null;
  readonly suspendedPeriods: readonly number[] | 'ALL' | null;
  /** 仅指日历事实本身是否确定，与单双周口径无关 */
  readonly certainty: Certainty;
  readonly unknownReason: UnknownReason | null;
}

function outsideTerm(date: string): DayPlan {
  return {
    date,
    status: 'OUTSIDE_TERM',
    weekIndex: null,
    parity: null,
    effectiveWeekday: null,
    suspendedPeriods: null,
    certainty: 'KNOWN',
    unknownReason: null,
  };
}

function unknownDay(date: string, reason: UnknownReason): DayPlan {
  return {
    date,
    status: 'UNKNOWN_CALENDAR',
    weekIndex: null,
    parity: null,
    effectiveWeekday: null,
    suspendedPeriods: null,
    certainty: 'UNKNOWN',
    unknownReason: reason,
  };
}

/**
 * 解析某一天是否上课、按哪天的课表上课、是否停课。
 * 同一天存在多条例外记录时视为数据冲突，返回 UNKNOWN_CALENDAR，不挑一条用。
 */
export function resolveDay(
  term: Term,
  exceptions: readonly CalendarException[],
  date: string,
): DayPlan {
  // 先校验日期本身，避免非法日期因字符串比较被误判成"学期外"而静默跳过
  parseDate(date);
  if (date < term.startMonday || date > term.endDate) {
    return outsideTerm(date);
  }

  const weekIndex = weekIndexOf(term, date);
  const parity = parityOf(term, weekIndex);
  const matched = exceptions.filter((e) => e.date === date);
  if (matched.length > 1) {
    return unknownDay(date, 'CALENDAR_EXCEPTION_AMBIGUOUS');
  }

  const ex = matched[0];
  if (ex) {
    if (ex.kind === 'HOLIDAY') {
      return {
        date,
        status: 'HOLIDAY',
        weekIndex,
        parity,
        effectiveWeekday: null,
        suspendedPeriods: null,
        certainty: 'KNOWN',
        unknownReason: null,
      };
    }
    if (ex.kind === 'MAKEUP_DAY') {
      if (ex.followsWeekday === null) {
        return unknownDay(date, 'MAKEUP_WEEKDAY_NOT_SPECIFIED');
      }
      return {
        date,
        status: 'CLASS_DAY',
        weekIndex,
        parity,
        effectiveWeekday: ex.followsWeekday,
        suspendedPeriods: null,
        certainty: 'KNOWN',
        unknownReason: null,
      };
    }
    // SUSPENDED
    if (ex.suspendedPeriods === null) {
      return unknownDay(date, 'SUSPENSION_SCOPE_NOT_SPECIFIED');
    }
    const wd = weekdayOf(date);
    if (!isWeekday(wd)) {
      // 周末停课没有意义，按非上课日处理
      return {
        date,
        status: 'HOLIDAY',
        weekIndex,
        parity,
        effectiveWeekday: null,
        suspendedPeriods: null,
        certainty: 'KNOWN',
        unknownReason: null,
      };
    }
    return {
      date,
      status: 'SUSPENDED',
      weekIndex,
      parity,
      effectiveWeekday: wd,
      suspendedPeriods: ex.suspendedPeriods,
      certainty: 'KNOWN',
      unknownReason: null,
    };
  }

  const wd = weekdayOf(date);
  if (!isWeekday(wd)) {
    return {
      date,
      status: 'HOLIDAY',
      weekIndex,
      parity,
      effectiveWeekday: null,
      suspendedPeriods: null,
      certainty: 'KNOWN',
      unknownReason: null,
    };
  }
  return {
    date,
    status: 'CLASS_DAY',
    weekIndex,
    parity,
    effectiveWeekday: wd,
    suspendedPeriods: null,
    certainty: 'KNOWN',
    unknownReason: null,
  };
}

export function eachDate(from: string, to: string): string[] {
  if (to < from) return [];
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
