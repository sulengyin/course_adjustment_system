/**
 * P7H/P7I 代课对象候选推荐：纯函数，不依赖数据库、HTTP、权限。
 *
 * 定位（重要）：
 *   推荐只回答"谁更可能接得下这节课"，不回答"谁必须接"。
 *   规则全部来自可核验的事实（本学期排课安排、当天课表），不引入任何主观评价分数。
 *   最终仍然要由接手的教师本人确认；推荐不代替确认，也不限制发起人只能选推荐名单内的人。
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

/**
 * 硬排除。全部默认关闭：默认只排序、不隐藏任何人。
 *
 * 这里没有"该节次有课"：代课是请对方来上这一节，对方同时段有课就上不了，
 * 那是物理冲突而不是口径偏好，见 `rankCandidates` 里的无条件排除。
 */
export interface CandidateExclude {
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
  /** 方案的目标节次；不填则按原节次（换教师场景） */
  readonly targetPeriod?: number;
  /** 目标日期当天，该班该科目已有节数（含本课次）；用于"一天两节同科"提示 */
  readonly classSubjectDayCount?: number;
  /**
   * 本学期任教语文或数学的教师。用于"接手后当天只剩上午第4节"的提示。
   * 由服务层按科目名判定后传入：领域层不认科目 ID，也不把"哪两科"写死在这里。
   */
  readonly languageMathTeacherIds?: readonly string[];
  readonly preference: CandidatePreference;
}

export interface Candidate {
  readonly teacherId: string;
  readonly tier: CandidateTier;
  /** 综合分，仅用于排序展示，不代表"能力评价" */
  readonly score: number;
  readonly teachesSubject: boolean;
  /** 该节次本人无课：换人后不会立刻产生撞课 */
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
/** 档位内加分·学科对口：代课不要求同科，跨学科不应被重罚，因此只给低固定值 */
const W_SUBJECT = 10;
/** 档位内加分·当天课程密度：0 节给满 +8，8 节及以上为 0 */
const W_LOAD_MAX = 8;

/** 档位顺序：tier 是主排序键，不参与"谁分高谁在前"的比较 */
const TIER_ORDER: Readonly<Record<CandidateTier, number>> = {
  SAME_CLASS: 0,
  SAME_GRADE: 1,
  CROSS_GRADE: 2,
};

/**
 * 最长连续上课节数。只看教师本人连堂，班级连堂不在判定范围。
 * `target` 用于"接手某一节之后"：把该节并入课表再算；不传则按给定节次直接算。
 */
export function longestRun(periods: readonly number[], target?: number): number {
  const set = new Set<number>(periods);
  if (target !== undefined) set.add(target);
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
  const languageMath = new Set(input.languageMathTeacherIds ?? []);

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
    // 该节次已经有课 = 接不了。代课是把这一节交给对方，对方同时段自己在别的班上课，
    // 两边撞在一起，除非再连锁调一次——那已经不是"代课"能解决的事，应走对调。
    // 所以这条不随偏好开关，一律排除；原因照实返回，让人知道谁被跳过了、为什么。
    if (!freeAtSlot) {
      excluded.push({
        teacherId: teacher.id,
        reasons: [`该节次本人有课（第${targetPeriod}节），无法同时接手`],
      });
      continue;
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
    reasons.push('该节次本人无课');
    reasons.push(dayCount === 0 ? '当天没有排课' : `当天已排 ${dayCount} 节`);
    if (runAfter >= 3) reasons.push(`接手后将连续上 ${runAfter} 节`);

    const hints: string[] = [];
    if (
      preference.hint.classSubjectDay &&
      classSubjectDayCount >= preference.hint.classSubjectDayLimit
    ) {
      hints.push(`该班当天该科目共 ${classSubjectDayCount} 节`);
    }
    // 语数教师当天原本没课，接手的又正好是上午第4节：整天的课就只剩这一节，
    // 等于要为他专程跑一趟学校，被拒的可能性明显更高。只提示，不改变排序与可选性。
    if (languageMath.has(teacher.id) && dayCount === 0 && targetPeriod === 4) {
      hints.push('接手后当天只有上午第4节这一节，可能需专程到校');
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
    // 档位是主排序键：同班 > 同年级 > 跨年级，学科与课密度只在档位内部起作用
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) {
      return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    }
    if (a.score !== b.score) return b.score - a.score;
    return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
  });

  return { candidates: kept, excluded };
}

/**
 * 单节课的时长（分钟）。缺起止时间、或起止时间不合法时返回 null（无法判定）。
 *
 * 为什么对调要卡时长：对调是两节课"整段互换"，双方各让出一节、各接手一节。
 * 第 4 节只有 20 分钟（11:20–11:40），其余 40 分钟，第 7 节 35 分钟。
 * 拿 40 分钟的课去换 20 分钟的课，等于凭空从一方手里拿走 20 分钟课时，
 * 两边的课时总量都对不上，不是"换课"而是"减课"。所以时长不等一律不可对调。
 */
export function lessonMinutes(
  startsAt: string | null,
  endsAt: string | null,
): number | null {
  const from = clockMinutes(startsAt);
  const to = clockMinutes(endsAt);
  if (from === null || to === null) return null;
  const minutes = to - from;
  return minutes > 0 ? minutes : null;
}

/** 'HH:MM' → 当天第几分钟；格式不对或越界返回 null。 */
function clockMinutes(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 对调场景的提示：对方让出自己一节课之后，当天还剩几节。
 *
 * 只对语数教师生效（口径见 docs/13 §7.7）：语文、数学教师课时密集，
 * 对调后当天被削成"只剩上午第4节"或"一节不剩"时，对方要么专程跑一趟，
 * 要么整天白来，被拒的可能性明显更高。
 *
 * 只提示，不排除：这是对"对方会不会答应"的推测，不是排课事实。
 */
export function swapHints(input: {
  readonly isLanguageMath: boolean;
  readonly remainingPeriods: readonly number[];
}): readonly string[] {
  if (!input.isLanguageMath) return [];
  const remain = [...new Set(input.remainingPeriods)];
  if (remain.length === 0) return ['对调后该教师当天没有课'];
  if (remain.length === 1 && remain[0] === 4) {
    return ['对调后该教师当天只有上午第4节这一节，可能需专程到校'];
  }
  return [];
}

/**
 * 对调时，对方在**我这一天**的课表：原本的课，减去让出的那一节（若同一天），加上接手我的这一节。
 *
 * 与代课不同，对调会让对方"既多一节又少一节"，所以不能用"原课数 + 1"近似，
 * 否则同一天换课会被误判成超量或连堂。
 */
export function swapDayAfter(input: {
  readonly myDate: string;
  readonly myPeriod: number;
  readonly lessonDate: string;
  readonly lessonPeriod: number;
  readonly theirPeriodsOnMyDate: readonly number[];
}): number[] {
  const periods = new Set(input.theirPeriodsOnMyDate);
  if (input.lessonDate === input.myDate) periods.delete(input.lessonPeriod);
  periods.add(input.myPeriod);
  return [...periods].sort((a, b) => a - b);
}

export interface SwapOptionEvaluation {
  readonly dayCountAfter: number;
  readonly longestRunAfter: number;
  /** 发起人接手对方那一节之后，当天共几节 */
  readonly myDayCountAfter: number;
  /** 发起人接手后的最长连续上课节数 */
  readonly myLongestRunAfter: number;
  /** 偏好排除原因；非空表示这次对调按当前口径不该推荐 */
  readonly excludedBy: readonly string[];
  /** 不推荐但仍可选：把事实摆出来，不替发起人做决定 */
  readonly warnings: readonly string[];
  /** 仅用于同一档位内排序，不代表能力评价 */
  readonly score: number;
  readonly reasons: readonly string[];
}

/**
 * 评价"对方让出某一节课、接手我这一节课"在偏好口径下是否可行。
 *
 * 两侧都要算，不能只算对方：
 *   - 对方：让出一节、接手一节，当天课数可能不变（同一天换课）；
 *   - 发起人：同样多一节少一节，但更常见的是跨天——那一天凭空多出一节，
 *     正好卡在两节课中间时会直接变成连堂。发起人是做决定的人，这件事必须先摊在他面前。
 *
 * 与代课共用同一套维度，另外两处区别：
 *   - `busyAtSlot` 不适用：对方在我这一节有课，恰恰可能就是要换的那一节；
 *   - 当天课数与连堂按 `swapDayAfter` 实算，不按 +1 近似。
 */
export function evaluateSwapOption(input: {
  readonly isSameClass: boolean;
  readonly teachesSubject: boolean;
  readonly myDate: string;
  readonly myPeriod: number;
  readonly lessonDate: string;
  readonly lessonPeriod: number;
  /** 对方在**我这一天**原本的节次（含要换出的那一节） */
  readonly theirPeriodsOnMyDate: readonly number[];
  /** 我**在对方那一天**原本的节次（不含我要换出的那一节，因为它在另一天） */
  readonly myPeriodsOnLessonDate: readonly number[];
  readonly preference: CandidatePreference;
}): SwapOptionEvaluation {
  const after = swapDayAfter(input);
  const dayCountAfter = after.length;
  const run = longestRun(after);

  // 换到我这一天的视角：我让出一节给 B，接手 B 那一节
  const myAfter = swapDayAfter({
    myDate: input.lessonDate,
    myPeriod: input.lessonPeriod,
    lessonDate: input.myDate,
    lessonPeriod: input.myPeriod,
    theirPeriodsOnMyDate: input.myPeriodsOnLessonDate,
  });
  const myDayCountAfter = myAfter.length;
  const myRun = longestRun(myAfter);
  // 换之前我在那天已经连着上几节。只把"这次对调造成的变长"算到这次头上：
  // 学校本来就把某人排成连上四节时，再换一节不该被系统归咎于对调。
  const myRunBefore = longestRun(input.myPeriodsOnLessonDate);

  const excludedBy: string[] = [];
  const warnings: string[] = [];
  const limit = input.preference.exclude.consecutiveLimit;
  if (input.preference.exclude.consecutive && run >= limit) {
    excludedBy.push(`对方接手后连续上 ${run} 节，达到 ${limit} 节上限`);
  }
  // 发起人自己的连堂：默认只警告，不禁止——有人就是愿意连着上完早点走。
  // 判定看的是"换完之后实际连着上几节"，不是增量：原本就 4 连、换完还是 4 连，
  // 对当事人仍然是 4 节的事实，不该因为"没变长"就不提。
  // 学校在设置里勾了"接手后连上 ≥ N 节"才升级为不可选。
  if (myRun >= limit) {
    const message = `对调后你会连续上 ${myRun} 节（原本 ${myRunBefore} 节），达到 ${limit} 节上限`;
    if (input.preference.exclude.consecutive) excludedBy.push(message);
    else warnings.push(message);
  }
  if (input.preference.exclude.dayTotal && dayCountAfter > input.preference.exclude.dayTotalLimit) {
    excludedBy.push(
      `对方接手后当天 ${dayCountAfter} 节，超过 ${input.preference.exclude.dayTotalLimit} 节上限`,
    );
  }

  let score = input.isSameClass ? W_SAME_CLASS : 0;
  if (input.preference.consider.sameSubject && input.teachesSubject) score += W_SUBJECT;
  if (input.preference.consider.lightLoad) score += Math.max(0, W_LOAD_MAX - dayCountAfter);

  const reasons: string[] = [];
  if (input.isSameClass) reasons.push('本学期任教该班');
  if (input.teachesSubject) reasons.push('本学期任教同一科目');
  reasons.push(dayCountAfter === 1 ? '对调后对方当天只有 1 节' : `对调后对方当天 ${dayCountAfter} 节`);
  if (run >= 2) reasons.push(`对调后对方连续上 ${run} 节`);
  reasons.push(myDayCountAfter === 1 ? '对调后你当天只有 1 节' : `对调后你当天 ${myDayCountAfter} 节`);
  if (myRun >= 2) reasons.push(`对调后你连续上 ${myRun} 节`);

  return { dayCountAfter, longestRunAfter: run, myDayCountAfter, myLongestRunAfter: myRun, excludedBy, warnings, score, reasons };
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
