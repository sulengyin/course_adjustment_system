import { describe, expect, it } from 'vitest';
import {
  type CandidateInput,
  type CandidatePreference,
  NEUTRAL_PREFERENCE,
  evaluateSwapOption,
  lessonMinutes,
  rankCandidates,
  swapHints,
} from '../../src/domain/candidate.js';

const OCC = { classId: 'C1', subjectId: 'S1', teacherId: 'T0', date: '2026-10-12', period: 3 };

function pref(over: {
  consider?: Partial<CandidatePreference['consider']>;
  exclude?: Partial<CandidatePreference['exclude']>;
  hint?: Partial<CandidatePreference['hint']>;
} = {}): CandidatePreference {
  return {
    consider: { ...NEUTRAL_PREFERENCE.consider, ...over.consider },
    exclude: { ...NEUTRAL_PREFERENCE.exclude, ...over.exclude },
    hint: { ...NEUTRAL_PREFERENCE.hint, ...over.hint },
  };
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    occurrence: OCC,
    teaching: [],
    teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    gradeByClass: { C1: '一年级', C2: '一年级', C9: '三年级' },
    dayPeriodsByTeacher: {},
    busyAtSlot: [],
    preference: pref(),
    ...over,
  };
}

describe('调课对象候选推荐', () => {
  it('同班优先于同年级，同年级优先于跨年级', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
          { teacherId: 'T3', classId: 'C9', subjectId: 'S1' },
        ],
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T1', 'T2', 'T3']);
    expect(candidates.map((c) => c.tier)).toEqual(['SAME_CLASS', 'SAME_GRADE', 'CROSS_GRADE']);
  });

  it('同一档位内，任教同一科目的排在前面', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C1', subjectId: 'S2' },
        ],
      }),
    );
    expect(candidates[0]?.teacherId).toBe('T1');
    expect(candidates[0]?.teachesSubject).toBe(true);
    expect(candidates[1]?.teachesSubject).toBe(false);
  });

  it('任教该班但科目不同的教师，优先于同年级的同科教师', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S2' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
    expect(candidates[0]?.tier).toBe('SAME_CLASS');
    expect(candidates[0]?.teachesSubject).toBe(false);
    expect(candidates[1]?.teachesSubject).toBe(true);
  });

  it('同年级同科优先于跨年级同科', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C2', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C9', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
    expect(candidates.map((c) => c.tier)).toEqual(['SAME_GRADE', 'CROSS_GRADE']);
  });

  it('课程密度再高也不跨档位翻顺序', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S2' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S1' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        dayPeriodsByTeacher: { T1: [1, 2, 3, 4, 5, 6, 7, 8], T2: [] },
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T1', 'T2']);
  });

  it('该节次有课的一律排在无课之后，即使匹配度更高', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C9', subjectId: 'S9' },
        ],
        busyAtSlot: ['T1'],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T2', 'T1']);
    expect(candidates[1]?.freeAtSlot).toBe(false);
    expect(candidates[1]?.reasons.join('；')).toContain('该节次本人有课，需先解决该时段冲突');
  });

  it('当天课程密度低的排在密度高的前面', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C1', subjectId: 'S1' },
        ],
        dayPeriodsByTeacher: { T1: [1, 2, 3, 4, 5, 6], T2: [7] },
      }),
    );
    expect(candidates[0]?.teacherId).toBe('T2');
    expect(candidates[0]?.dayCount).toBe(1);
    expect(candidates[0]?.dayCountAfter).toBe(2);
  });

  it('本人不作为候选；不在名册中的 ID 也不作为候选', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [{ teacherId: 'TX', classId: 'C1', subjectId: 'S1' }],
        teachers: [{ id: 'T0' }, { id: 'T1' }],
      }),
    );
    expect(candidates.map((c) => c.teacherId)).toEqual(['T1']);
  });

  it('排序结果稳定：同分按教师 ID 升序', () => {
    const once = rankCandidates(input());
    const twice = rankCandidates(input());
    expect(once.candidates.map((c) => c.teacherId)).toEqual(twice.candidates.map((c) => c.teacherId));
    expect(once.candidates.map((c) => c.teacherId)).toEqual(['T1', 'T2', 'T3']);
  });

  it('没有命中任何匹配项时理由仍然如实说明，不编造推荐原因', () => {
    const { candidates } = rankCandidates(input({ teachers: [{ id: 'T3' }] }));
    expect(candidates[0]?.tier).toBe('CROSS_GRADE');
    expect(candidates[0]?.teachesSubject).toBe(false);
    expect(candidates[0]?.reasons).toContain('该节次本人无课');
    expect(candidates[0]?.reasons).toContain('当天没有排课');
  });

  it('理由写的是本学期任教，不写历史上教过', () => {
    const { candidates } = rankCandidates(
      input({
        teaching: [
          { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
          { teacherId: 'T2', classId: 'C2', subjectId: 'S9' },
        ],
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
      }),
    );
    expect(candidates[0]?.reasons).toContain('本学期任教这个班');
    expect(candidates[0]?.reasons).toContain('本学期任教同一科目');
    expect(candidates[1]?.reasons.join('；')).toContain('本学期任教同年级（一年级）其他班');
    expect(candidates.map((c) => c.reasons.join('；')).join('；')).not.toContain('教过');
  });
});

describe('偏好：排除条件', () => {
  it('默认不隐藏任何人，只排序', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        busyAtSlot: ['T1'],
        dayPeriodsByTeacher: { T1: [3, 4, 5, 6, 7, 8, 9] },
      }),
    );
    expect(excluded).toEqual([]);
    expect(candidates.map((c) => c.teacherId)).toContain('T1');
  });

  it('勾选后排除该节次有课的教师，并给出原因', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        busyAtSlot: ['T1'],
        preference: pref({ exclude: { busyAtSlot: true } }),
      }),
    );
    expect(candidates.map((c) => c.teacherId)).not.toContain('T1');
    expect(excluded.map((e) => e.teacherId)).toEqual(['T1']);
    expect(excluded[0]?.reasons.join('；')).toContain('该节次本人有课');
  });

  it('排除"接手后连上三节"的教师：只看教师本人连堂', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        // T1 第 2、3 节有课，接手第 4 节 → 连续 4 节（2,3,4 连续 3 节）
        dayPeriodsByTeacher: { T1: [2, 3], T2: [7] },
        targetPeriod: 4,
        preference: pref({ exclude: { consecutive: true, consecutiveLimit: 3 } }),
      }),
    );
    expect(excluded.map((e) => e.teacherId)).toEqual(['T1']);
    expect(excluded[0]?.reasons.join('；')).toContain('连续上 3 节');
    expect(candidates.map((c) => c.teacherId)).toContain('T2');
  });

  it('连堂事实即使不排除也写进理由', () => {
    const { candidates } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        dayPeriodsByTeacher: { T1: [2, 3] },
        targetPeriod: 4,
      }),
    );
    expect(candidates[0]?.longestRunAfter).toBe(3);
    expect(candidates[0]?.reasons.join('；')).toContain('接手后将连续上 3 节');
  });

  it('排除"接手后当天超过上限"的教师', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        dayPeriodsByTeacher: { T1: [1, 2, 4, 5, 6], T2: [7] },
        preference: pref({ exclude: { dayTotal: true, dayTotalLimit: 5 } }),
      }),
    );
    expect(excluded.map((e) => e.teacherId)).toEqual(['T1']);
    expect(excluded[0]?.reasons.join('；')).toContain('当天共 6 节');
    expect(candidates.map((c) => c.teacherId)).toContain('T2');
  });
});

describe('偏好：只提示不排除', () => {
  it('该班当天同一科目达到阈值时只提示，不把教师排除', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        classSubjectDayCount: 2,
        preference: pref({ hint: { classSubjectDay: true, classSubjectDayLimit: 2 } }),
      }),
    );
    expect(excluded).toEqual([]);
    expect(candidates[0]?.hints.join('；')).toContain('该班当天该科目共 2 节');
  });

  it('未达阈值时不提示，不编造', () => {
    const { candidates } = rankCandidates(
      input({
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        classSubjectDayCount: 1,
      }),
    );
    expect(candidates[0]?.hints).toEqual([]);
  });
});

describe('提示：语数教师接手后只剩上午第4节', () => {
  const period4 = { ...OCC, period: 4 };

  it('语数教师当天原本没课、调入第4节时提示，且不排除该教师', () => {
    const { candidates, excluded } = rankCandidates(
      input({
        occurrence: period4,
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        languageMathTeacherIds: ['T1'],
        dayPeriodsByTeacher: {},
      }),
    );
    expect(excluded).toEqual([]);
    const t1 = candidates.find((c) => c.teacherId === 'T1');
    expect(t1?.hints.join('；')).toContain('当天只有上午第4节');
  });

  it('调入第1至第3节时不提示：孤节在上午前段不算专程跑一趟', () => {
    const { candidates } = rankCandidates(
      input({
        occurrence: { ...OCC, period: 3 },
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        languageMathTeacherIds: ['T1'],
        dayPeriodsByTeacher: {},
      }),
    );
    expect(candidates.find((c) => c.teacherId === 'T1')?.hints).toEqual([]);
  });

  it('当天已有课时不提示：接手后不止这一节，人本来就在学校', () => {
    const { candidates } = rankCandidates(
      input({
        occurrence: period4,
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        languageMathTeacherIds: ['T1'],
        dayPeriodsByTeacher: { T1: [2] },
      }),
    );
    expect(candidates.find((c) => c.teacherId === 'T1')?.hints).toEqual([]);
  });

  it('非语数教师不提示：同样的空课日不算同一类风险', () => {
    const { candidates } = rankCandidates(
      input({
        occurrence: period4,
        teachers: [{ id: 'T0' }, { id: 'T1' }],
        languageMathTeacherIds: ['T2'],
        dayPeriodsByTeacher: {},
      }),
    );
    expect(candidates.find((c) => c.teacherId === 'T1')?.hints).toEqual([]);
  });
});

describe('偏好：考虑项可关闭', () => {
  it('关闭"任教该班"后，同班不再因此加分', () => {
    const ranked = {
      on: rankCandidates(
        input({
          teaching: [
            { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
            { teacherId: 'T2', classId: 'C1', subjectId: 'S1' },
          ],
          teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
        }),
      ),
      off: rankCandidates(
        input({
          teaching: [
            { teacherId: 'T1', classId: 'C1', subjectId: 'S1' },
            { teacherId: 'T2', classId: 'C1', subjectId: 'S1' },
          ],
          teachers: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }],
          preference: pref({ consider: { sameClass: false } }),
        }),
      ),
    };
    expect(ranked.on.candidates[0]?.score).toBeGreaterThan(ranked.off.candidates[0]?.score ?? 0);
    // 关闭后档位不再由同班决定，但 tier 仍如实反映任教关系
    expect(ranked.off.candidates[0]?.tier).toBe('SAME_CLASS');
  });

  it('中性默认：全部维度参与排序，不隐藏任何人', () => {
    expect(NEUTRAL_PREFERENCE.consider).toEqual({
      sameClass: true,
      sameGrade: true,
      sameSubject: true,
      lightLoad: true,
    });
    expect(NEUTRAL_PREFERENCE.exclude.busyAtSlot).toBe(false);
    expect(NEUTRAL_PREFERENCE.exclude.consecutive).toBe(false);
    expect(NEUTRAL_PREFERENCE.exclude.dayTotal).toBe(false);
    expect(NEUTRAL_PREFERENCE.exclude.consecutiveLimit).toBe(3);
    expect(NEUTRAL_PREFERENCE.hint.classSubjectDayLimit).toBe(2);
  });
});

describe('对调提示：对方让出后当天还剩几节', () => {
  const hint = (isLanguageMath: boolean, remainingPeriods: number[]): string =>
    swapHints({ isLanguageMath, remainingPeriods }).join('；');

  it('语数教师让出后当天没有课时提示', () => {
    expect(hint(true, [])).toContain('当天没有课');
  });

  it('语数教师让出后只剩上午第4节时提示', () => {
    expect(hint(true, [4])).toContain('只有上午第4节');
  });

  it('只剩第1至第3节的孤节不提示：人上午本来就要到校', () => {
    expect(hint(true, [2])).toBe('');
    expect(hint(true, [3])).toBe('');
  });

  it('还剩两节及以上不提示', () => {
    expect(hint(true, [3, 4])).toBe('');
    expect(hint(true, [1, 4, 5])).toBe('');
  });

  it('非语数教师不提示：同样的剩余节次不算同一类风险', () => {
    expect(hint(false, [])).toBe('');
    expect(hint(false, [4])).toBe('');
  });
});

describe('对调口径：按"换完之后"实算，不按 +1 近似', () => {
  const pref = (over: Partial<typeof NEUTRAL_PREFERENCE.exclude> = {}) => ({
    ...NEUTRAL_PREFERENCE,
    exclude: { ...NEUTRAL_PREFERENCE.exclude, ...over },
  });

  it('同一天换课：课数不变，连堂按换后的节次算', () => {
    const r = evaluateSwapOption({
      isSameClass: true,
      teachesSubject: true,
      myDate: '2026-11-02',
      myPeriod: 4,
      lessonDate: '2026-11-02',
      lessonPeriod: 1,
      theirPeriodsOnMyDate: [1, 2],
      preference: pref(),
    });
    // 对方原本 1、2 节；让出第 1 节、接手第 4 节 → 当天是 2、4 两节
    expect(r.dayCountAfter).toBe(2);
    expect(r.longestRunAfter).toBe(1);
  });

  it('跨天换课：那天多一节，但不把让出的那节算进去', () => {
    const r = evaluateSwapOption({
      isSameClass: true,
      teachesSubject: false,
      myDate: '2026-11-02',
      myPeriod: 4,
      lessonDate: '2026-11-05',
      lessonPeriod: 3,
      theirPeriodsOnMyDate: [2, 3],
      preference: pref(),
    });
    // 对方在我这天原本 2、3 节，接手我的第 4 节 → 2、3、4 三节连上
    expect(r.dayCountAfter).toBe(3);
    expect(r.longestRunAfter).toBe(3);
  });

  it('偏好要求排除连堂时，达到上限给出具体理由而不是静默丢人', () => {
    const r = evaluateSwapOption({
      isSameClass: true,
      teachesSubject: false,
      myDate: '2026-11-02',
      myPeriod: 4,
      lessonDate: '2026-11-05',
      lessonPeriod: 3,
      theirPeriodsOnMyDate: [1, 2, 3],
      preference: pref({ consecutive: true, consecutiveLimit: 3 }),
    });
    expect(r.longestRunAfter).toBe(4);
    expect(r.excludedBy.join('；')).toContain('连续上 4 节');
  });

  it('偏好要求排除当天总量时，超过上限给出理由', () => {
    const r = evaluateSwapOption({
      isSameClass: true,
      teachesSubject: false,
      myDate: '2026-11-02',
      myPeriod: 6,
      lessonDate: '2026-11-05',
      lessonPeriod: 3,
      theirPeriodsOnMyDate: [1, 2, 3, 4, 5],
      preference: pref({ dayTotal: true, dayTotalLimit: 5 }),
    });
    expect(r.dayCountAfter).toBe(6);
    expect(r.excludedBy.join('；')).toContain('当天 6 节');
  });
});

describe('单节时长：对调必须同时长才能换', () => {
  it('按起止时间算分钟数', () => {
    expect(lessonMinutes('08:20', '09:00')).toBe(40);
    expect(lessonMinutes('11:20', '11:40')).toBe(20);
    expect(lessonMinutes('15:05', '15:40')).toBe(35);
    expect(lessonMinutes('08:00', '08:45')).toBe(45);
  });

  it('缺起止时间或格式不对一律返回 null，交给上层拒绝', () => {
    expect(lessonMinutes(null, '09:00')).toBeNull();
    expect(lessonMinutes('08:00', null)).toBeNull();
    expect(lessonMinutes('', '')).toBeNull();
    expect(lessonMinutes('八点', '09:00')).toBeNull();
    expect(lessonMinutes('24:00', '24:30')).toBeNull();
    expect(lessonMinutes('08:70', '09:00')).toBeNull();
  });

  it('起止相同或结束早于开始返回 null，不产生负数或零时长', () => {
    expect(lessonMinutes('09:00', '09:00')).toBeNull();
    expect(lessonMinutes('09:00', '08:00')).toBeNull();
  });

  it('第 4 节 20 分钟与其余 40 分钟不相等，这正是不可对调的依据', () => {
    const p4 = lessonMinutes('11:20', '11:40');
    const p1 = lessonMinutes('08:20', '09:00');
    expect(p4).not.toBe(p1);
    expect(lessonMinutes('11:20', '11:40')).toBe(p4);
  });
});
