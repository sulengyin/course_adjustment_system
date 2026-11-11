/**
 * P7H/P7I 代课对象候选推荐的服务层：只做"取事实 → 交给领域函数打分"。
 *
 * 边界：
 *   - 只有该课次的现任授课教师能拉候选（准备发起代课的人），其他人拿不到这份名单。
 *   - 推荐不写库、不产生方案、不代替任何人的确认；它只是给发起人的排序建议。
 *   - 一切都按**方案的目标时段**计算（换时间时按目标日期/节次），否则推荐的是错的时段。
 */

import type { Principal } from '../auth/principal.js';
import { can } from '../auth/policy.js';
import {
  type Candidate,
  type CandidatePreference,
  type CandidateTier,
  evaluateSwapOption,
  lessonMinutes,
  rankCandidates,
  swapHints,
} from '../domain/candidate.js';
import type { CourseDatabase } from '../store/database.js';
import { ChangeStore } from '../store/change-store.js';
import { ChangePreferenceService } from './change-preference-service.js';

/** 服务内部用到的课次行：只取对调判断需要的字段，便于测试替身。 */
interface SwapRow {
  readonly occurrenceId: string;
  readonly date: string;
  readonly period: number;
  /** 起止时间：对调要求双方单节时长相等，第 4 节只有 20 分钟 */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly classId: string;
  readonly className: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly teacherId: string;
  readonly cancelled: boolean;
}

export interface CandidateView extends Candidate {
  readonly teacherName: string | null;
}

export interface ExcludedView {
  readonly teacherId: string;
  readonly teacherName: string | null;
  readonly reasons: readonly string[];
}

export interface SuggestOptions {
  /** 方案的目标日期（换时间时提供）；不填按原日期 */
  readonly toDate?: string | null;
  /** 方案的目标节次（换时间时提供）；不填按原节次 */
  readonly toPeriod?: number | null;
  /** 界面实时预览用的偏好；不填用"教师个人 > 全校默认 > 中性默认" */
  readonly preference?: CandidatePreference;
}

export interface CandidateSuggestion {
  readonly ok: boolean;
  readonly code:
    | 'FOUND'
    | 'NOT_A_TEACHER'
    | 'OCCURRENCE_NOT_FOUND'
    | 'NOT_OWNER'
    | 'OCCURRENCE_CANCELLED';
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly classId: string;
    readonly className: string;
    readonly subjectId: string;
    readonly subjectName: string;
    readonly date: string;
    readonly period: number;
  } | null;
  /** 评估所依据的时段（原时段或方案目标时段） */
  readonly evaluatedAt: { readonly date: string; readonly period: number } | null;
  readonly candidates: readonly CandidateView[];
  /** 被偏好排除的教师及原因：不允许候选人悄悄消失 */
  readonly excluded: readonly ExcludedView[];
  readonly preferenceSource: 'NEUTRAL' | 'SCHOOL_DEFAULT' | 'TEACHER' | 'PREVIEW';
}

/** 对调方案：对方可让出的课次。选人之后选课，一节对一节。 */
export interface SwapOptionView {
  readonly occurrenceId: string;
  readonly date: string;
  readonly period: number;
  readonly classId: string;
  readonly className: string;
  readonly subjectId: string;
  readonly subjectName: string;
  /** 对方让出这一节后，当天还剩几节 */
  readonly remainingCount: number;
  /** 只提示、不排除：可能被拒的原因 */
  readonly hints: readonly string[];
  /** 不推荐但仍可选：例如对调后发起人会连堂，事实摆出来，由他自己决定 */
  readonly warnings: readonly string[];
  /** 非空表示这次对调会撞课或违反偏好口径，不可选；原因照实给出，不静默丢弃 */
  readonly blockedReasons: readonly string[];
  /** 对调后发起人当天共几节，以及最长连着上几节 */
  readonly myDayCountAfter: number;
  readonly myLongestRunAfter: number;
  /** 推荐理由（仅展示，不参与冲突判定） */
  readonly reasons: readonly string[];
  /** 仅用于同一组内排序 */
  readonly score: number;
}

/**
 * 对调对象：推荐同班教师，具体到"这位教师的哪几节课可以换"。
 * 不推荐的教师同样列出并给理由——名单不允许有人悄悄消失。
 */
export interface SwapCandidateView {
  readonly teacherId: string;
  readonly teacherName: string | null;
  readonly tier: CandidateTier;
  /** 可让出的课次数（无冲突、未违反偏好口径） */
  readonly viableCount: number;
  /** 具体到日期 + 节次的前几节；不推荐者可能为空 */
  readonly sampleOptions: readonly SwapOptionView[];
  readonly reasons: readonly string[];
  readonly hints: readonly string[];
}

export interface SwapOptionsResult {
  readonly ok: boolean;
  readonly code:
    | 'FOUND'
    | 'NOT_A_TEACHER'
    | 'OCCURRENCE_NOT_FOUND'
    | 'NOT_OWNER'
    | 'OCCURRENCE_CANCELLED'
    | 'TERM_NOT_FOUND'
    | 'COUNTERPART_NOT_FOUND';
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly classId: string;
    readonly className: string;
    readonly subjectId: string;
    readonly subjectName: string;
    readonly date: string;
    readonly period: number;
  } | null;
  readonly counterpart: { readonly teacherId: string; readonly teacherName: string } | null;
  readonly options: readonly SwapOptionView[];
}

export interface SwapCandidatesResult {
  readonly ok: boolean;
  readonly code:
    | 'FOUND'
    | 'NOT_A_TEACHER'
    | 'OCCURRENCE_NOT_FOUND'
    | 'NOT_OWNER'
    | 'OCCURRENCE_CANCELLED'
    | 'TERM_NOT_FOUND';
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly classId: string;
    readonly className: string;
    readonly subjectId: string;
    readonly subjectName: string;
    readonly date: string;
    readonly period: number;
  } | null;
  /** 推荐：本学期任教该班，且至少有一节可换的课 */
  readonly recommended: readonly SwapCandidateView[];
  /** 不推荐：不同班，或同班但没有可换的课；逐人给理由，仍可选 */
  readonly notRecommended: readonly SwapCandidateView[];
  readonly preferenceSource: 'NEUTRAL' | 'SCHOOL_DEFAULT' | 'TEACHER';
}

function empty(code: CandidateSuggestion['code']): CandidateSuggestion {  return {
    ok: false,
    code,
    occurrence: null,
    evaluatedAt: null,
    candidates: [],
    excluded: [],
    preferenceSource: 'NEUTRAL',
  };
}

export class CandidateService {
  private readonly store: ChangeStore;
  private readonly preferences: ChangePreferenceService;
  private readonly now: () => string;

  constructor(
    private readonly db: CourseDatabase,
    options: { readonly now?: () => string } = {},
  ) {
    this.store = new ChangeStore(db.handle);
    this.preferences = new ChangePreferenceService(db, options);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 服务器本地日期（YYYY-MM-DD）。
   *
   * 不能直接用 `toISOString().slice(0,10)`：那是 UTC 日期，东八区每天 00:00–08:00
   * 会算成前一天，"今天"就错了，过去/未来的判定跟着一起错。
   */
  private today(): string {
    const raw = this.now();
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  }

  suggest(
    termId: string,
    occurrenceId: string,
    principal: Principal,
    options: SuggestOptions = {},
  ): CandidateSuggestion {
    if (!principal.teacherId || principal.mustChangePassword) return empty('NOT_A_TEACHER');

    const described = this.store.describeOccurrences([occurrenceId])[0];
    if (!described) return empty('OCCURRENCE_NOT_FOUND');
    if (described.teacherId !== principal.teacherId && !this.mayPlanFor(principal, described.teacherId)) {
      return empty('NOT_OWNER');
    }
    if (described.cancelled) return empty('OCCURRENCE_CANCELLED');

    const targetDate = options.toDate ?? described.date;
    const targetPeriod = options.toPeriod ?? described.period;

    // 目标日当天的课表：既是"该节次谁有课"的事实，也是连堂、当天总量、班级科目的事实
    const dayRows = this.db.queryAll(termId, targetDate, targetDate);
    const dayPeriodsByTeacher: Record<string, number[]> = {};
    const busyAtSlot = new Set<string>();
    let classSubjectDayCount = 0;
    for (const row of dayRows) {
      if (row.cancelled) continue;
      const list = dayPeriodsByTeacher[row.teacherId] ?? [];
      list.push(row.period);
      dayPeriodsByTeacher[row.teacherId] = list;
      if (row.period === targetPeriod) busyAtSlot.add(row.teacherId);
      if (row.classId === described.classId && row.subjectId === described.subjectId) {
        classSubjectDayCount += 1;
      }
    }

    const teaching = this.db.activeTemplates(termId).map((t) => ({
      teacherId: t.teacherId,
      classId: t.classId,
      subjectId: t.subjectId,
    }));
    const refs = this.db.refs();
    // 哪两科算"语文/数学"由科目名决定，不按 ID 写死：换一套科目编码时不用改代码。
    const languageMathTeacherIds = [...this.languageMathTeachers(teaching)];

    const effective = this.preferences.effective(described.teacherId);
    const preference = options.preference ?? effective.preference;

    const ranked = rankCandidates({
      occurrence: {
        classId: described.classId,
        subjectId: described.subjectId,
        teacherId: described.teacherId,
        date: described.date,
        period: described.period,
      },
      teaching,
      teachers: refs.teachers,
      gradeByClass: this.db.classGrades(),
      dayPeriodsByTeacher,
      busyAtSlot: [...busyAtSlot],
      targetPeriod,
      classSubjectDayCount,
      languageMathTeacherIds,
      preference,
    });

    const names = new Map(refs.teachers.map((t) => [t.id, t.name]));
    return {
      ok: true,
      code: 'FOUND',
      occurrence: {
        occurrenceId: described.occurrenceId,
        classId: described.classId,
        className: described.className,
        subjectId: described.subjectId,
        subjectName: described.subjectName,
        date: described.date,
        period: described.period,
      },
      evaluatedAt: { date: targetDate, period: targetPeriod },
      candidates: ranked.candidates.map((c) => ({
        ...c,
        teacherName: names.get(c.teacherId) ?? null,
      })),
      excluded: ranked.excluded.map((e) => ({
        teacherId: e.teacherId,
        teacherName: names.get(e.teacherId) ?? null,
        reasons: e.reasons,
      })),
      preferenceSource: options.preference ? 'PREVIEW' : effective.source,
    };
  }

  /**
   * 跨天对调：先选人，再选对方可让出的那一节课。
   *
   * 这一版只负责"把对方的课次列出来，并算清楚对调后对方当天还剩几节"；
   * 建方案仍是普通的两条 REASSIGN（我给对方、对方给我），由现成的确认与冲突逻辑处理。
   */
  swapOptions(
    termId: string,
    occurrenceId: string,
    counterpartTeacherId: string,
    principal: Principal,
  ): SwapOptionsResult {
    const none = (code: SwapOptionsResult['code']): SwapOptionsResult => ({
      ok: false,
      code,
      occurrence: null,
      counterpart: null,
      options: [],
    });

    if (!principal.teacherId || principal.mustChangePassword) return none('NOT_A_TEACHER');

    const described = this.store.describeOccurrences([occurrenceId])[0];
    if (!described) return none('OCCURRENCE_NOT_FOUND');
    if (described.teacherId !== principal.teacherId && !this.mayPlanFor(principal, described.teacherId)) {
      return none('NOT_OWNER');
    }
    if (described.cancelled) return none('OCCURRENCE_CANCELLED');

    const term = this.db.getTerm(termId);
    if (!term) return none('TERM_NOT_FOUND');

    const refs = this.db.refs();
    const counterpart = refs.teachers.find((t) => t.id === counterpartTeacherId);
    if (!counterpart || counterpartTeacherId === described.teacherId) {
      return none('COUNTERPART_NOT_FOUND');
    }

    const teaching = this.teachingFacts(termId);
    const isLanguageMath = this.languageMathTeachers(teaching).has(counterpartTeacherId);

    const { startMonday: from, endDate: to } = term.term;
    const today = this.today();
    // 一次取"我 + 对方"，命中 idx_occ_teacher；分开查会变成两次索引扫描
    const both = this.db
      .queryByTeachers(termId, [described.teacherId, counterpartTeacherId], from, to)
      .filter((r) => !r.cancelled && r.occurrenceId !== occurrenceId);
    const mine = both.filter((r) => r.teacherId === described.teacherId);
    // 已经过去的课次不再列出：那是既成事实，调不了，列出来只会让人白点一次
    const theirs = both.filter(
      (r) => r.teacherId === counterpartTeacherId && r.date >= today,
    );

    const preference = this.preferences.effective(described.teacherId).preference;
    const options = this.buildSwapOptions({
      described,
      mine,
      theirs,
      myIsPast: described.date < today,
      myMinutes: lessonMinutes(described.startsAt, described.endsAt),
      isSameClass: teaching.some(
        (t) => t.teacherId === counterpartTeacherId && t.classId === described.classId,
      ),
      teachesSubject: teaching.some(
        (t) => t.teacherId === counterpartTeacherId && t.subjectId === described.subjectId,
      ),
      isLanguageMath,
      preference,
    });

    return {
      ok: true,
      code: 'FOUND',
      occurrence: {
        occurrenceId: described.occurrenceId,
        classId: described.classId,
        className: described.className,
        subjectId: described.subjectId,
        subjectName: described.subjectName,
        date: described.date,
        period: described.period,
      },
      counterpart: { teacherId: counterpart.id, teacherName: counterpart.name },
      options,
    };
  }

  /**
   * 对调对象推荐：只推荐**本学期任教该班**的教师，并具体到"哪几节课可以换"。
   *
   * 与代课推荐的差别：
   *   - 推荐范围按班级收窄，同年级、跨年级一律进"不推荐"并写明理由；
   *   - 每一行必须落到具体课次（日期 + 节次），否则"和谁换"仍然是一句空话；
   *   - 不推荐的教师仍可选（推荐不强制），所以名单只分组、不隐藏。
   */
  swapCandidates(
    termId: string,
    occurrenceId: string,
    principal: Principal,
  ): SwapCandidatesResult {
    const none = (code: SwapCandidatesResult['code']): SwapCandidatesResult => ({
      ok: false,
      code,
      occurrence: null,
      recommended: [],
      notRecommended: [],
      preferenceSource: 'NEUTRAL',
    });

    if (!principal.teacherId || principal.mustChangePassword) return none('NOT_A_TEACHER');

    const described = this.store.describeOccurrences([occurrenceId])[0];
    if (!described) return none('OCCURRENCE_NOT_FOUND');
    if (described.teacherId !== principal.teacherId && !this.mayPlanFor(principal, described.teacherId)) {
      return none('NOT_OWNER');
    }
    if (described.cancelled) return none('OCCURRENCE_CANCELLED');

    const term = this.db.getTerm(termId);
    if (!term) return none('TERM_NOT_FOUND');

    const teaching = this.teachingFacts(termId);
    const languageMath = this.languageMathTeachers(teaching);
    // 143 位教师 × 近 2000 条模板，逐个 some() 会白扫十几万次；先摊平成集合
    const teachesByTeacher = new Set(teaching.map((t) => `${t.teacherId}|${t.subjectId}`));
    const gradeByClass = this.db.classGrades();
    const myGrade = gradeByClass[described.classId];
    const sameClass = new Set(
      teaching.filter((t) => t.classId === described.classId).map((t) => t.teacherId),
    );
    const sameGrade = new Set(
      myGrade === undefined
        ? []
        : teaching
            .filter((t) => t.classId !== described.classId && gradeByClass[t.classId] === myGrade)
            .map((t) => t.teacherId),
    );

    const { startMonday: from, endDate: to } = term.term;
    // 只有同班教师会被逐节评估，其余人的理由只有一句"不任教该班"；
    // 所以只需取"同班 + 我"的课次，不必把整学期四万行全搬进内存（那是百毫秒级开销，200 并发会排队）。
    const rows: readonly SwapRow[] = this.db
      .queryByTeachers(termId, [...sameClass, described.teacherId], from, to)
      .filter((r) => !r.cancelled && r.occurrenceId !== occurrenceId);
    const byTeacher = new Map<string, SwapRow[]>();
    for (const row of rows) {
      const list = byTeacher.get(row.teacherId) ?? [];
      list.push(row);
      byTeacher.set(row.teacherId, list);
    }
    const mine = byTeacher.get(described.teacherId) ?? [];

    const today = this.today();
    const myIsPast = described.date < today;
    const myMinutes = lessonMinutes(described.startsAt, described.endsAt);

    const effective = this.preferences.effective(described.teacherId);
    const preference = effective.preference;
    const refs = this.db.refs();
    const names = new Map(refs.teachers.map((t) => [t.id, t.name]));

    const recommended: SwapCandidateView[] = [];
    const notRecommended: SwapCandidateView[] = [];
    const bestScore = new Map<string, number>();

    for (const teacher of refs.teachers) {
      if (teacher.id === described.teacherId) continue;
      const tier: CandidateTier = sameClass.has(teacher.id)
        ? 'SAME_CLASS'
        : sameGrade.has(teacher.id)
          ? 'SAME_GRADE'
          : 'CROSS_GRADE';
      const theirRows = byTeacher.get(teacher.id) ?? [];
      // 已经过去的课次不参与推荐：列出来只会让人白点一次，还会把 viableCount 撑大
      const theirFuture = theirRows.filter((r) => r.date >= today);
      // 只有同班教师才可能被推荐，也只有他们需要逐节评估；
      // 其余人的理由只有"不任教该班"一条，不必为此把整学期课次都算一遍。
      const options =
        tier === 'SAME_CLASS'
          ? this.buildSwapOptions({
              described,
              mine,
              theirs: theirFuture,
              myIsPast,
              myMinutes,
              isSameClass: true,
              teachesSubject: teachesByTeacher.has(`${teacher.id}|${described.subjectId}`),
              isLanguageMath: languageMath.has(teacher.id),
              preference,
            })
          : [];
      const viable = options.filter((o) => o.blockedReasons.length === 0);
      // 摘要优先给不带连堂警告的课次；全都带警告时照实给，不假装没有问题
      const clean = viable.filter((o) => o.warnings.length === 0);
      const base = {
        teacherId: teacher.id,
        teacherName: names.get(teacher.id) ?? null,
        tier,
        viableCount: viable.length,
        sampleOptions: (clean.length > 0 ? clean : viable).slice(0, 3),
        hints: viable[0]?.hints ?? [],
      };

      if (tier !== 'SAME_CLASS') {
        notRecommended.push({
          ...base,
          reasons: [`本学期不任教该班（${tier === 'SAME_GRADE' ? '同年级' : '跨年级'}）`],
        });
        continue;
      }
      if (options.length === 0) {
        notRecommended.push({
          ...base,
          reasons: [
            theirRows.length === 0
              ? '本学期没有可让出的课次'
              : '该教师剩余的课次都已过去，无法对调',
          ],
        });
        continue;
      }
      if (viable.length === 0) {
        const why = [...new Set(options.flatMap((o) => o.blockedReasons))].slice(0, 3);
        notRecommended.push({ ...base, reasons: ['可让出的课次都不可行', ...why] });
        continue;
      }

      recommended.push({ ...base, reasons: viable[0]?.reasons ?? [] });
      bestScore.set(teacher.id, Math.max(...viable.map((o) => o.score)));
    }

    recommended.sort((a, b) => {
      const sa = bestScore.get(a.teacherId) ?? 0;
      const sb = bestScore.get(b.teacherId) ?? 0;
      if (sa !== sb) return sb - sa;
      if (a.viableCount !== b.viableCount) return b.viableCount - a.viableCount;
      return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
    });
    notRecommended.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'SAME_GRADE' ? -1 : 1;
      return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
    });

    return {
      ok: true,
      code: 'FOUND',
      occurrence: {
        occurrenceId: described.occurrenceId,
        classId: described.classId,
        className: described.className,
        subjectId: described.subjectId,
        subjectName: described.subjectName,
        date: described.date,
        period: described.period,
      },
      recommended,
      notRecommended,
      preferenceSource: effective.source,
    };
  }

  /** 一门课次（或一节目标时段）下，某个教师可让出的全部课次及其可行性。 */
  /**
   * 谁能为这个课次算候选：现任教师本人，或持有 CREATE_CHANGE_ON_BEHALF 的代办人。
   *
   * 代办人算的是**被代教师**的偏好与课表，因为方案记在被代教师名下；
   * 用代办人自己的偏好去排他的候选，会给出他不认可的排序。
   */
  private mayPlanFor(principal: Principal, occurrenceTeacherId: string): boolean {
    if (principal.teacherId === occurrenceTeacherId) return true;
    return can(principal, 'CREATE_CHANGE_ON_BEHALF').allowed;
  }

  private buildSwapOptions(input: {
    readonly described: { readonly date: string; readonly period: number };
    readonly mine: readonly SwapRow[];
    readonly theirs: readonly SwapRow[];
    /** 我要调出的那节课是否已经过去：已发生的课不能再调 */
    readonly myIsPast: boolean;
    /** 我要调出的那节课时长（分钟）；null 表示缺起止时间、无法判定 */
    readonly myMinutes: number | null;
    readonly isSameClass: boolean;
    readonly teachesSubject: boolean;
    readonly isLanguageMath: boolean;
    readonly preference: CandidatePreference;
  }): SwapOptionView[] {
    const { described, mine, theirs } = input;

    const myPeriodsByDate = new Map<string, Set<number>>();
    for (const row of mine) {
      const set = myPeriodsByDate.get(row.date) ?? new Set<number>();
      set.add(row.period);
      myPeriodsByDate.set(row.date, set);
    }
    // 对方在我这一节的时间是否还有别的课：若这一节正是被选中的对调课次，它自己不算冲突
    const theirOccurrencesAtMySlot = new Set(
      theirs
        .filter((r) => r.date === described.date && r.period === described.period)
        .map((r) => r.occurrenceId),
    );
    // 按日期分桶：逐条算"当天还剩几节"时只看本日那几节，避免对整学期课次反复全量过滤（O(n²)）
    const theirByDate = new Map<string, SwapRow[]>();
    for (const row of theirs) {
      const list = theirByDate.get(row.date) ?? [];
      list.push(row);
      theirByDate.set(row.date, list);
    }
    const theirPeriodsOnMyDate = (theirByDate.get(described.date) ?? []).map((r) => r.period);

    const options: SwapOptionView[] = theirs.map((row) => {
      const remaining = (theirByDate.get(row.date) ?? [])
        .filter((r) => r.occurrenceId !== row.occurrenceId)
        .map((r) => r.period);

      const blockedReasons: string[] = [];
      if (input.myIsPast) {
        blockedReasons.push(`你要调出的这节课已经过去（${described.date}），不能再调`);
      }
      // 对调是两节整段互换：时长不等就等于凭空增减一方课时（第 4 节 20 分钟，其余 40 分钟）
      const theirMinutes = lessonMinutes(row.startsAt, row.endsAt);
      if (input.myMinutes === null) {
        blockedReasons.push('你这节课缺少起止时间，无法确认时长是否相等');
      } else if (theirMinutes === null) {
        blockedReasons.push('该课次缺少起止时间，无法确认时长是否相等');
      } else if (input.myMinutes !== theirMinutes) {
        blockedReasons.push(
          `对调双方时长不等（你这节 ${input.myMinutes} 分钟 / 对方那节 ${theirMinutes} 分钟），只能同时长的课互换`,
        );
      }
      if (myPeriodsByDate.get(row.date)?.has(row.period)) {
        blockedReasons.push(`你在该时段已有课（第${row.period}节）`);
      }
      const sameSlot = row.date === described.date && row.period === described.period;
      const otherAtMySlot = theirOccurrencesAtMySlot.size - (sameSlot ? 1 : 0);
      if (otherAtMySlot > 0) {
        blockedReasons.push('该教师在你这一节的时间还有别的课');
      }

      const evaluation = evaluateSwapOption({
        isSameClass: input.isSameClass,
        teachesSubject: input.teachesSubject,
        myDate: described.date,
        myPeriod: described.period,
        lessonDate: row.date,
        lessonPeriod: row.period,
        theirPeriodsOnMyDate,
        // 我在对方那一天原本的课：用来算"接手他这一节之后，我会不会连着上"
        myPeriodsOnLessonDate: [...(myPeriodsByDate.get(row.date) ?? [])],
        preference: input.preference,
      });
      blockedReasons.push(...evaluation.excludedBy);

      return {
        occurrenceId: row.occurrenceId,
        date: row.date,
        period: row.period,
        classId: row.classId,
        className: row.className,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        remainingCount: remaining.length,
        hints: swapHints({ isLanguageMath: input.isLanguageMath, remainingPeriods: remaining }),
        warnings: evaluation.warnings,
        blockedReasons,
        myDayCountAfter: evaluation.myDayCountAfter,
        myLongestRunAfter: evaluation.myLongestRunAfter,
        reasons: evaluation.reasons,
        score: evaluation.score,
      };
    });

    options.sort((a, b) => {
      if ((a.blockedReasons.length === 0) !== (b.blockedReasons.length === 0)) {
        return a.blockedReasons.length === 0 ? -1 : 1;
      }
      // 连堂这类"不推荐但可选"的排在干净选项之后：不藏起来，也不占前排
      if ((a.warnings.length === 0) !== (b.warnings.length === 0)) {
        return a.warnings.length === 0 ? -1 : 1;
      }
      if ((a.hints.length === 0) !== (b.hints.length === 0)) {
        return a.hints.length === 0 ? -1 : 1;
      }
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.period - b.period;
    });
    return options;
  }

  /** 本学期有效模板展开成"谁教哪个班的哪门课"。 */
  private teachingFacts(termId: string): {
    teacherId: string;
    classId: string;
    subjectId: string;
  }[] {
    return this.db.activeTemplates(termId).map((t) => ({
      teacherId: t.teacherId,
      classId: t.classId,
      subjectId: t.subjectId,
    }));
  }

  /** 本学期任教语文或数学的教师。按科目名判定，不认科目 ID。 */
  private languageMathTeachers(
    teaching: readonly { readonly teacherId: string; readonly subjectId: string }[],
  ): Set<string> {
    const names = new Map(this.db.refs().subjects.map((s) => [s.id, s.name]));
    const out = new Set<string>();
    for (const fact of teaching) {
      const name = names.get(fact.subjectId);
      if (name === '语文' || name === '数学') out.add(fact.teacherId);
    }
    return out;
  }
}
