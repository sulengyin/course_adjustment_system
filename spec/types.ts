/**
 * P1 契约类型 —— 仅描述事实关系与判定结果，不含数据库、HTTP、UI。
 * 所有标识均为虚构；不含任何真实教师、学生信息。
 */

export type Certainty = 'KNOWN' | 'UNKNOWN';
export type Origin = 'SIMULATED' | 'IMPORTED_UNVERIFIED' | 'OFFICIAL';
export type Role = 'TEACHER' | 'SCHEDULER' | 'COORDINATOR' | 'REGISTRAR' | 'ADJUDICATOR' | 'ADMIN';

export interface Principal {
  id: string;
  roles: Role[];
  /** 一人多角色时，必须显式声明本次以哪个角色行事 */
  actingAs: Role | null;
}

/* ---------------- 导入与发布 ---------------- */

export interface ImportRow {
  teacherExternalRef: string;
  classId: string;
  date: string;
  period: number;
  subject: string;
}

export interface ImportBatch {
  id: string;
  origin: Origin;
  /** 上传 ≠ 正式发布。published 仅能由显式发布动作置为 true。 */
  published: boolean;
  rows: ImportRow[];
  /** 与已生效的临时变更重叠的课次 ID（由调用方比对得出，引擎不得自行覆盖） */
  conflictsWithEffectiveIds: string[];
}

export type ImportOutcomeCode =
  | 'ACCEPTED'
  | 'IMPORTED_NOT_PUBLISHED'
  | 'CONFLICT'
  | 'UNSUPPORTED_FORMAT';

export interface ImportOutcome {
  outcome: ImportOutcomeCode;
  official: boolean;
  overwritten: boolean;
  conflictQueue: string[];
}

/* ---------------- 可用性 ---------------- */

export interface ObligationFact {
  type: 'AFTER_SCHOOL' | 'DUTY' | 'MEETING' | 'TRAINING' | 'OUTSIDE_ACTIVITY';
  certainty: Certainty;
  source: 'FILING' | 'NOTICE' | 'MANUAL';
}

export interface AvailabilityQuery {
  teacherId: string;
  date: string;
  period: number;
  hasLesson: boolean;
  obligations: ObligationFact[];
}

export type AvailabilityCode = 'AVAILABLE' | 'OCCUPIED' | 'UNKNOWN';

export interface AvailabilityOutcome {
  outcome: AvailabilityCode;
  /** 无法核实的占用来源，必须显式返回，不得静默视为可用 */
  unverified: string[];
  /** 明确声明：可用性判断不包含"意愿" */
  willingnessAssessed: false;
}

/* ---------------- 代课应答 ---------------- */

export interface SubstituteResponse {
  requestId: string;
  teacherId: string;
  delivery: 'DELIVERED' | 'FAILED';
  read: boolean;
  decision: 'ACCEPT' | 'DECLINE' | null;
}

export type ConsentCode = 'ACCEPTED' | 'DECLINED' | 'PENDING_CONFIRMATION';

export interface ConsentOutcome {
  outcome: ConsentCode;
  /** 是否构成"针对该方案版本的本人同意" */
  isAgreement: boolean;
  /** 是否已构成正式授课责任变更（永远为 false，需冲突校验+事务） */
  effective: boolean;
}

/* ---------------- 协调责任 ---------------- */

export type CoordinationEventType =
  | 'REQUEST_SENT'
  | 'ACCEPT_ONLINE'
  | 'ACCEPT_ORAL'
  | 'DECLINE'
  | 'HANDOVER'
  | 'DELIVERY_FAILED';

export interface CoordinationEvent {
  type: CoordinationEventType;
  actorId: string;
  /** 事实发生时间 */
  at: string;
  /** 录入时间（口头事件可能晚于 at） */
  recordedAt?: string;
}

export type OwnerCode = 'NO_OWNER' | 'OWNER' | 'AMBIGUOUS' | 'ESCALATED';

export interface OwnerOutcome {
  outcome: OwnerCode;
  ownerId: string | null;
  /** 存在未裁定的先后冲突（O2-1 未关闭） */
  requiresAdjudication: boolean;
  sources: string[];
}

/* ---------------- 第三方转述 ---------------- */

export interface ThirdPartyClaim {
  claimedBy: string;
  aboutTeacherId: string;
  /** NONE = 无任何可核验依据；SIGNED_FORM = 有签字单据；ORAL_BY_AUTHORIZED = 授权人员口头登记 */
  basis: 'NONE' | 'SIGNED_FORM' | 'ORAL_BY_AUTHORIZED';
  claimerIsAuthorizedRecorder: boolean;
}

export type ClaimCode = 'REJECTED' | 'RECORDED_PENDING';

export interface ClaimOutcome {
  outcome: ClaimCode;
  /** 是否生成了"本人确认"——正确实现恒为 false */
  generatesConfirmation: boolean;
  reason: string;
}

/* ---------------- 确认与生效 ---------------- */

export interface Confirmation {
  teacherId: string;
  /** 该确认所针对的方案版本 */
  proposalRevision: number;
  decision: 'ACCEPT' | 'DECLINE';
}

export interface ConfirmationSet {
  proposalId: string;
  /** 当前方案版本 */
  proposalRevision: number;
  required: string[];
  confirmations: Confirmation[];
}

export type ConfirmationCode =
  | 'READY_TO_APPLY'
  | 'PENDING_CONFIRMATION'
  | 'STALE_CONFIRMATION'
  | 'DECLINED';

export interface ConfirmationOutcome {
  outcome: ConfirmationCode;
  missing: string[];
  /** 被判定为失效的旧版本确认 */
  stale: string[];
}

/* ---------------- 纠错 ---------------- */

export interface Correction {
  changeId: string;
  /** 变更后的责任主体是否与变更前不同 */
  responsibilityChanged: boolean;
  field: string;
}

export type CorrectionCode =
  | 'FACTUAL_CORRECTION'
  | 'REQUIRES_NEW_PROPOSAL'
  | 'NOT_CONFIGURED';

export interface CorrectionOutcome {
  outcome: CorrectionCode;
  requiresNewProposal: boolean;
  /** 字段白名单（BIZ-01）未配置时，不得自动放行 */
  whitelistStatus: 'NOT_CONFIGURED' | 'ALLOWED' | 'DENIED';
}

/* ---------------- 轮换 ---------------- */

export interface RotationSession {
  occurrenceId: string;
  /** 轮换依据的声明来源；未声明则为 null */
  declaredRule: 'PARITY' | 'ACTUAL_COUNT' | null;
}

export interface RotationOutcome {
  outcome: 'UNKNOWN_ROTATION' | 'COMPUTED';
  computed: boolean;
  reason: string;
}

/* ---------------- 执行事实 ---------------- */

export interface ExecutionRecord {
  occurrenceId: string;
  scheduled: boolean;
  /** 是否由授权人员显式登记为已执行 */
  executedRegistered: boolean;
  executedRegisteredBy: string | null;
}

export interface ExecutionOutcome {
  outcome: 'NOT_EXECUTED' | 'EXECUTED';
  settlementEligible: false;
}

/* ---------------- 代录 ---------------- */

export interface ProxyRecord {
  occurrenceId: string;
  recordedBy: string;
  recordedForTeacherId: string;
  teacherConfirmed: boolean;
}

export interface ProxyOutcome {
  outcome: 'PENDING_TEACHER_CONFIRMATION' | 'CONFIRMED_BY_TEACHER';
  teacherConfirmed: boolean;
  /** 代录人不能替代教师确认 */
  countsAsTeacherConfirmation: boolean;
}

/* ---------------- 访问边界 ---------------- */

export interface NetworkContext {
  fromExternal: boolean;
}

export interface AccessOutcome {
  outcome: 'ALLOWED' | 'DENIED_EXTERNAL';
}

/* ---------------- 课后服务 ---------------- */

export interface AfterSchoolFact {
  filingExists: boolean;
  actualKnown: boolean;
}

export interface AfterSchoolOutcome {
  outcome: 'KNOWN_FILING' | 'UNKNOWN_ACTUAL';
  treatFilingAsActual: boolean;
}

/* ---------------- 历史 ---------------- */

export interface HistoryEvent {
  id: string;
  type: 'ORIGINAL' | 'CORRECTION' | 'CHANGE' | 'RECOVERY';
  at: string;
  actorId: string;
  prevHash: string;
  payload: string;
}

export interface HistoryOutcome {
  appendOnly: true;
  entries: HistoryEvent[];
  chainValid: boolean;
  /** 被抹除的事件（必须为空） */
  erased: string[];
}

/* ---------------- 课次生成 ---------------- */

export interface Template {
  id: string;
  classId: string;
  teacherId: string;
  subject: string;
  weekday: 1 | 2 | 3 | 4 | 5;
  period: number;
  parity: 'ALL' | 'ODD' | 'EVEN';
  rotation: 'NONE' | 'CUSTOM';
  endsAt: string | null;
}

export interface Calendar {
  termStartMonday: string;
  /** 第 0 周记为 ODD */
  holidays: string[];
}

export interface OccurrenceResult {
  outcome: 'OK' | 'UNKNOWN_ROTATION';
  occurrences: Array<{
    templateId: string;
    classId: string;
    teacherId: string;
    date: string;
    period: number;
    startsAt: string | null;
    endsAt: string | null;
    certainty: Certainty;
  }>;
  rotationUnknown: string[];
}

/* ---------------- 必要确认者 ---------------- */

export interface Move {
  occurrenceId: string;
  fromTeacherId: string;
  toTeacherId: string;
  classId: string;
}

export interface ChangeProposal {
  id: string;
  revision: number;
  moves: Move[];
}

export interface ConfirmerSet {
  required: string[];
  notified: string[];
}

/* ---------------- 变更应用 ---------------- */

export interface ApplyRequest {
  changeId: string;
  idempotencyKey: string;
  targetOccurrenceIds: string[];
  executedOccurrenceIds: string[];
  alreadyAppliedKeys: string[];
}

export interface ApplyOutcome {
  applied: boolean;
  duplicate: boolean;
  appliedOccurrenceIds: string[];
  skippedExecuted: string[];
}

/* ---------------- 应急升级 ---------------- */

export interface EscalationEvent {
  type: 'PRIMARY_DECLINED' | 'PRIMARY_UNREACHABLE' | 'NO_RESPONSE';
  at: string;
}

export interface EscalationOutcome {
  outcome: 'IMMEDIATE_ESCALATION' | 'MANUAL_ONLY' | 'NOT_CONFIGURED';
  target: 'DEPUTY' | null;
  generatesTeachingConfirmation: false;
}

/* ---------------- 结案 ---------------- */

export interface Closure {
  caseId: string;
  submittedBy: string;
  approvedBy: string | null;
  teachingVerified: boolean;
}

export interface ClosureOutcome {
  outcome: 'PENDING_APPROVAL' | 'CLOSED' | 'REJECTED_SELF_APPROVAL';
  teachingStillPending: boolean;
  caseClosed: boolean;
}

/* ---------------- 权限 ---------------- */

export interface ResourceRef {
  kind: 'PRIVATE_REASON' | 'CONFIRMATION' | 'BACKUP' | 'PUBLIC_TIMETABLE';
  ownerTeacherId?: string;
}

export interface AuthorizationOutcome {
  allowed: boolean;
  reason: string;
}

/* ---------------- 引擎接口 ---------------- */

export interface Engine {
  importBatch(batch: ImportBatch): ImportOutcome;
  availability(q: AvailabilityQuery): AvailabilityOutcome;
  substituteConsent(r: SubstituteResponse): ConsentOutcome;
  coordinationOwner(events: CoordinationEvent[]): OwnerOutcome;
  thirdPartyClaim(c: ThirdPartyClaim): ClaimOutcome;
  confirmationState(cs: ConfirmationSet): ConfirmationOutcome;
  classifyCorrection(c: Correction): CorrectionOutcome;
  rotation(s: RotationSession): RotationOutcome;
  execution(r: ExecutionRecord): ExecutionOutcome;
  proxyRecord(r: ProxyRecord): ProxyOutcome;
  access(net: NetworkContext, p: Principal | null): AccessOutcome;
  afterSchool(f: AfterSchoolFact): AfterSchoolOutcome;
  history(events: HistoryEvent[], erased: string[]): HistoryOutcome;
  generateOccurrences(templates: Template[], cal: Calendar, date: string, bell: Record<number, string>): OccurrenceResult;
  requiredConfirmers(p: ChangeProposal, classHeadByClass: Record<string, string>): ConfirmerSet;
  applyChange(r: ApplyRequest): ApplyOutcome;
  escalate(events: EscalationEvent[]): EscalationOutcome;
  closeCase(c: Closure): ClosureOutcome;
  authorize(p: Principal | null, action: 'READ' | 'CONFIRM' | 'DOWNLOAD_BACKUP', res: ResourceRef): AuthorizationOutcome;
}
