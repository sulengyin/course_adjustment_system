/**
 * P2 领域模型：只描述校内课务事实，不含 HTTP / UI / 权限判定。
 * 所有字段均来自学校提供的资料或本仓库的虚构样本，不内置任何校本规则。
 */

export type DataOrigin = 'SIMULATED' | 'IMPORTED_UNVERIFIED' | 'OFFICIAL';

/**
 * 部署环境：区分"演示/联调库"与"正式业务库"。
 *
 * 这个区分不做成开关，而是库一旦建立就固定的属性：
 *  - DEMO 库只装虚构数据（SIMULATED），不得导入真实名单、真实课表；
 *  - PRODUCTION 库只装真实业务数据，不得载入虚构种子数据。
 *
 * 混装的代价是不对称的：真实教师名单一旦进了演示库，就会被当成"可随便试的数据"，
 * 而虚构课表一旦混进正式库，会让人分不清哪条是真课表。所以宁可拒绝，不要混装。
 */
export type DeploymentMode = 'DEMO' | 'PRODUCTION';

export type Certainty = 'KNOWN' | 'UNKNOWN';

/** 单双周口径。'ALL' 表示每周都上。 */
export type TemplateParity = 'ALL' | 'ODD' | 'EVEN';
export type WeekParity = 'ODD' | 'EVEN';

/** 教学日常用的星期，1=周一 … 5=周五。周末只能通过调休进入。 */
export type Weekday = 1 | 2 | 3 | 4 | 5;

export interface Teacher {
  readonly id: string;
  readonly displayName: string;
  readonly dataOrigin: DataOrigin;
}

export interface SchoolClass {
  readonly id: string;
  readonly displayName: string;
  readonly grade: string;
  readonly dataOrigin: DataOrigin;
}

export interface Subject {
  readonly id: string;
  readonly name: string;
  readonly dataOrigin: DataOrigin;
}

export interface Term {
  readonly id: string;
  readonly label: string;
  /** 学期第一周的周一，YYYY-MM-DD */
  readonly startMonday: string;
  /** 学期最后一天（含），YYYY-MM-DD */
  readonly endDate: string;
  /**
   * 第一周是单周还是双周。
   * null = 学校未声明，单双周课程一律无法判定（不得默认按单周处理）。
   */
  readonly firstWeekParity: WeekParity | null;
  readonly dataOrigin: DataOrigin;
}

export interface BellEntry {
  readonly period: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

export interface TeachingTemplate {
  readonly id: string;
  readonly termId: string;
  readonly classId: string;
  readonly teacherId: string;
  readonly subjectId: string;
  readonly weekday: Weekday;
  readonly period: number;
  readonly parity: TemplateParity;
  /** 'CUSTOM' = 存在轮换规则，但口径未定，首版不推算 */
  readonly rotation: 'NONE' | 'CUSTOM';
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly dataOrigin: DataOrigin;
}

export type ExceptionKind = 'HOLIDAY' | 'MAKEUP_DAY' | 'SUSPENDED';

export interface CalendarException {
  readonly id: string;
  readonly termId: string;
  readonly date: string;
  readonly kind: ExceptionKind;
  /** MAKEUP_DAY 必填：按哪一天的课表上课。null = 未说明 */
  readonly followsWeekday: Weekday | null;
  /** SUSPENDED 必填：停哪些节次，'ALL' 表示整天 */
  readonly suspendedPeriods: readonly number[] | 'ALL' | null;
  readonly reason: string | null;
  readonly dataOrigin: DataOrigin;
}

/** 无法判定/无法生成的原因码。全部显式返回，不产生猜测值。 */
export type UnknownReason =
  | 'PARITY_BASE_NOT_CONFIGURED'
  | 'MAKEUP_WEEKDAY_NOT_SPECIFIED'
  | 'SUSPENSION_SCOPE_NOT_SPECIFIED'
  | 'CALENDAR_EXCEPTION_AMBIGUOUS'
  | 'BELL_NOT_CONFIGURED'
  | 'BELL_START_NOT_CONFIGURED'
  | 'BELL_END_NOT_CONFIGURED'
  | 'ROTATION_RULE_NOT_CONFIGURED';

export interface Occurrence {
  readonly id: string;
  readonly termId: string;
  readonly templateId: string;
  readonly date: string;
  readonly period: number;
  readonly classId: string;
  readonly teacherId: string;
  readonly subjectId: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly certainty: Certainty;
  readonly unknownReason: UnknownReason | null;
  readonly dataOrigin: DataOrigin;
}

export interface SchoolSnapshot {
  readonly term: Term;
  readonly teachers: readonly Teacher[];
  readonly classes: readonly SchoolClass[];
  readonly subjects: readonly Subject[];
  readonly bell: readonly BellEntry[];
  readonly exceptions: readonly CalendarException[];
  readonly templates: readonly TeachingTemplate[];
}
