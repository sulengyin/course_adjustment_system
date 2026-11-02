/**
 * P7H/P7I 调课对象候选推荐：纯函数，不依赖数据库、HTTP、权限。
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
 * 偏好（P7I）：考虑哪些维度、排除哪些教师，由学校设默认值、教师自己覆盖。
 *   系统不替学校把口径写死——但两条边界不开放：
 *     1. 偏好只影响"给发起人看的排序与显示"，不影响确认集合与冲突判定；
 *     2. 被排除的教师必须连同原因一并返回，不允许悄悄消失。
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

/** 参与排序的维度。关闭的维度不加分，但仍然照实展示理由。 */
export interface CandidateConsider {
  readonly sameClass: boolean;
  readonly sameGrade: boolean;
  readonly sameSubject: boolean;
  readonly lightLoad: boolean;
}

/** 硬排除。全部默认关闭：默认只排序、不隐藏任何人。 */
export interface CandidateExclude {
  readonly busyAtSlot: boolean;
  readonly consecutive: boolean;
  readonly consecutiveLimit: number;
  readonly dayTotal: boolean;
  readonly dayTotalLimit: number;
}

/** 只提示、永不排除的项：判断权留给人，系统只给事实。 */
export interface CandidateHint {
  readonly classSubjectDay: boolean;
  readonly classSubjectDayLimit: number;
}

export interface CandidatePreference {
  readonly consider: CandidateConsider;
  readonly exclude: CandidateExclude;
  readonly hint: CandidateHint;
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
  /** 当日有课的节次列表（不含已停课）；用于连堂与密度 */
  readonly dayPeriodsByTeacher: Readonly<Record<string, readonly number[]>>;
  /** 该节次已有课的教师（按目标时段统计） */
  readonly busyAtSlot: readonly string[];
  /** 方案的目标节次；不填则按原节次（改派场景） */
  readonly targetPeriod?: number;
  /** 目标日期当天，该班该科目已有节数（含本课次）；用于"一天两节同科"提示 */
  readonly classSubjectDayCount?: number;
  readonly preference: CandidatePreference;
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
  /** 接手后的当天课数（原课数 + 1） */
  readonly dayCountAfter: number;
  /** 接手后的最长连续上课节数 */
  readonly longestRunAfter: number;
  /** 人可读的推荐理由；没有一条命中时也如实说明 */
  readonly reasons: readonly string[];
  /** 中性提示：不改变排序，也不排除，只把事实摆出来 */
  readonly hints: readonly string[];
}

export interface ExcludedCandidate {
  readonly teacherId: string;
  /** 被排除的原因（可能多条） */
  readonly reasons: readonly string[];
}

export interface CandidateRanking {
  readonly candidates: readonly Candidate[];
  /** 被偏好排除的教师，连同原因一并返回：不允许候选人悄悄消失 */
  readonly excluded: readonly ExcludedCandidate[];
}

/**
 * 档位基础分。相邻档位相差 30，必须大于档位内加分上限（W_SUBJECT + W_LOAD_MAX = 18），
 * 否则"跨年级但科目对口、当天很空"会翻到"同年级不同科"前面，档位就名存实亡。
 */
const W_SAME_CLASS = 60;
const W_SAME_GRADE = 30;
/** 档位内加分·学科对口：调课不是代课，跨学科不应被重罚，因此只给低固定值 */
const W_SUBJECT = 10;
/** 档位内加分·当天课程密度：0 节给满 +8，8 节及以上为 0 */
const W_LOAD_MAX = 8;

/** 档位顺序：tier 是主排序键，不参与"谁分高谁在前"的比较 */
const TIER_ORDER: Readonly<Record<CandidateTier, number>> = {
  SAME_CLASS: 0,
  SAME_GRADE: 1,
  CROSS_GRADE: 2,
};

/** 接手该节后的最长连续节数。只看教师本人连堂，班级连堂不在判定范围。 */
function longestRun(periods: readonly number[], target: number): number {
  const set = new Set<number>(periods);
  set.add(target);
  let best = 0;
  let current = 0;
  // 节次从 1 起，上限取当天最大节次与 20 的较大值，避免漏判
  const max = Math.max(20, ...set);
  for (let p = 1; p <= max; p += 1) {
    if (set.has(p)) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

export function rankCandidates(input: CandidateInput): CandidateRanking {
  const { occurrence, preference } = input;
  const grade = input.gradeByClass[occurrence.classId] ?? null;
  const busy = new Set(input.busyAtSlot);
  const targetPeriod = input.targetPeriod ?? occurrence.period;
  const classSubjectDayCount = input.classSubjectDayCount ?? 0;

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

  const kept: Candidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const teacher of input.teachers) {
    if (teacher.id === occurrence.teacherId) continue;

    const teachesSubject = subjectByTeacher.has(teacher.id);
    const teachesClass = classByTeacher.has(teacher.id);
    const inSameGrade = gradeByTeacher.has(teacher.id);
    const tier: CandidateTier = teachesClass
      ? 'SAME_CLASS'
      : inSameGrade
        ? 'SAME_GRADE'
        : 'CROSS_GRADE';
    const freeAtSlot = !busy.has(teacher.id);
    const dayPeriods = input.dayPeriodsByTeacher[teacher.id] ?? [];
    const dayCount = dayPeriods.length;
    const dayCountAfter = dayCount + 1;
    const runAfter = longestRun(dayPeriods, targetPeriod);

    // 硬排除：按偏好执行，逐条记录原因
    const excludeReasons: string[] = [];
    if (preference.exclude.busyAtSlot && !freeAtSlot) {
      excludeReasons.push(`该节次本人有课（第${targetPeriod}节）`);
    }
    if (preference.exclude.consecutive && runAfter >= preference.exclude.consecutiveLimit) {
      excludeReasons.push(`接手后将连续上 ${runAfter} 节课（上限 ${preference.exclude.consecutiveLimit}）`);
    }
    if (preference.exclude.dayTotal && dayCountAfter > preference.exclude.dayTotalLimit) {
      excludeReasons.push(`接手后当天共 ${dayCountAfter} 节（上限 ${preference.exclude.dayTotalLimit}）`);
    }
    if (excludeReasons.length > 0) {
      excluded.push({ teacherId: teacher.id, reasons: excludeReasons });
      continue;
    }

    const score =
      (preference.consider.sameClass && teachesClass ? W_SAME_CLASS : 0) +
      (preference.consider.sameGrade && !teachesClass && inSameGrade ? W_SAME_GRADE : 0) +
      (preference.consider.sameSubject && teachesSubject ? W_SUBJECT : 0) +
      (preference.consider.lightLoad ? Math.max(0, W_LOAD_MAX - dayCountAfter) : 0);

    const reasons: string[] = [];
    if (teachesClass) reasons.push('本学期任教这个班');
    else if (inSameGrade) reasons.push(`本学期任教同年级（${grade ?? '未知年级'}）其他班`);
    if (teachesSubject) reasons.push('本学期任教同一科目');
    if (freeAtSlot) reasons.push('该节次本人无课');
    else reasons.push('该节次本人有课，需先与对方对调');
    reasons.push(dayCount === 0 ? '当天没有排课' : `当天已排 ${dayCount} 节`);
    if (runAfter >= 3) reasons.push(`接手后将连续上 ${runAfter} 节`);

    const hints: string[] = [];
    if (
      preference.hint.classSubjectDay &&
      classSubjectDayCount >= preference.hint.classSubjectDayLimit
    ) {
      hints.push(`该班当天该科目共 ${classSubjectDayCount} 节`);
    }

    kept.push({
      teacherId: teacher.id,
      tier,
      score,
      teachesSubject,
      freeAtSlot,
      dayCount,
      dayCountAfter,
      longestRunAfter: runAfter,
      reasons,
      hints,
    });
  }

  kept.sort((a, b) => {
    // 可行性先于一切：能直接接下的排在"需要先对调"的前面
    if (a.freeAtSlot !== b.freeAtSlot) return a.freeAtSlot ? -1 : 1;
    // 档位是主排序键：同班 > 同年级 > 跨年级，学科与课密度只在档位内部起作用
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) {
      return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    }
    if (a.score !== b.score) return b.score - a.score;
    return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
  });

  return { candidates: kept, excluded };
}

/** 中性默认：全部维度参与排序，但不隐藏任何教师。系统不替学校把口径写死。 */
export const NEUTRAL_PREFERENCE: CandidatePreference = Object.freeze({
  consider: Object.freeze({
    sameClass: true,
    sameGrade: true,
    sameSubject: true,
    lightLoad: true,
  }),
  exclude: Object.freeze({
    busyAtSlot: false,
    consecutive: false,
    consecutiveLimit: 3,
    dayTotal: false,
    dayTotalLimit: 6,
  }),
  hint: Object.freeze({
    classSubjectDay: true,
    classSubjectDayLimit: 2,
  }),
});
