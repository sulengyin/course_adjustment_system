/**
 * P7I 调课候选筛选偏好：全校由课务管理人员默认值（CHANGE_L1_CONFIG），教师可覆盖自己的。
 *
 * 边界（不开放）：
 *   - 偏好只影响"给发起人看的排序与显示"，不进入确认集合计算，也不改变冲突判定。
 *   - 硬排除只允许按事实触发（有课、连堂、当天总量），且必须带原因返回，不允许让人悄悄消失。
 *   - 偏好不是业务事实，不写审计链（审计链只承载不可否认的业务动作）。
 */

import type { CandidatePreference } from '../domain/candidate.js';
import { NEUTRAL_PREFERENCE } from '../domain/candidate.js';
import type { CourseDatabase, PreferenceRecord } from '../store/database.js';

export type PreferenceSource = 'NEUTRAL' | 'SCHOOL_DEFAULT' | 'TEACHER';

export interface EffectivePreference {
  readonly preference: CandidatePreference;
  readonly source: PreferenceSource;
  readonly school: PreferenceRecord | null;
  readonly mine: PreferenceRecord | null;
}

/** 接口层接受的偏好字段（扁平）。缺字段一律按中性默认补齐，不猜。 */
export interface PreferenceInput {
  readonly considerSameClass: boolean;
  readonly considerSameGrade: boolean;
  readonly considerSameSubject: boolean;
  readonly considerLightLoad: boolean;
  readonly excludeBusyAtSlot: boolean;
  readonly excludeConsecutive: boolean;
  readonly consecutiveLimit: number;
  readonly excludeDayTotal: boolean;
  readonly dayTotalLimit: number;
  readonly hintClassSubjectDay: boolean;
  readonly classSubjectDayLimit: number;
}

export function recordToPreference(record: PreferenceRecord): CandidatePreference {
  return {
    consider: {
      sameClass: record.considerSameClass,
      sameGrade: record.considerSameGrade,
      sameSubject: record.considerSameSubject,
      lightLoad: record.considerLightLoad,
    },
    exclude: {
      busyAtSlot: record.excludeBusyAtSlot,
      consecutive: record.excludeConsecutive,
      consecutiveLimit: record.consecutiveLimit,
      dayTotal: record.excludeDayTotal,
      dayTotalLimit: record.dayTotalLimit,
    },
    hint: {
      classSubjectDay: record.hintClassSubjectDay,
      classSubjectDayLimit: record.classSubjectDayLimit,
    },
  };
}

/** 接口的扁平入参 → 领域嵌套结构。界面实时预览与保存走同一套字段。 */
export function inputToPreference(input: PreferenceInput): CandidatePreference {
  return {
    consider: {
      sameClass: input.considerSameClass,
      sameGrade: input.considerSameGrade,
      sameSubject: input.considerSameSubject,
      lightLoad: input.considerLightLoad,
    },
    exclude: {
      busyAtSlot: input.excludeBusyAtSlot,
      consecutive: input.excludeConsecutive,
      consecutiveLimit: input.consecutiveLimit,
      dayTotal: input.excludeDayTotal,
      dayTotalLimit: input.dayTotalLimit,
    },
    hint: {
      classSubjectDay: input.hintClassSubjectDay,
      classSubjectDayLimit: input.classSubjectDayLimit,
    },
  };
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function limitIn(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > 20) return null;
  return value;
}

/** 入参校验：形状不对返回 null，由路由给 400；不做"缺字段就默认"的静默补全。 */
export function parsePreferenceInput(raw: unknown): PreferenceInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const bools = [
    'considerSameClass',
    'considerSameGrade',
    'considerSameSubject',
    'considerLightLoad',
    'excludeBusyAtSlot',
    'excludeConsecutive',
    'excludeDayTotal',
    'hintClassSubjectDay',
  ] as const;
  for (const key of bools) {
    if (!isBool(r[key])) return null;
  }
  const consecutiveLimit = limitIn(r.consecutiveLimit);
  const dayTotalLimit = limitIn(r.dayTotalLimit);
  const classSubjectDayLimit = limitIn(r.classSubjectDayLimit);
  if (consecutiveLimit === null || dayTotalLimit === null || classSubjectDayLimit === null) return null;

  return {
    considerSameClass: r.considerSameClass as boolean,
    considerSameGrade: r.considerSameGrade as boolean,
    considerSameSubject: r.considerSameSubject as boolean,
    considerLightLoad: r.considerLightLoad as boolean,
    excludeBusyAtSlot: r.excludeBusyAtSlot as boolean,
    excludeConsecutive: r.excludeConsecutive as boolean,
    consecutiveLimit,
    excludeDayTotal: r.excludeDayTotal as boolean,
    dayTotalLimit,
    hintClassSubjectDay: r.hintClassSubjectDay as boolean,
    classSubjectDayLimit,
  };
}

/** 嵌套结构 → 接口扁平字段。用于"不传就用生效的那套"时回填给界面。 */
export function preferenceToInput(pref: CandidatePreference): PreferenceInput {
  return {
    considerSameClass: pref.consider.sameClass,
    considerSameGrade: pref.consider.sameGrade,
    considerSameSubject: pref.consider.sameSubject,
    considerLightLoad: pref.consider.lightLoad,
    excludeBusyAtSlot: pref.exclude.busyAtSlot,
    excludeConsecutive: pref.exclude.consecutive,
    consecutiveLimit: pref.exclude.consecutiveLimit,
    excludeDayTotal: pref.exclude.dayTotal,
    dayTotalLimit: pref.exclude.dayTotalLimit,
    hintClassSubjectDay: pref.hint.classSubjectDay,
    classSubjectDayLimit: pref.hint.classSubjectDayLimit,
  };
}

export class ChangePreferenceService {
  private readonly now: () => string;

  constructor(
    private readonly db: CourseDatabase,
    options: { readonly now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 生效偏好：教师个人覆盖 > 全校默认 > 中性默认。 */
  effective(teacherId: string | null): EffectivePreference {
    const school = this.db.getPreference('SCHOOL', '');
    const mine = teacherId === null ? null : this.db.getPreference('TEACHER', teacherId);
    if (mine) return { preference: recordToPreference(mine), source: 'TEACHER', school, mine };
    if (school) return { preference: recordToPreference(school), source: 'SCHOOL_DEFAULT', school, mine: null };
    return { preference: NEUTRAL_PREFERENCE, source: 'NEUTRAL', school: null, mine: null };
  }

  /** 生效偏好的扁平形式：发起调课时界面不带筛选条件，就用这一套。 */
  effectiveInput(teacherId: string | null): PreferenceInput {
    return preferenceToInput(this.effective(teacherId).preference);
  }

  saveTeacher(teacherId: string, input: PreferenceInput): PreferenceRecord {
    const record: PreferenceRecord = {
      scope: 'TEACHER',
      teacherId,
      considerSameClass: input.considerSameClass,
      considerSameGrade: input.considerSameGrade,
      considerSameSubject: input.considerSameSubject,
      considerLightLoad: input.considerLightLoad,
      excludeBusyAtSlot: input.excludeBusyAtSlot,
      excludeConsecutive: input.excludeConsecutive,
      consecutiveLimit: input.consecutiveLimit,
      excludeDayTotal: input.excludeDayTotal,
      dayTotalLimit: input.dayTotalLimit,
      hintClassSubjectDay: input.hintClassSubjectDay,
      classSubjectDayLimit: input.classSubjectDayLimit,
      updatedAt: this.now(),
      updatedBy: teacherId,
    };
    this.db.upsertPreference(record);
    return record;
  }

  saveSchool(input: PreferenceInput, updatedBy: string): PreferenceRecord {
    const record: PreferenceRecord = {
      scope: 'SCHOOL',
      teacherId: '',
      considerSameClass: input.considerSameClass,
      considerSameGrade: input.considerSameGrade,
      considerSameSubject: input.considerSameSubject,
      considerLightLoad: input.considerLightLoad,
      excludeBusyAtSlot: input.excludeBusyAtSlot,
      excludeConsecutive: input.excludeConsecutive,
      consecutiveLimit: input.consecutiveLimit,
      excludeDayTotal: input.excludeDayTotal,
      dayTotalLimit: input.dayTotalLimit,
      hintClassSubjectDay: input.hintClassSubjectDay,
      classSubjectDayLimit: input.classSubjectDayLimit,
      updatedAt: this.now(),
      updatedBy,
    };
    this.db.upsertPreference(record);
    return record;
  }
}
