/**
 * P7H 调课对象候选推荐的服务层：只做"取事实 → 交给领域函数打分"。
 *
 * 边界：
 *   - 只有该课次的现任授课教师能拉候选（准备发起调课的人），其他人拿不到这份名单。
 *   - 推荐不写库、不产生方案、不代替任何人的确认；它只是给发起人的排序建议。
 *   - 候选池来自教师名册，推荐结果里同时给出"为什么推荐"，避免老师靠猜。
 */

import type { Principal } from '../auth/principal.js';
import { type Candidate, rankCandidates } from '../domain/candidate.js';
import type { CourseDatabase } from '../store/database.js';
import { ChangeStore } from '../store/change-store.js';

export interface CandidateView extends Candidate {
  readonly teacherName: string | null;
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
  readonly candidates: readonly CandidateView[];
}

function empty(code: CandidateSuggestion['code']): CandidateSuggestion {
  return { ok: false, code, occurrence: null, candidates: [] };
}

export class CandidateService {
  private readonly store: ChangeStore;

  constructor(private readonly db: CourseDatabase) {
    this.store = new ChangeStore(db.handle);
  }

  suggest(termId: string, occurrenceId: string, principal: Principal): CandidateSuggestion {
    if (!principal.teacherId || principal.mustChangePassword) return empty('NOT_A_TEACHER');

    const described = this.store.describeOccurrences([occurrenceId])[0];
    if (!described) return empty('OCCURRENCE_NOT_FOUND');
    if (described.teacherId !== principal.teacherId) return empty('NOT_OWNER');
    if (described.cancelled) return empty('OCCURRENCE_CANCELLED');

    // 当天的课表：既是"该节次谁有课"的事实，也是"当天课程密度"的事实
    const dayRows = this.db.queryAll(termId, described.date, described.date);
    const dayCountByTeacher: Record<string, number> = {};
    const busyAtSlot = new Set<string>();
    for (const row of dayRows) {
      if (row.cancelled) continue;
      dayCountByTeacher[row.teacherId] = (dayCountByTeacher[row.teacherId] ?? 0) + 1;
      if (row.period === described.period) busyAtSlot.add(row.teacherId);
    }

    const teaching = this.db.activeTemplates(termId).map((t) => ({
      teacherId: t.teacherId,
      classId: t.classId,
      subjectId: t.subjectId,
    }));
    const refs = this.db.refs();

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
      dayCountByTeacher,
      busyAtSlot: [...busyAtSlot],
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
      candidates: ranked.map((c) => ({
        ...c,
        teacherName: names.get(c.teacherId) ?? null,
      })),
    };
  }
}
