/**
 * P7H/P7I 调课对象候选推荐的服务层：只做"取事实 → 交给领域函数打分"。
 *
 * 边界：
 *   - 只有该课次的现任授课教师能拉候选（准备发起调课的人），其他人拿不到这份名单。
 *   - 推荐不写库、不产生方案、不代替任何人的确认；它只是给发起人的排序建议。
 *   - 一切都按**方案的目标时段**计算（换时间时按目标日期/节次），否则推荐的是错的时段。
 */

import type { Principal } from '../auth/principal.js';
import { type Candidate, type CandidatePreference, rankCandidates } from '../domain/candidate.js';
import type { CourseDatabase } from '../store/database.js';
import { ChangeStore } from '../store/change-store.js';
import { ChangePreferenceService } from './change-preference-service.js';

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

function empty(code: CandidateSuggestion['code']): CandidateSuggestion {
  return {
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

  constructor(
    private readonly db: CourseDatabase,
    options: { readonly now?: () => string } = {},
  ) {
    this.store = new ChangeStore(db.handle);
    this.preferences = new ChangePreferenceService(db, options);
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
    if (described.teacherId !== principal.teacherId) return empty('NOT_OWNER');
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

    const effective = this.preferences.effective(principal.teacherId);
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
}
