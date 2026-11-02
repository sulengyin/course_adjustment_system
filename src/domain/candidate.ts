/**
 * P7H 调课对象候选推荐：纯函数，不依赖数据库、HTTP、权限。
 *
 * 定位（重要）：
 *   推荐只回答"谁更可能接得下这节课"，不回答"谁必须接"。
 *   规则全部来自可核验的事实（本学期排课安排、当天课表），不引入任何主观评价分数。
 *   最终仍然要被改派教师本人确认；推荐不代替确认，也不限制发起人只能选推荐名单内的人。
 *
 * 术语：这里的"任教"一律指**本学期当前有效的排课**（模板未撤销），
 *   不是"历史上教过"。已撤销的模板不再计入，避免把过去的关系当成现在的依据。
 *
 * 匹配档位（同班 > 同年级 > 跨年级）：
 *   SAME_CLASS   本学期任教该班级（任意科目）
 *   SAME_GRADE   本学期未任教该班，但任教同年级其他班
 *   CROSS_GRADE  本学期与该班、与该年级都没有任教关系
 *
 * 档位是主排序键：同一个班的其他任课教师（哪怕科目不同）优先于任何其他班的同科教师。
 *   理由：接的是这个班的一节课，熟悉这个班比科目对口更能决定"能不能立刻接下"；
 *   学科对口与课密度只在档位内部起作用，不得跨档位翻转顺序（见分值设计）。
 *
 * 排序键（依次为）：该节次无课 → 档位 → 综合分降序 → 教师 ID 升序（保证结果稳定可复现）。
 */

export type CandidateTier = 'SAME_CLASS' | 'SAME_GRADE' | 'CROSS_GRADE';

/** 本学期的一条任教安排。用模板级事实判断"本学期在教什么"，不受单次调课影响。 */
export interface TeachingFact {
  readonly teacherId: string;
  readonly classId: string;
  readonly subjectId: string;
}

export interface CandidateOccurrence {
  readonly classId: string;
  readonly subjectId: string;
  readonly teacherId: string;
  readonly date: string;
  readonly period: number;
}

export interface CandidateInput {
  /** 要调出的课次 */
  readonly occurrence: CandidateOccurrence;
  /** 本学期教学安排 */
  readonly teaching: readonly TeachingFact[];
  /** 候选池：教师名册（不在册的 ID 一律不作为候选） */
  readonly teachers: readonly { readonly id: string }[];
  /** 班级 → 年级 */
  readonly gradeByClass: Readonly<Record<string, string>>;
  /** 当日有效课次数（不含已停课），用于课程密度 */
  readonly dayCountByTeacher: Readonly<Record<string, number>>;
  /** 该节次已有课的教师 */
  readonly busyAtSlot: readonly string[];
}

export interface Candidate {
  readonly teacherId: string;
  readonly tier: CandidateTier;
  /** 综合分，仅用于排序展示，不代表"能力评价" */
  readonly score: number;
  readonly teachesSubject: boolean;
  /** 该节次本人无课：改派后不会立刻产生撞课 */
  readonly freeAtSlot: boolean;
  readonly dayCount: number;
  /** 人可读的推荐理由；没有一条命中时也如实说明 */
  readonly reasons: readonly string[];
}

/**
 * 档位基础分。相邻档位相差 30，必须大于档位内加分上限（W_SUBJECT + W_LOAD_MAX = 28），
 * 否则"跨年级但科目对口、当天很空"会翻到"同年级不同科"前面，档位就名存实亡。
 */
const W_SAME_CLASS = 60;
const W_SAME_GRADE = 30;
/** 档位内加分：本学期任教科目的教师优先 */
const W_SUBJECT = 20;
/** 档位内加分·当日课程密度：0 节给满 +8，8 节及以上为 0 */
const W_LOAD_MAX = 8;

/** 档位顺序：tier 是主排序键，不参与"谁分高谁在前"的比较 */
const TIER_ORDER: Readonly<Record<CandidateTier, number>> = {
  SAME_CLASS: 0,
  SAME_GRADE: 1,
  CROSS_GRADE: 2,
};

export function rankCandidates(input: CandidateInput): Candidate[] {
  const { occurrence } = input;
  const grade = input.gradeByClass[occurrence.classId] ?? null;
  const busy = new Set(input.busyAtSlot);

  const subjectByTeacher = new Set<string>();
  const classByTeacher = new Set<string>();
  const gradeByTeacher = new Set<string>();
  for (const fact of input.teaching) {
    if (fact.subjectId === occurrence.subjectId) subjectByTeacher.add(fact.teacherId);
    if (fact.classId === occurrence.classId) {
      classByTeacher.add(fact.teacherId);
      continue;
    }
    if (grade !== null && input.gradeByClass[fact.classId] === grade) {
      gradeByTeacher.add(fact.teacherId);
    }
  }

  const out: Candidate[] = [];
  for (const teacher of input.teachers) {
    if (teacher.id === occurrence.teacherId) continue;

    const teachesSubject = subjectByTeacher.has(teacher.id);
    const teachesClass = classByTeacher.has(teacher.id);
    const tier: CandidateTier = teachesClass
      ? 'SAME_CLASS'
      : gradeByTeacher.has(teacher.id)
        ? 'SAME_GRADE'
        : 'CROSS_GRADE';
    const freeAtSlot = !busy.has(teacher.id);
    const dayCount = input.dayCountByTeacher[teacher.id] ?? 0;

    const score =
      (teachesClass ? W_SAME_CLASS : gradeByTeacher.has(teacher.id) ? W_SAME_GRADE : 0) +
      (teachesSubject ? W_SUBJECT : 0) +
      Math.max(0, W_LOAD_MAX - dayCount);

    const reasons: string[] = [];
    if (teachesClass) reasons.push('本学期任教这个班');
    else if (tier === 'SAME_GRADE') reasons.push(`本学期任教同年级（${grade ?? '未知年级'}）其他班`);
    if (teachesSubject) reasons.push('本学期任教同一科目');
    if (freeAtSlot) reasons.push('该节次本人无课');
    else reasons.push('该节次本人有课，需先与对方对调');
    reasons.push(dayCount === 0 ? '当天没有排课' : `当天已排 ${dayCount} 节`);

    out.push({
      teacherId: teacher.id,
      tier,
      score,
      teachesSubject,
      freeAtSlot,
      dayCount,
      reasons,
    });
  }

  out.sort((a, b) => {
    // 可行性先于一切：能直接接下的排在"需要先对调"的前面
    if (a.freeAtSlot !== b.freeAtSlot) return a.freeAtSlot ? -1 : 1;
    // 档位是主排序键：同班 > 同年级 > 跨年级，学科与课密度只在档位内部起作用
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) {
      return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    }
    if (a.score !== b.score) return b.score - a.score;
    return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
  });
  return out;
}
