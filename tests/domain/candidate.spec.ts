import { describe, expect, it } from 'vitest';
import { type CandidateInput, rankCandidates } from '../../src/domain/candidate.js';

const OCC = { classId: 'C1', subjectId: 'S1', teacherId: 'T0', date: '2026-10-12', period: 3 };

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    occurrence: OCC,
    teaching: [],
    teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    gradeByClass: { C1: '一年级', C2: '一年级', C9: '三年级' },
    dayCountByTeacher: {},
    busyAtSlot: [],
    ...over,
  };
}

describe('调课对象候选推荐', () => {
  it('同班优先于同年级，同年级优先于跨年级', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
          { teacherId: 'T3', classId: 'C9', subjectId: 'S1' },
        ],
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T1', 'T2', 'T3']);
    expect(ranked.map((c) => c.tier)).toEqual(['SAME_CLASS', 'SAME_GRADE', 'CROSS_GRADE']);
  });

  it('同一档位内，任教同一科目的排在前面', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C1', subjectId: 'S2' },
        ],
      }),
    );
    expect(ranked[0]?.teacherId).toBe('T1');
    expect(ranked[0]?.teachesSubject).toBe(true);
    expect(ranked[1]?.teachesSubject).toBe(false);
  });

  it('任教该班但科目不同的教师，优先于同年级的同科教师', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S2' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
    expect(ranked[0]?.tier).toBe('SAME_CLASS');
    expect(ranked[0]?.teachesSubject).toBe(false);
    expect(ranked[1]?.teachesSubject).toBe(true);
  });

  it('同年级同科优先于跨年级同科', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C2', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C9', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
    expect(ranked.map((c) => c.tier)).toEqual(['SAME_GRADE', 'CROSS_GRADE']);
  });

  it('课程密度再高也不跨档位翻顺序', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S2' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        // T1 当天 8 节（密度分为 0），T2 当天 0 节（密度满分）——档位仍然优先
        dayCountByTeacher: { T1: 8, T2: 0 },
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
  });

  it('该节次有课的一律排在无课之后，即使匹配度更高', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C9', subjectId: 'S9' },
        ],
        busyAtSlot: ['T1'],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T2', 'T1']);
    expect(ranked[1]?.freeAtSlot).toBe(false);
    expect(ranked[1]?.reasons.join('；')).toContain('该节次本人有课，需先与对方对调');
  });

  it('当天课程密度低的排在密度高的前面', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C1', subjectId: 'S1' },
        ],
        dayCountByTeacher: { T1: 6, T2: 1 },
      }),
    );
    expect(ranked[0]?.teacherId).toBe('T2');
    expect(ranked[0]?.dayCount).toBe(1);
  });

  it('本人不作为候选；不在名册中的 ID 也不作为候选', () => {
    const ranked = rankCandidates(
      input({
        teaching: [{ teacherId: 'TX', classId: 'C1', subjectId: 'S1' }],
        teachers: [{ id: 'T0' }, { id: 'T1' }],
      }),
    );
    expect(ranked.map((c) => c.teacherId)).toEqual(['T1']);
  });

  it('排序结果稳定：同分按教师 ID 升序', () => {
    const once = rankCandidates(input());
    const twice = rankCandidates(input());
    expect(once.map((c) => c.teacherId)).toEqual(twice.map((c) => c.teacherId));
    expect(once.map((c) => c.teacherId)).toEqual(['T1', 'T2', 'T3']);
  });

  it('没有命中任何匹配项时理由仍然如实说明，不编造推荐原因', () => {
    const ranked = rankCandidates(input({ teachers: [{ id: 'T3' }] }));
    expect(ranked[0]?.tier).toBe('CROSS_GRADE');
    expect(ranked[0]?.teachesSubject).toBe(false);
    expect(ranked[0]?.reasons).toContain('该节次本人无课');
    expect(ranked[0]?.reasons).toContain('当天没有排课');
  });

  it('理由写的是本学期任教，不写历史上教过', () => {
    const ranked = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S9' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(ranked[0]?.reasons).toContain('本学期任教这个班');
    expect(ranked[0]?.reasons).toContain('本学期任教同一科目');
    expect(ranked[1]?.reasons.join('；')).toContain('本学期任教同年级（一年级）其他班');
    expect(ranked.map((c) => c.reasons.join('；')).join('；')).not.toContain('教过');
  });
});
