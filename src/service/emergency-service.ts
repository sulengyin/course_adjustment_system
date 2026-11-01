/**
 * 应急协调服务（P6 受限实现）。
 *
 * 本阶段只开放一件确定能做的事：**教师为本人课次发起求助**。
 * 其余操作都依赖未关闭的规则，一律返回显式状态并留审计，不"先做一半"：
 *
 *   口头接受登记   D06/D07（记录者任职名单未定）
 *   接单/移交      E5/D07/O2-1（候选范围、有效定义、来源先后未定）
 *   结案           BIZ-05（确认人未定）
 *   执行事实       BIZ-03（何时算已执行未定）
 *   补确认逾期     BIZ-04/TIME（截止钟点未定）
 *
 * 为什么不让"有 C 角色就先跑起来"：C 是动态角色，只能由接单产生；
 * 而接单的候选范围本身未定。先放行会让系统替学校决定"谁有资格接单"。
 */

import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth/principal.js';
import { type Action, can } from '../auth/policy.js';
import type { CoordinationStatus, TeachingVerification } from '../domain/emergency.js';
import { escalation } from '../domain/emergency.js';
import type { CourseDatabase } from '../store/database.js';
import { ChangeStore } from '../store/change-store.js';
import { EmergencyStore, type EmergencyRequestRecord } from '../store/emergency-store.js';

const MAX_NOTE_LENGTH = 2000;

export type EmergencyCode =
  | 'REQUESTED'
  | 'FOUND'
  | 'DUPLICATE_REPLAY'
  | 'NO_ESCALATION'
  | 'NOT_FOUND'
  | 'NOT_OWNER'
  | 'FORBIDDEN'
  | 'BAD_INPUT'
  | 'INVALID_OCCURRENCE'
  | 'ROLE_NOT_ASSIGNED'
  | 'NOT_CONFIGURED'
  | 'NO_COORDINATION_OWNER';

export interface EmergencyRequestView {
  readonly id: string;
  readonly termId: string;
  readonly occurrenceId: string;
  readonly requesterTeacherId: string;
  readonly note: string;
  readonly status: CoordinationStatus;
  readonly ownerTeacherId: string | null;
  readonly provisionalTeacherId: string | null;
  readonly teachingVerification: TeachingVerification;
  readonly closureSubmittedAt: string | null;
  readonly createdAt: string;
}

export interface EmergencySummary {
  readonly ok: boolean;
  readonly code: EmergencyCode;
  readonly requestId: string | null;
  readonly status: CoordinationStatus | null;
  readonly ownerTeacherId: string | null;
  readonly provisionalTeacherId: string | null;
  /** 送达语义未定（BIZ-13）：本阶段恒为 false，不得据此显示"已通知到人"。 */
  readonly notified: false;
  readonly teachingVerification: TeachingVerification | null;
  readonly blockedBy: readonly string[];
  readonly duplicate: boolean;
  readonly request: EmergencyRequestView | null;
}

export interface EmergencyServiceOptions {
  readonly now?: () => string;
  readonly newId?: () => string;
}

function view(record: EmergencyRequestRecord): EmergencyRequestView {
  return {
    id: record.id,
    termId: record.termId,
    occurrenceId: record.occurrenceId,
    requesterTeacherId: record.requesterTeacherId,
    note: record.note,
    status: record.status,
    ownerTeacherId: record.ownerTeacherId,
    provisionalTeacherId: record.provisionalTeacherId,
    teachingVerification: record.teachingVerification,
    closureSubmittedAt: record.closureSubmittedAt,
    createdAt: record.createdAt,
  };
}

function summary(
  code: EmergencyCode,
  input: {
    request?: EmergencyRequestRecord | null;
    blockedBy?: readonly string[];
    duplicate?: boolean;
  } = {},
): EmergencySummary {
  const request = input.request ?? null;
  return {
    ok: code === 'REQUESTED' || code === 'FOUND' || code === 'DUPLICATE_REPLAY' || code === 'NO_ESCALATION',
    code,
    requestId: request?.id ?? null,
    status: request?.status ?? null,
    ownerTeacherId: request?.ownerTeacherId ?? null,
    provisionalTeacherId: request?.provisionalTeacherId ?? null,
    notified: false,
    teachingVerification: request?.teachingVerification ?? null,
    blockedBy: input.blockedBy ?? [],
    duplicate: input.duplicate ?? false,
    request: request ? view(request) : null,
  };
}

export class EmergencyService {
  private readonly store: EmergencyStore;
  private readonly assignments: ChangeStore;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly db: CourseDatabase,
    options: EmergencyServiceOptions = {},
  ) {
    this.store = new EmergencyStore(db.handle, db.auditLog);
    this.assignments = new ChangeStore(db.handle);
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  private deny(principal: Principal, action: Action, code: EmergencyCode, requestId: string | null): EmergencySummary {
    this.store.auditDenied({
      at: this.now(),
      actor: principal.userId,
      action,
      code,
      requestId,
    });
    return summary(code);
  }

  private guard(principal: Principal, action: Action): EmergencySummary | null {
    if (principal.mustChangePassword) return this.deny(principal, action, 'FORBIDDEN', null);
    const decision = can(principal, action);
    if (decision.allowed) return null;
    return this.deny(principal, action, decision.code === 'ROLE_NOT_ASSIGNED' ? 'ROLE_NOT_ASSIGNED' : 'FORBIDDEN', null);
  }

  /**
   * 发起求助：只能针对本人当前承担的课次。
   * 只记录"求助"这一事实，不产生通知、负责人、结案或授课核验。
   */
  requestHelp(input: {
    readonly principal: Principal;
    readonly termId: string;
    readonly occurrenceId: string;
    readonly note: string;
    readonly idempotencyKey: string;
  }): EmergencySummary {
    const denied = this.guard(input.principal, 'REQUEST_HELP');
    if (denied) return denied;

    const teacherId = input.principal.teacherId;
    if (!teacherId) return this.deny(input.principal, 'REQUEST_HELP', 'FORBIDDEN', null);

    const note = input.note.trim();
    if (note === '' || note.length > MAX_NOTE_LENGTH) return summary('BAD_INPUT');
    const key = input.idempotencyKey.trim();
    if (key === '' || input.termId.trim() === '' || input.occurrenceId.trim() === '') return summary('BAD_INPUT');

    const existing = this.store.findByKey(key);
    if (existing) {
      if (existing.requesterTeacherId !== teacherId) return summary('NOT_OWNER');
      return summary('DUPLICATE_REPLAY', { request: existing, duplicate: true });
    }

    const occurrence = this.assignments
      .activeAssignments(input.termId)
      .find((a) => a.occurrenceId === input.occurrenceId);
    if (!occurrence || occurrence.cancelled) return summary('INVALID_OCCURRENCE');
    if (occurrence.teacherId !== teacherId) return this.deny(input.principal, 'REQUEST_HELP', 'FORBIDDEN', null);

    const at = this.now();
    const record: EmergencyRequestRecord = {
      id: this.newId(),
      termId: input.termId,
      occurrenceId: occurrence.occurrenceId,
      requesterTeacherId: teacherId,
      note,
      status: 'REQUESTED',
      ownerTeacherId: null,
      provisionalTeacherId: null,
      teachingVerification: 'PENDING',
      closureSubmittedAt: null,
      idempotencyKey: key,
      createdAt: at,
      updatedAt: at,
    };
    this.db.transaction(() => this.store.insert(record));
    return summary('REQUESTED', { request: record });
  }

  /** 我的求助列表。只返回本人的，管理员同样看不到他人的求助内容。 */
  listMine(principal: Principal, limit = 50): {
    readonly ok: boolean;
    readonly code: EmergencyCode;
    readonly requests: readonly EmergencyRequestView[];
  } {
    const denied = this.guard(principal, 'VIEW_OWN_EMERGENCY_REQUEST');
    if (denied) return { ok: false, code: denied.code, requests: [] };
    const teacherId = principal.teacherId;
    if (!teacherId) return { ok: false, code: 'FORBIDDEN', requests: [] };
    return { ok: true, code: 'FOUND', requests: this.store.listByRequester(teacherId, limit).map(view) };
  }

  /** 求助人查看自己的请求；其他人（含管理员）不可见，避免私人情况外泄。 */
  getForRequester(principal: Principal, requestId: string): EmergencySummary {
    const denied = this.guard(principal, 'VIEW_OWN_EMERGENCY_REQUEST');
    if (denied) return denied;
    const teacherId = principal.teacherId;
    if (!teacherId) return this.deny(principal, 'VIEW_OWN_EMERGENCY_REQUEST', 'FORBIDDEN', requestId);

    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    if (record.requesterTeacherId !== teacherId) {
      return this.deny(principal, 'VIEW_OWN_EMERGENCY_REQUEST', 'FORBIDDEN', requestId);
    }
    return summary('FOUND', { request: record });
  }

  /** 送达判定未定（BIZ-13）：不提供"标记已通知"的写入口。 */
  markNotified(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    this.store.auditDenied({
      at: this.now(),
      actor: principal.userId,
      action: 'MARK_NOTIFIED',
      code: 'NOT_CONFIGURED',
      requestId,
    });
    return summary('NOT_CONFIGURED', { request: record, blockedBy: Object.freeze(['BIZ-13']) });
  }

  /** 口头接受登记：记录者任职名单未定（D06/D07），任何人都不得登记。 */
  recordOralAcceptance(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'RECORD_ORAL_ACCEPTANCE');
    return denied ?? summary('ROLE_NOT_ASSIGNED', { request: record, blockedBy: Object.freeze(['D06', 'D07']) });
  }

  /** 接单：候选范围与"有效接单"定义未定（E5/D07/O2-1）。 */
  claim(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'CLAIM_COORDINATION');
    if (denied) return denied;
    this.store.auditDenied({
      at: this.now(),
      actor: principal.userId,
      action: 'CLAIM_COORDINATION',
      code: 'NOT_CONFIGURED',
      requestId,
    });
    return summary('NOT_CONFIGURED', { request: record, blockedBy: Object.freeze(['E5', 'D07', 'O2-1']) });
  }

  transfer(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'TRANSFER_COORDINATION');
    if (denied) return denied;
    this.store.auditDenied({
      at: this.now(),
      actor: principal.userId,
      action: 'TRANSFER_COORDINATION',
      code: 'NOT_CONFIGURED',
      requestId,
    });
    return summary('NOT_CONFIGURED', { request: record, blockedBy: Object.freeze(['D07']) });
  }

  /** 没有负责人就不能提交结案；而当前阶段无法产生负责人。 */
  submitClosure(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'SUBMIT_CLOSURE');
    if (denied) return denied;
    if (!record.ownerTeacherId) return summary('NO_COORDINATION_OWNER', { request: record });
    return summary('NOT_CONFIGURED', { request: record, blockedBy: Object.freeze(['BIZ-05']) });
  }

  /** 结案确认人未指定（BIZ-05）。 */
  confirmClosure(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'CONFIRM_CLOSURE');
    return denied ?? summary('ROLE_NOT_ASSIGNED', { request: record, blockedBy: Object.freeze(['BIZ-05']) });
  }

  /** 执行事实录入未定（BIZ-03）：不提供入口。 */
  recordExecutionFact(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    const denied = this.guard(principal, 'RECORD_EXECUTION_FACT');
    return denied ?? summary('ROLE_NOT_ASSIGNED', { request: record, blockedBy: Object.freeze(['BIZ-03']) });
  }

  /** 补确认截止钟点未定（BIZ-04/TIME）：不返回任何推算结果。 */
  overdue(principal: Principal, requestId: string): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    void principal;
    return summary('NOT_CONFIGURED', { request: record, blockedBy: Object.freeze(['BIZ-04', 'TIME']) });
  }

  /** 主责拒绝的记录可以存在，但升级目标未定（E5）。 */
  escalate(principal: Principal, requestId: string, primaryDeclined: boolean): EmergencySummary {
    const record = this.store.get(requestId);
    if (!record) return summary('NOT_FOUND');
    void principal;
    const result = escalation({ primaryDeclined });
    if (result.code === 'NO_ESCALATION') return summary('NO_ESCALATION', { request: record });
    return summary('NOT_CONFIGURED', { request: record, blockedBy: result.blockedBy });
  }
}
