import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  eachDate,
  parityOf,
  parseDate,
  resolveDay,
  weekIndexOf,
  weekdayOf,
} from '../../src/domain/calendar.js';
import type { CalendarException, Term } from '../../src/domain/model.js';

const TERM: Term = {
  id: 'T',
  label: '测试学期',
  startMonday: '2026-08-31',
  endDate: '2026-12-31',
  firstWeekParity: 'ODD',
  dataOrigin: 'SIMULATED',
};

function ex(partial: Partial<CalendarException> & { date: string; kind: CalendarException['kind'] }): CalendarException {
  return {
    id: `EX-${partial.date}-${partial.kind}`,
    termId: 'T',
    followsWeekday: null,
    suspendedPeriods: null,
    reason: null,
    dataOrigin: 'SIMULATED',
    ...partial,
  };
}

describe('日期计算', () => {
  it('拒绝非法日期格式与不存在的日期', () => {
    expect(() => parseDate('2026-8-31')).toThrow('INVALID_DATE_FORMAT');
    expect(() => parseDate('2026-02-31')).toThrow('INVALID_DATE');
    expect(() => parseDate('2026-13-01')).toThrow('INVALID_DATE');
  });

  it('跨月加天数', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('星期与天数差', () => {
    expect(weekdayOf('2026-08-31')).toBe(1);
    expect(weekdayOf('2026-09-05')).toBe(6);
    expect(weekdayOf('2026-09-06')).toBe(0);
    expect(diffDays('2026-08-31', '2026-09-07')).toBe(7);
  });

  it('eachDate 包含两端，逆序返回空', () => {
    expect(eachDate('2026-08-31', '2026-09-02')).toEqual(['2026-08-31', '2026-09-01', '2026-09-02']);
    expect(eachDate('2026-09-02', '2026-08-31')).toEqual([]);
  });
});

describe('周序与单双周', () => {
  it('首周为第 0 周', () => {
    expect(weekIndexOf(TERM, '2026-08-31')).toBe(0);
    expect(weekIndexOf(TERM, '2026-09-06')).toBe(0);
    expect(weekIndexOf(TERM, '2026-09-07')).toBe(1);
    expect(weekIndexOf(TERM, '2026-09-14')).toBe(2);
  });

  it('首周口径已声明时按声明推算', () => {
    expect(parityOf(TERM, 0)).toBe('ODD');
    expect(parityOf(TERM, 1)).toBe('EVEN');
    expect(parityOf(TERM, 2)).toBe('ODD');
    expect(parityOf({ ...TERM, firstWeekParity: 'EVEN' }, 0)).toBe('EVEN');
    expect(parityOf({ ...TERM, firstWeekParity: 'EVEN' }, 1)).toBe('ODD');
  });

  it('首周口径未声明时返回 null，不回退成单周', () => {
    const unset: Term = { ...TERM, firstWeekParity: null };
    expect(parityOf(unset, 0)).toBeNull();
    expect(parityOf(unset, 5)).toBeNull();
  });
});

describe('日历解析', () => {
  it('学期外一律 OUTSIDE_TERM', () => {
    expect(resolveDay(TERM, [], '2026-08-30').status).toBe('OUTSIDE_TERM');
    expect(resolveDay(TERM, [], '2027-01-01').status).toBe('OUTSIDE_TERM');
    expect(resolveDay(TERM, [], '2026-08-31').status).toBe('CLASS_DAY');
  });

  it('工作日上课，周末非上课日', () => {
    const mon = resolveDay(TERM, [], '2026-08-31');
    expect(mon.status).toBe('CLASS_DAY');
    expect(mon.effectiveWeekday).toBe(1);
    expect(mon.certainty).toBe('KNOWN');

    expect(resolveDay(TERM, [], '2026-09-05').status).toBe('HOLIDAY');
    expect(resolveDay(TERM, [], '2026-09-06').status).toBe('HOLIDAY');
  });

  it('节假日整天不上课', () => {
    const plan = resolveDay(TERM, [ex({ date: '2026-10-01', kind: 'HOLIDAY' })], '2026-10-01');
    expect(plan.status).toBe('HOLIDAY');
    expect(plan.certainty).toBe('KNOWN');
  });

  it('调休日按指定星期的课表上课（周末也能上课）', () => {
    const plan = resolveDay(
      TERM,
      [ex({ date: '2026-10-10', kind: 'MAKEUP_DAY', followsWeekday: 4 })],
      '2026-10-10',
    );
    expect(weekdayOf('2026-10-10')).toBe(6);
    expect(plan.status).toBe('CLASS_DAY');
    expect(plan.effectiveWeekday).toBe(4);
  });

  it('调休未说明按哪天课表时整日不可判定，不猜', () => {
    const plan = resolveDay(TERM, [ex({ date: '2026-12-02', kind: 'MAKEUP_DAY' })], '2026-12-02');
    expect(plan.status).toBe('UNKNOWN_CALENDAR');
    expect(plan.certainty).toBe('UNKNOWN');
    expect(plan.unknownReason).toBe('MAKEUP_WEEKDAY_NOT_SPECIFIED');
    expect(plan.effectiveWeekday).toBeNull();
  });

  it('停课需说明停哪些节次，未说明则不可判定', () => {
    const partial = resolveDay(
      TERM,
      [ex({ date: '2026-11-11', kind: 'SUSPENDED', suspendedPeriods: [3, 4] })],
      '2026-11-11',
    );
    expect(partial.status).toBe('SUSPENDED');
    expect(partial.suspendedPeriods).toEqual([3, 4]);
    expect(partial.effectiveWeekday).toBe(3);

    const unspecified = resolveDay(TERM, [ex({ date: '2026-11-12', kind: 'SUSPENDED' })], '2026-11-12');
    expect(unspecified.status).toBe('UNKNOWN_CALENDAR');
    expect(unspecified.unknownReason).toBe('SUSPENSION_SCOPE_NOT_SPECIFIED');
  });

  it('考试周：连续停课区间由校方登记，区间外自动恢复', () => {
    const exceptions = [
      ex({ id: 'E1', date: '2026-11-16', kind: 'SUSPENDED', suspendedPeriods: 'ALL' }),
      ex({ id: 'E2', date: '2026-11-17', kind: 'SUSPENDED', suspendedPeriods: 'ALL' }),
      ex({ id: 'E3', date: '2026-11-18', kind: 'SUSPENDED', suspendedPeriods: 'ALL' }),
    ];
    expect(resolveDay(TERM, exceptions, '2026-11-13').status).toBe('CLASS_DAY');
    expect(resolveDay(TERM, exceptions, '2026-11-16').status).toBe('SUSPENDED');
    expect(resolveDay(TERM, exceptions, '2026-11-18').status).toBe('SUSPENDED');
    expect(resolveDay(TERM, exceptions, '2026-11-19').status).toBe('CLASS_DAY');
  });

  it('同一天多条互相矛盾的例外记录 → UNKNOWN_CALENDAR', () => {
    const plan = resolveDay(
      TERM,
      [
        ex({ id: 'A', date: '2026-09-15', kind: 'HOLIDAY' }),
        ex({ id: 'B', date: '2026-09-15', kind: 'SUSPENDED', suspendedPeriods: 'ALL' }),
      ],
      '2026-09-15',
    );
    expect(plan.status).toBe('UNKNOWN_CALENDAR');
    expect(plan.unknownReason).toBe('CALENDAR_EXCEPTION_AMBIGUOUS');
  });

  it('节假日落在调休日时以节假日为准（不叠加两条记录）', () => {
    // 两条不同日期的例外互不影响
    const plan = resolveDay(
      TERM,
      [
        ex({ date: '2026-09-21', kind: 'HOLIDAY' }),
        ex({ date: '2026-09-22', kind: 'SUSPENDED', suspendedPeriods: 'ALL' }),
      ],
      '2026-09-21',
    );
    expect(plan.status).toBe('HOLIDAY');
  });

  it('跨学期边界：学期最后一天仍属于本学期', () => {
    expect(resolveDay(TERM, [], '2026-12-31').status).toBe('CLASS_DAY');
    expect(resolveDay(TERM, [], '2027-01-01').status).toBe('OUTSIDE_TERM');
  });
});
