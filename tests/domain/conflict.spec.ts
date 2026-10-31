import { describe, expect, it } from 'vitest';
import { detectConflicts } from '../../src/domain/conflict.js';
import type { Occurrence } from '../../src/domain/model.js';

function occ(partial: Partial<Occurrence> & { id: string }): Occurrence {
  return {
    termId: 'T',
    templateId: 'TP',
    date: '2026-08-31',
    period: 1,
    classId: 'C1',
    teacherId: 'T1',
    subjectId: 'S1',
    startsAt: '08:00',
    endsAt: '08:40',
    certainty: 'KNOWN',
    unknownReason: null,
    dataOrigin: 'SIMULATED',
    ...partial,
  };
}

describe('结构性冲突', () => {
  it('同一教师同一时段两个班 → HARD', () => {
    const report = detectConflicts([
      occ({ id: 'A', classId: 'C1' }),
      occ({ id: 'B', classId: 'C2' }),
    ]);
    expect(report.hard).toHaveLength(1);
    expect(report.hard[0]?.kind).toBe('TEACHER');
    expect(report.hard[0]?.occurrenceIds).toEqual(['A', 'B']);
    expect(report.unresolved).toHaveLength(0);
  });

  it('同一班级同一时段两位教师 → HARD', () => {
    const report = detectConflicts([
      occ({ id: 'A', teacherId: 'T1' }),
      occ({ id: 'B', teacherId: 'T2' }),
    ]);
    expect(report.hard.map((c) => c.kind)).toContain('CLASS');
    expect(report.hard.find((c) => c.kind === 'CLASS')?.occurrenceIds).toEqual(['A', 'B']);
  });

  it('任一时间不确定时不判硬冲突，只列为待核验', () => {
    const report = detectConflicts([
      occ({ id: 'A', classId: 'C1' }),
      occ({ id: 'B', classId: 'C2', certainty: 'UNKNOWN', endsAt: null, unknownReason: 'BELL_END_NOT_CONFIGURED' }),
    ]);
    expect(report.hard).toHaveLength(0);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.reason).toBe('CERTAINTY_UNKNOWN');
  });

  it('不同时段、不同日期不算冲突', () => {
    expect(
      detectConflicts([occ({ id: 'A' }), occ({ id: 'B', period: 2 })]).hard,
    ).toHaveLength(0);
    expect(
      detectConflicts([occ({ id: 'A' }), occ({ id: 'B', date: '2026-09-07' })]).hard,
    ).toHaveLength(0);
  });

  it('同一时段三个班 → 一条冲突组含三个 ID', () => {
    const report = detectConflicts([
      occ({ id: 'A', classId: 'C1' }),
      occ({ id: 'B', classId: 'C2' }),
      occ({ id: 'C', classId: 'C3' }),
    ]);
    expect(report.hard).toHaveLength(1);
    expect(report.hard[0]?.occurrenceIds).toEqual(['A', 'B', 'C']);
  });
});
