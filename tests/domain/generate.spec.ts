import { describe, expect, it } from 'vitest';
import { generateDay, generateRange } from '../../src/domain/generate.js';
import type { GenerationContext } from '../../src/domain/generate.js';
import type { BellEntry, CalendarException, TeachingTemplate, Term } from '../../src/domain/model.js';

const TERM: Term = {
  id: 'T',
  label: '测试学期',
  startMonday: '2026-08-31',
  endDate: '2026-12-31',
  firstWeekParity: 'ODD',
  dataOrigin: 'SIMULATED',
};

const BELL: BellEntry[] = [
  { period: 1, startsAt: '08:00', endsAt: '08:40' },
  { period: 2, startsAt: '08:50', endsAt: '09:30' },
  { period: 5, startsAt: '13:30', endsAt: null },
];

function tpl(partial: Partial<TeachingTemplate> & { id: string }): TeachingTemplate {
  return {
    termId: 'T',
    classId: 'C1',
    teacherId: 'T1',
    subjectId: 'S1',
    weekday: 1,
    period: 1,
    parity: 'ALL',
    rotation: 'NONE',
    validFrom: null,
    validTo: null,
    dataOrigin: 'SIMULATED',
    ...partial,
  };
}

function ctx(templates: TeachingTemplate[], exceptions: CalendarException[] = [], term: Term = TERM): GenerationContext {
  return { term, bell: BELL, templates, exceptions, };
}

describe('课次生成', () => {
  it('正常课次：时间齐全，certainty=KNOWN', () => {
    const r = generateDay(ctx([tpl({ id: 'A' })]), '2026-08-31');
    expect(r.occurrences).toHaveLength(1);
    const o = r.occurrences[0]!;
    expect(o.startsAt).toBe('08:00');
    expect(o.endsAt).toBe('08:40');
    expect(o.certainty).toBe('KNOWN');
    expect(o.unknownReason).toBeNull();
    expect(o.id).toBe('T|A|2026-08-31');
  });

  it('只有开始时间：不产生 ends_at，标记 UNKNOWN', () => {
    const r = generateDay(ctx([tpl({ id: 'B', period: 5 })]), '2026-08-31');
    const o = r.occurrences[0]!;
    expect(o.startsAt).toBe('13:30');
    expect(o.endsAt).toBeNull();
    expect(o.certainty).toBe('UNKNOWN');
    expect(o.unknownReason).toBe('BELL_END_NOT_CONFIGURED');
  });

  it('作息表缺该节次：时间全空，标记 UNKNOWN', () => {
    const r = generateDay(ctx([tpl({ id: 'C', period: 4 })]), '2026-08-31');
    const o = r.occurrences[0]!;
    expect(o.startsAt).toBeNull();
    expect(o.endsAt).toBeNull();
    expect(o.certainty).toBe('UNKNOWN');
    expect(o.unknownReason).toBe('BELL_NOT_CONFIGURED');
  });

  it('轮换课不生成任何课次，只报告 UNKNOWN_ROTATION', () => {
    const r = generateDay(ctx([tpl({ id: 'R', rotation: 'CUSTOM' })]), '2026-08-31');
    expect(r.occurrences).toHaveLength(0);
    expect(r.unresolved).toEqual([
      {
        templateId: 'R',
        date: '2026-08-31',
        reason: 'ROTATION_RULE_NOT_CONFIGURED',
        contractCode: 'UNKNOWN_ROTATION',
      },
    ]);
  });

  it('首周口径未配置时，单双周课程不生成课次', () => {
    const term: Term = { ...TERM, firstWeekParity: null };
    const r = generateDay(
      ctx([tpl({ id: 'P', parity: 'ODD' })], [], term),
      '2026-08-31',
    );
    expect(r.occurrences).toHaveLength(0);
    expect(r.unresolved[0]?.reason).toBe('PARITY_BASE_NOT_CONFIGURED');
    expect(r.unresolved[0]?.contractCode).toBe('UNKNOWN_PARITY');
  });

  it('首周口径未配置不影响每周都上的课程', () => {
    const term: Term = { ...TERM, firstWeekParity: null };
    const r = generateDay(ctx([tpl({ id: 'A', parity: 'ALL' })], [], term), '2026-08-31');
    expect(r.occurrences).toHaveLength(1);
    expect(r.unresolved).toHaveLength(0);
  });

  it('单双周按周序过滤', () => {
    const templates = [tpl({ id: 'ODD1', parity: 'ODD' }), tpl({ id: 'EVEN1', parity: 'EVEN' })];
    expect(generateDay(ctx(templates), '2026-08-31').occurrences.map((o) => o.templateId)).toEqual(['ODD1']);
    expect(generateDay(ctx(templates), '2026-09-07').occurrences.map((o) => o.templateId)).toEqual(['EVEN1']);
    expect(generateDay(ctx(templates), '2026-09-14').occurrences.map((o) => o.templateId)).toEqual(['ODD1']);
  });

  it('节假日不生成课次', () => {
    const exceptions: CalendarException[] = [
      {
        id: 'H',
        termId: 'T',
        date: '2026-10-01',
        kind: 'HOLIDAY',
        followsWeekday: null,
        suspendedPeriods: null,
        reason: null,
        dataOrigin: 'SIMULATED',
      },
    ];
    // 2026-10-01 是周四
    const r = generateDay(ctx([tpl({ id: 'THU', weekday: 4 })], exceptions), '2026-10-01');
    expect(r.occurrences).toHaveLength(0);
    expect(r.plan.status).toBe('HOLIDAY');
  });

  it('调休日按指定星期的课表生成', () => {
    const exceptions: CalendarException[] = [
      {
        id: 'M',
        termId: 'T',
        date: '2026-10-10',
        kind: 'MAKEUP_DAY',
        followsWeekday: 4,
        suspendedPeriods: null,
        reason: null,
        dataOrigin: 'SIMULATED',
      },
    ];
    const r = generateDay(ctx([tpl({ id: 'THU', weekday: 4 })], exceptions), '2026-10-10');
    expect(r.occurrences.map((o) => o.templateId)).toEqual(['THU']);
  });

  it('停课只停指定节次', () => {
    const exceptions: CalendarException[] = [
      {
        id: 'S',
        termId: 'T',
        date: '2026-11-11',
        kind: 'SUSPENDED',
        followsWeekday: null,
        suspendedPeriods: [3],
        reason: '校运会',
        dataOrigin: 'SIMULATED',
      },
    ];
    // 2026-11-11 是周三
    const templates = [
      tpl({ id: 'P1', weekday: 3, period: 1 }),
      tpl({ id: 'P3', weekday: 3, period: 3 }),
    ];
    const r = generateDay(ctx(templates, exceptions), '2026-11-11');
    expect(r.occurrences.map((o) => o.templateId)).toEqual(['P1']);
  });

  it('模板有效期外不生成', () => {
    const t = tpl({ id: 'V', validTo: '2026-10-31' });
    expect(generateDay(ctx([t]), '2026-10-26').occurrences).toHaveLength(1);
    expect(generateDay(ctx([t]), '2026-11-02').occurrences).toHaveLength(0);
  });

  it('区间生成跨学期边界不越界', () => {
    const r = generateRange(ctx([tpl({ id: 'A' })]), '2026-12-28', '2027-01-04');
    expect(r.occurrences.map((o) => o.date)).toEqual(['2026-12-28']);
  });

  it('无效日期直接抛错，不静默跳过', () => {
    expect(() => generateDay(ctx([tpl({ id: 'A' })]), '2026-02-30')).toThrow('INVALID_DATE');
  });
});
