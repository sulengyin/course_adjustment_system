/**
 * P4 变更协商服务：草案 → 提交 → 逐人确认 → 冲突复核 → 单事务生效 → 审计。
 *
 * 未实现且不得实现的：
 *   - 管理员代确认、代拒绝
 *   - 沉默/已读/旧版本确认视为同意
 *   - 删除已生效变更
 *   - 线下材料作为确认输入（D01/D02 未关闭）
 */

import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth/principal.js';
import { can } from '../auth/policy.js';
import { PolicyDeniedError } from '../auth/service.js';
import {
  type Assignment,
  type CaseStatus,
  type ChangeError,
  type ChangeItem,
  type ChangeItemKind,
  type ConfirmationRecord,
  canTransition,
  confirmationState,
  projectChange,
} from '../domain/change.js';
import type { CourseDatabase } from '../store/database.js';
import { type ActiveAssignment, ChangeStore, type ChangeCaseRecord, type StoredItem } from '../store/change-store.js';

export interface ChangeServiceOptions {
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface SubmitInput {
  readonly termId: string;
  /** 发起人身份。系统只认会话签发的主体，不接受裸 ID。 */
  readonly principal: Principal;
  readonly items: readonly ChangeItem[];
  readonly reason: string | null;
  /** 幂等键：HTTP 层要求非空；服务层把空串按"未提供"存 NULL，避免撞 UNIQUE 约束。 */
  readonly idempotencyKey: string;
  readonly classHeadByClass?: Readonly<Record<string, string>>;
}

export interface ChangeSummary {
  readonly ok: boolean;
  readonly code:
    | 'CREATED'
    | 'SUBMITTED'
    | 'BLOCKED_CONFLICT'
    | 'DUPLICATE_REPLAY'
    | 'CASE_NOT_FOUND'
    | 'INVALID_STATUS'
    | 'NO_ITEMS'
    | 'NOT_A_CONFIRMER'
    | 'NOT_OWNER'
    | 'EFFECTIVE'
    | 'STALE_VERSION'
    | 'EXECUTED_NOT_CHANGEABLE'
    | 'NOTHING_TO_APPLY'
    | 'METHOD_NOT_ALLOWED';
  readonly caseId: string | null;
  readonly revision: number;
  readonly status: CaseStatus | null;
  readonly required: readonly string[];
  readonly notified: readonly string[];
  readonly notifiedUnknownClasses: readonly string[];
  readonly conflicts: readonly ChangeError[];
  readonly duplicate: boolean;
}

/** 界面/接口共用的方案视图。`reason` 是否带值由调用者身份决定，不由前端决定。 */
export interface ChangeItemView {
  readonly occurrenceId: string;
  readonly kind: ChangeItemKind;
  readonly toTeacherId: string | null;
  readonly toTeacherName: string | null;
  readonly toDate: string | null;
  readonly toPeriod: number | null;
  /** 变更前的当前归属；课次已不存在时为 null，界面显示原 ID 而不是编造名称 */
  readonly current: {
    readonly classId: string;
    readonly className: string;
    readonly subjectName: string;
    readonly teacherId: string;
    readonly teacherName: string;
    readonly date: string;
    readonly period: number;
    readonly cancelled: boolean;
  } | null;
}

export interface ChangeCaseView {
  readonly caseId: string;
  readonly kind: 'CHANGE' | 'RECOVERY';
  readonly status: CaseStatus;
  readonly revision: number;
  readonly termId: string;
  readonly submittedBy: string;
  readonly submittedByName: string | null;
  readonly isMine: boolean;
  /** 仅发起人可见；其他角色（含管理员）为 null */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly ChangeItemView[];
  readonly required: readonly string[];
  readonly requiredNames: Readonly<Record<string, string>>;
  readonly confirmations: ReadonlyArray<{
    readonly teacherId: string;
    readonly teacherName: string | null;
    readonly revision: number;
    readonly decision: 'ACCEPT' | 'DECLINE';
    readonly recordedAt: string;
  }>;
  readonly awaitingMe: boolean;
  readonly canWithdraw: boolean;
}

export interface ChangeCaseDetail {
  readonly ok: boolean;
  readonly code: 'FOUND' | 'CASE_NOT_FOUND' | 'FORBIDDEN';
  readonly case: ChangeCaseView | null;
}

export interface ApplyResult {  readonly ok: boolean;
  readonly code:
    | 'APPLIED'
    | 'CASE_NOT_FOUND'
    | 'INVALID_STATUS'
    | 'NOT_READY'
    | 'STALE_VERSION'
    | 'EXECUTED_NOT_CHANGEABLE'
    | 'NOTHING_TO_APPLY';
  readonly applied: readonly string[];
  readonly skippedExecuted: readonly string[];
  readonly status: CaseStatus | null;
  readonly detail: string | null;
}

class StaleVersionError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`课次 ${occurrenceId} 已被其他方案改变`);
  }
}

class ExecutedError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`课次 ${occurrenceId} 已登记执行，不得改写`);
  }
}

class NothingToApplyError extends Error {}

function toAssignment(a: ActiveAssignment): Assignment {
  return {
    occurrenceId: a.occurrenceId,
    classId: a.classId,
    subjectId: a.subjectId,
    teacherId: a.teacherId,
    date: a.date,
    period: a.period,
    cancelled: a.cancelled,
  };
}

function toChangeItem(s: StoredItem): ChangeItem {
  return {
    occurrenceId: s.occurrenceId,
    kind: s.kind,
    toTeacherId: s.toTeacherId,
    toDate: s.toDate,
    toPeriod: s.toPeriod,
  };
}

function normalizeKey(key: string): string | null {
  const trimmed = key.trim();
  return trimmed === '' ? null : trimmed;
}

function emptySummary(
  code: ChangeSummary['code'],
  caseId: string | null,
): ChangeSummary {
  return {
    ok: false,
    code,
    caseId,
    revision: 0,
    status: null,
    required: [],
    notified: [],
    notifiedUnknownClasses: [],
    conflicts: [],
    duplicate: false,
  };
}

export class ChangeService {
  private readonly store: ChangeStore;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly db: CourseDatabase,
    options: ChangeServiceOptions = {},
  ) {
    this.store = new ChangeStore(db.handle);
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** 服务层也做一次权限判定：即使有人绕过路由直接调用，也不会因"忘了鉴权"而放行。 */
  private assertCan(principal: Principal, action: 'CREATE_OWN_CHANGE' | 'DECIDE_OWN_CONFIRMATION'): void {
    if (principal.mustChangePassword) {
      throw new PolicyDeniedError('FORBIDDEN', action);
    }
    const decision = can(principal, action);
    if (!decision.allowed) {
      throw new PolicyDeniedError(decision.code === 'ROLE_NOT_ASSIGNED' ? 'ROLE_NOT_ASSIGNED' : 'FORBIDDEN', action);
    }
  }

  /** 教师身份必须来自账号绑定，不能由调用方声明。 */
  private requireTeacher(principal: Principal): string {
    if (!principal.teacherId) {
      throw new PolicyDeniedError('FORBIDDEN', 'CREATE_OWN_CHANGE');
    }
    return principal.teacherId;
  }

  /**
   * 只有"本次方案确实改变了我自己的授课责任"的人才能发起。
   * 这排除代他人发起，但不要求方案只涉及本人（互换会涉及对方，对方之后确认）。
   */
  private assertOwnsAffected(
    principal: Principal,
    items: readonly ChangeItem[],
    before: readonly ActiveAssignment[],
  ): void {
    const teacherId = this.requireTeacher(principal);
    const byId = new Map(before.map((a) => [a.occurrenceId, a]));
    const mine = items.some((item) => byId.get(item.occurrenceId)?.teacherId === teacherId);
    if (!mine) throw new PolicyDeniedError('FORBIDDEN', 'CREATE_OWN_CHANGE');
  }

  /** 创建草稿并立即提交；同一幂等键重复调用返回首次结果，不产生第二个方案。 */
  submitNew(input: SubmitInput): ChangeSummary {
    this.assertCan(input.principal, 'CREATE_OWN_CHANGE');
    const existing = this.store.findByKey(input.idempotencyKey.trim());
    if (existing) {
      // 幂等键属于发起人；别人拿同一个键不能读到该方案。
      if (existing.submittedBy !== this.requireTeacher(input.principal)) {
        return emptySummary('NOT_OWNER', existing.id);
      }
      const items = this.store.itemsOf(existing.id, existing.revision);
      const projection = projectChange(
        this.store.activeAssignments(existing.termId).map(toAssignment),
        items.map(toChangeItem),
        input.classHeadByClass ?? {},
      );
      return {
        ok: true,
        code: 'DUPLICATE_REPLAY',
        caseId: existing.id,
        revision: existing.revision,
        status: existing.status,
        required: projection.required,
        notified: projection.notified,
        notifiedUnknownClasses: projection.notifiedUnknownClasses,
        conflicts: projection.errors,
        duplicate: true,
      };
    }

    const created = this.createDraft(input);
    if (!created.caseId) return created;
    // 草稿阶段的冲突不阻止提交：提交时统一裁决并标记 BLOCKED_CONFLICT
    return this.submit(created.caseId, input.classHeadByClass ?? {});
  }

  createDraft(input: SubmitInput): ChangeSummary {
    this.assertCan(input.principal, 'CREATE_OWN_CHANGE');
    if (input.items.length === 0) return emptySummary('NO_ITEMS', null);

    const at = this.now();
    const caseId = this.newId();
    const before = this.store.activeAssignments(input.termId);
    this.assertOwnsAffected(input.principal, input.items, before);
    const submittedBy = this.requireTeacher(input.principal);
    const projection = projectChange(
      before.map(toAssignment),
      input.items,
      input.classHeadByClass ?? {},
    );

    this.db.transaction(() => {
      this.store.insertCase({
        id: caseId,
        termId: input.termId,
        kind: 'CHANGE',
        parentChangeId: null,
        status: 'DRAFT',
        revision: 1,
        submittedBy,
        reason: input.reason,
        idempotencyKey: normalizeKey(input.idempotencyKey),
        createdAt: at,
        updatedAt: at,
      });
      const versionById = new Map(before.map((a) => [a.occurrenceId, a.version]));
      this.store.replaceItems(
        caseId,
        1,
        input.items.map((item) => ({
          occurrenceId: item.occurrenceId,
          kind: item.kind,
          toTeacherId: item.toTeacherId,
          toDate: item.toDate,
          toPeriod: item.toPeriod,
          expectedVersion: versionById.get(item.occurrenceId) ?? 0,
        })),
      );
      this.store.insertAudit({
        at,
        actor: submittedBy,
        action: 'CREATE_DRAFT',
        objectType: 'CHANGE_CASE',
        objectId: caseId,
        beforeState: null,
        afterState: 'DRAFT',
        // 私人理由不进审计链：它属于师生个人材料，审计可见范围更大。
        reason: input.reason === null ? null : 'REASON_PROVIDED',
      });
    });

    return {
      ok: projection.errors.length === 0,
      code: 'CREATED',
      caseId,
      revision: 1,
      status: 'DRAFT',
      required: projection.required,
      notified: projection.notified,
      notifiedUnknownClasses: projection.notifiedUnknownClasses,
      conflicts: projection.errors,
      duplicate: false,
    };
  }

  submit(
    changeId: string,
    classHeadByClass: Readonly<Record<string, string>> = {},
  ): ChangeSummary {
    const record = this.store.getCase(changeId);
    if (!record) return emptySummary('CASE_NOT_FOUND', changeId);
    if (!canTransition(record.status, 'PENDING_CONFIRMATION')) {
      return emptySummary('INVALID_STATUS', changeId);
    }

    const at = this.now();
    const items = this.store.itemsOf(changeId, record.revision);
    const projection = projectChange(
      this.store.activeAssignments(record.termId).map(toAssignment),
      items.map(toChangeItem),
      classHeadByClass,
    );

    const blocking = projection.errors.filter((e) => !e.preExisting);
    if (blocking.length > 0) {
      this.db.transaction(() => {
        this.store.updateStatus(changeId, 'BLOCKED_CONFLICT', at);
        this.store.insertAudit({
          at,
          actor: record.submittedBy,
          action: 'BLOCK',
          objectType: 'CHANGE_CASE',
          objectId: changeId,
          beforeState: record.status,
          afterState: 'BLOCKED_CONFLICT',
          reason: blocking.map((e) => e.code).join(','),
        });
      });
      return {
        ok: false,
        code: 'BLOCKED_CONFLICT',
        caseId: changeId,
        revision: record.revision,
        status: 'BLOCKED_CONFLICT',
        required: projection.required,
        notified: projection.notified,
        notifiedUnknownClasses: projection.notifiedUnknownClasses,
        conflicts: blocking,
        duplicate: false,
      };
    }

    this.db.transaction(() => {
      this.store.updateStatus(changeId, 'PENDING_CONFIRMATION', at);
      this.store.replaceRequired(changeId, record.revision, projection.required);
      this.store.clearNotifications(changeId);
      for (const teacherId of projection.required) {
        this.store.insertNotification({
          id: this.newId(),
          changeId,
          recipientId: teacherId,
          kind: 'CONFIRMATION_REQUIRED',
          at,
        });
      }
      for (const head of projection.notified) {
        this.store.insertNotification({
          id: this.newId(),
          changeId,
          recipientId: head,
          kind: 'CLASS_HEAD_NOTICE',
          at,
        });
      }
      this.store.insertAudit({
        at,
        actor: record.submittedBy,
        action: 'SUBMIT',
        objectType: 'CHANGE_CASE',
        objectId: changeId,
        beforeState: record.status,
        afterState: 'PENDING_CONFIRMATION',
        reason: null,
      });
    });

    return {
      ok: true,
      code: 'SUBMITTED',
      caseId: changeId,
      revision: record.revision,
      status: 'PENDING_CONFIRMATION',
      required: projection.required,
      notified: projection.notified,
      notifiedUnknownClasses: projection.notifiedUnknownClasses,
      conflicts: [],
      duplicate: false,
    };
  }

  /** 改案：版本 +1，旧版本确认保留但不再有效。只有发起人可以改。 */
  revise(
    changeId: string,
    principal: Principal,
    items: readonly ChangeItem[],
    classHeadByClass: Readonly<Record<string, string>> = {},
  ): ChangeSummary {
    const record = this.store.getCase(changeId);
    if (!record) return emptySummary('CASE_NOT_FOUND', changeId);
    this.assertCan(principal, 'CREATE_OWN_CHANGE');
    if (record.submittedBy !== this.requireTeacher(principal)) {
      return emptySummary('NOT_OWNER', changeId);
    }
    if (
      !canTransition(record.status, 'PENDING_CONFIRMATION') &&
      record.status !== 'DRAFT'
    ) {
      return emptySummary('INVALID_STATUS', changeId);
    }
    if (items.length === 0) return emptySummary('NO_ITEMS', changeId);

    const at = this.now();
    const before = this.store.activeAssignments(record.termId);
    this.assertOwnsAffected(principal, items, before);
    const projection = projectChange(
      before.map(toAssignment),
      items,
      classHeadByClass,
    );
    const blocking = projection.errors.filter((e) => !e.preExisting);

    let revision = 0;
    this.db.transaction(() => {
      revision = this.store.bumpRevision(changeId, at);
      const versionById = new Map(before.map((a) => [a.occurrenceId, a.version]));
      this.store.replaceItems(
        changeId,
        revision,
        items.map((item) => ({
          occurrenceId: item.occurrenceId,
          kind: item.kind,
          toTeacherId: item.toTeacherId,
          toDate: item.toDate,
          toPeriod: item.toPeriod,
          expectedVersion: versionById.get(item.occurrenceId) ?? 0,
        })),
      );
      this.store.clearNotifications(changeId);
      if (blocking.length === 0) {
        this.store.replaceRequired(changeId, revision, projection.required);
        for (const teacherId of projection.required) {
          this.store.insertNotification({
            id: this.newId(),
            changeId,
            recipientId: teacherId,
            kind: 'CONFIRMATION_REQUIRED',
            at,
          });
        }
        for (const head of projection.notified) {
          this.store.insertNotification({
            id: this.newId(),
            changeId,
            recipientId: head,
            kind: 'CLASS_HEAD_NOTICE',
            at,
          });
        }
      }
      this.store.updateStatus(
        changeId,
        blocking.length > 0 ? 'BLOCKED_CONFLICT' : 'PENDING_CONFIRMATION',
        at,
      );
      this.store.insertAudit({
        at,
        actor: record.submittedBy,
        action: 'REVISE',
        objectType: 'CHANGE_CASE',
        objectId: changeId,
        beforeState: `revision=${record.revision}`,
        afterState: `revision=${revision}`,
        reason: null,
      });
    });

    return {
      ok: blocking.length === 0,
      code: blocking.length > 0 ? 'BLOCKED_CONFLICT' : 'SUBMITTED',
      caseId: changeId,
      revision,
      status: blocking.length > 0 ? 'BLOCKED_CONFLICT' : 'PENDING_CONFIRMATION',
      required: projection.required,
      notified: projection.notified,
      notifiedUnknownClasses: projection.notifiedUnknownClasses,
      conflicts: blocking,
      duplicate: false,
    };
  }

  /** 确认只能由被要求的教师本人发起；管理员不能代确认。 */
  /**
   * 本人确认。确认者来自会话主体，不接受调用方传入的教师 ID（R-25）。
   * 确认齐备后由系统在同一流程内收尾生效——"生效"不是一项需要人类授予的权限。
   */
  decide(
    changeId: string,
    principal: Principal,
    decision: 'ACCEPT' | 'DECLINE',
    classHeadByClass: Readonly<Record<string, string>> = {},
  ): ChangeSummary {
    this.assertCan(principal, 'DECIDE_OWN_CONFIRMATION');
    const teacherId = this.requireTeacher(principal);
    const record = this.store.getCase(changeId);
    if (!record) return emptySummary('CASE_NOT_FOUND', changeId);
    if (record.status !== 'PENDING_CONFIRMATION') {
      return emptySummary('INVALID_STATUS', changeId);
    }

    const required = this.store.requiredOf(changeId, record.revision);
    if (!required.includes(teacherId)) {
      return emptySummary('NOT_A_CONFIRMER', changeId);
    }
    const items = this.store.itemsOf(changeId, record.revision);
    const projection = projectChange(
      this.store.activeAssignments(record.termId).map(toAssignment),
      items.map(toChangeItem),
      classHeadByClass,
    );

    const at = this.now();
    const records: ConfirmationRecord[] = [
      ...this.store.confirmationsOf(changeId).map((c) => ({
        teacherId: c.teacherId,
        revision: c.revision,
        decision: c.decision,
      })),
      { teacherId, revision: record.revision, decision },
    ];
    const status = confirmationState(
      required,
      record.revision,
      records,
    );

    this.db.transaction(() => {
      this.store.upsertConfirmation(
        changeId,
        teacherId,
        record.revision,
        decision,
        at,
      );
      this.store.insertAudit({
        at,
        actor: teacherId,
        action: decision === 'ACCEPT' ? 'CONFIRM' : 'DECLINE',
        objectType: 'CHANGE_CASE',
        objectId: changeId,
        beforeState: record.status,
        afterState: status.state,
        reason: null,
      });
      if (status.state === 'DECLINED') {
        this.store.updateStatus(changeId, 'REJECTED', at);
      }
    });

    if (status.state === 'READY_TO_APPLY') {
      const applied = this.applyInternal(changeId, 'SYSTEM');
      if (applied.ok) {
        return {
          ok: true,
          code: 'EFFECTIVE',
          caseId: changeId,
          revision: record.revision,
          status: 'EFFECTIVE',
          required,
          notified: projection.notified,
          notifiedUnknownClasses: projection.notifiedUnknownClasses,
          conflicts: [],
          duplicate: false,
        };
      }
      // 方案在确认期间被他人改动：不换确认人、不继续，明确返回失效原因。
      const failure: ChangeSummary['code'] =
        applied.code === 'STALE_VERSION'
          ? 'STALE_VERSION'
          : applied.code === 'EXECUTED_NOT_CHANGEABLE'
            ? 'EXECUTED_NOT_CHANGEABLE'
            : 'NOTHING_TO_APPLY';
      return {
        ok: false,
        code: failure,
        caseId: changeId,
        revision: record.revision,
        status: 'PENDING_CONFIRMATION',
        required,
        notified: projection.notified,
        notifiedUnknownClasses: projection.notifiedUnknownClasses,
        conflicts: [],
        duplicate: false,
      };
    }

    return {
      ok: status.state === 'PENDING_CONFIRMATION',
      code: 'SUBMITTED',
      caseId: changeId,
      revision: record.revision,
      status: status.state === 'DECLINED' ? 'REJECTED' : 'PENDING_CONFIRMATION',
      required,
      notified: projection.notified,
      notifiedUnknownClasses: projection.notifiedUnknownClasses,
      conflicts: [],
      duplicate: false,
    };
  }

  withdraw(changeId: string, principal: Principal): ChangeSummary {
    const record = this.store.getCase(changeId);
    if (!record) return emptySummary('CASE_NOT_FOUND', changeId);
    this.assertCan(principal, 'CREATE_OWN_CHANGE');
    if (record.submittedBy !== this.requireTeacher(principal)) {
      return emptySummary('NOT_OWNER', changeId);
    }
    if (!canTransition(record.status, 'WITHDRAWN')) {
      return emptySummary('INVALID_STATUS', changeId);
    }
    const at = this.now();
    this.db.transaction(() => {
      this.store.updateStatus(changeId, 'WITHDRAWN', at);
      this.store.insertAudit({
        at,
        actor: record.submittedBy,
        action: 'WITHDRAW',
        objectType: 'CHANGE_CASE',
        objectId: changeId,
        beforeState: record.status,
        afterState: 'WITHDRAWN',
        reason: null,
      });
    });
    return {
      ok: true,
      code: 'SUBMITTED',
      caseId: changeId,
      revision: record.revision,
      status: 'WITHDRAWN',
      required: [],
      notified: [],
      notifiedUnknownClasses: [],
      conflicts: [],
      duplicate: false,
    };
  }

  /**
   * 生效：全部本人确认 + 冲突复核通过 + 版本一致，单事务写入。
   * 私有：生效是系统的收尾动作，不对外暴露成"某个人点击生效"的权限。
   */
  private applyInternal(changeId: string, actor: string): ApplyResult {
    const record = this.store.getCase(changeId);
    if (!record) {
      return {
        ok: false,
        code: 'CASE_NOT_FOUND',
        applied: [],
        skippedExecuted: [],
        status: null,
        detail: null,
      };
    }
    if (record.status !== 'PENDING_CONFIRMATION') {
      return {
        ok: false,
        code: 'INVALID_STATUS',
        applied: [],
        skippedExecuted: [],
        status: record.status,
        detail: null,
      };
    }

    const items = this.store.itemsOf(changeId, record.revision);
    const required = this.store.requiredOf(changeId, record.revision);
    // 版本互斥优先于确认检查：课表已被他人改动时，整单失效，不得换一套确认人继续。
    for (const item of items) {
      if (this.store.versionOf(item.occurrenceId) !== item.expectedVersion) {
        return {
          ok: false,
          code: 'STALE_VERSION',
          applied: [],
          skippedExecuted: [],
          status: record.status,
          detail: item.occurrenceId,
        };
      }
    }
    const active = this.store.activeAssignments(record.termId);
    const projection = projectChange(active.map(toAssignment), items.map(toChangeItem));
    const blocking = projection.errors.filter((e) => !e.preExisting);
    if (blocking.length > 0) {
      return {
        ok: false,
        code: 'NOT_READY',
        applied: [],
        skippedExecuted: [],
        status: record.status,
        detail: blocking.map((e) => e.code).join(','),
      };
    }

    const status = confirmationState(
      required,
      record.revision,
      this.store.confirmationsOf(changeId).map((c) => ({
        teacherId: c.teacherId,
        revision: c.revision,
        decision: c.decision,
      })),
    );
    if (status.state !== 'READY_TO_APPLY') {
      return {
        ok: false,
        code: 'NOT_READY',
        applied: [],
        skippedExecuted: [],
        status: record.status,
        detail: status.state,
      };
    }

    const at = this.now();
    const applied: string[] = [];
    const skipped: string[] = [];
    const activeById = new Map(active.map((a) => [a.occurrenceId, a]));

    try {
      this.db.transaction(() => {
        for (const item of items) {
          const current = this.store.versionOf(item.occurrenceId);
          if (current !== item.expectedVersion) {
            throw new StaleVersionError(item.occurrenceId);
          }
          if (this.store.isExecuted(item.occurrenceId)) {
            if (record.kind === 'RECOVERY') {
              skipped.push(item.occurrenceId);
              continue;
            }
            throw new ExecutedError(item.occurrenceId);
          }
          const after = projection.after.find(
            (a) => a.occurrenceId === item.occurrenceId,
          );
          const base = activeById.get(item.occurrenceId);
          if (!after || !base) throw new StaleVersionError(item.occurrenceId);
          this.store.writeAssignment(
            {
              occurrenceId: item.occurrenceId,
              termId: record.termId,
              classId: after.classId,
              subjectId: after.subjectId,
              teacherId: after.teacherId,
              date: after.date,
              period: after.period,
              cancelled: after.cancelled,
              version: current + 1,
              changeId,
            },
            at,
          );
          applied.push(item.occurrenceId);
        }

        if (applied.length === 0) throw new NothingToApplyError();

        this.store.insertEffective({
          id: this.newId(),
          changeId,
          revision: record.revision,
          termId: record.termId,
          kind: record.kind,
          appliedBy: actor,
          appliedAt: at,
        });
        this.store.updateStatus(changeId, 'EFFECTIVE', at);
        this.store.insertAudit({
          at,
          actor,
          action: 'APPLY',
          objectType: 'CHANGE_CASE',
          objectId: changeId,
          beforeState: record.status,
          afterState: 'EFFECTIVE',
          reason: skipped.length > 0 ? `skippedExecuted=${skipped.length}` : null,
        });
      });
    } catch (error) {
      if (error instanceof StaleVersionError) {
        return {
          ok: false,
          code: 'STALE_VERSION',
          applied: [],
          skippedExecuted: [],
          status: record.status,
          detail: error.occurrenceId,
        };
      }
      if (error instanceof ExecutedError) {
        return {
          ok: false,
          code: 'EXECUTED_NOT_CHANGEABLE',
          applied: [],
          skippedExecuted: [],
          status: record.status,
          detail: error.occurrenceId,
        };
      }
      if (error instanceof NothingToApplyError) {
        return {
          ok: false,
          code: 'NOTHING_TO_APPLY',
          applied: [],
          skippedExecuted: skipped,
          status: record.status,
          detail: null,
        };
      }
      throw error;
    }

    return {
      ok: true,
      code: 'APPLIED',
      applied,
      skippedExecuted: skipped,
      status: 'EFFECTIVE',
      detail: null,
    };
  }

  /** 已生效变更不可删除；取消必须新建恢复方案。 */
  deleteChange(): never {
    throw new Error('METHOD_NOT_ALLOWED: 已生效变更不可删除，请新建恢复方案');
  }

  /** 新建恢复方案：指向原方案，只对未执行课次生效；发起人必须在受影响范围内。 */
  createRecovery(
    sourceChangeId: string,
    input: Omit<SubmitInput, 'termId'>,
  ): ChangeSummary {
    this.assertCan(input.principal, 'CREATE_OWN_CHANGE');
    const source = this.store.getCase(sourceChangeId);
    if (!source || source.status !== 'EFFECTIVE') {
      return emptySummary('INVALID_STATUS', sourceChangeId);
    }
    if (input.items.length === 0) return emptySummary('NO_ITEMS', sourceChangeId);

    const at = this.now();
    const caseId = this.newId();
    const before = this.store.activeAssignments(source.termId);
    this.assertOwnsAffected(input.principal, input.items, before);
    const submittedBy = this.requireTeacher(input.principal);
    const projection = projectChange(
      before.map(toAssignment),
      input.items,
      input.classHeadByClass ?? {},
    );

    this.db.transaction(() => {
      this.store.insertCase({
        id: caseId,
        termId: source.termId,
        kind: 'RECOVERY',
        parentChangeId: sourceChangeId,
        status: 'DRAFT',
        revision: 1,
        submittedBy,
        reason: input.reason,
        idempotencyKey: normalizeKey(input.idempotencyKey),
        createdAt: at,
        updatedAt: at,
      });
      const versionById = new Map(before.map((a) => [a.occurrenceId, a.version]));
      this.store.replaceItems(
        caseId,
        1,
        input.items.map((item) => ({
          occurrenceId: item.occurrenceId,
          kind: item.kind,
          toTeacherId: item.toTeacherId,
          toDate: item.toDate,
          toPeriod: item.toPeriod,
          expectedVersion: versionById.get(item.occurrenceId) ?? 0,
        })),
      );
      this.store.insertAudit({
        at,
        actor: submittedBy,
        action: 'CREATE_RECOVERY',
        objectType: 'CHANGE_CASE',
        objectId: caseId,
        beforeState: sourceChangeId,
        afterState: 'DRAFT',
        reason: input.reason === null ? null : 'REASON_PROVIDED',
      });
    });

    return {
      ok: projection.errors.length === 0,
      code: 'CREATED',
      caseId,
      revision: 1,
      status: 'DRAFT',
      required: projection.required,
      notified: projection.notified,
      notifiedUnknownClasses: projection.notifiedUnknownClasses,
      conflicts: projection.errors,
      duplicate: false,
    };
  }

  getCase(id: string): ChangeCaseRecord | null {
    return this.store.getCase(id);
  }

  /** 组织展示视图。`viewerTeacherId` 决定 reason 是否可见；管理员也不看他人理由。 */
  private toView(record: ChangeCaseRecord, viewerTeacherId: string | null): ChangeCaseView {
    const items = this.store.itemsOf(record.id, record.revision);
    const required = this.store.requiredOf(record.id, record.revision);
    const confirmations = this.store.confirmationsOf(record.id);
    const described = new Map(
      this.store.describeOccurrences(items.map((i) => i.occurrenceId)).map((d) => [d.occurrenceId, d]),
    );

    const names = this.store.teacherNames(
      [
        record.submittedBy,
        ...required,
        ...confirmations.map((c) => c.teacherId),
        ...items.map((i) => i.toTeacherId ?? ''),
      ].filter((id) => id !== ''),
    );

    const isMine = viewerTeacherId !== null && record.submittedBy === viewerTeacherId;
    const awaitingMe =
      viewerTeacherId !== null &&
      record.status === 'PENDING_CONFIRMATION' &&
      required.includes(viewerTeacherId) &&
      !confirmations.some((c) => c.teacherId === viewerTeacherId && c.revision === record.revision);

    return {
      caseId: record.id,
      kind: record.kind,
      status: record.status,
      revision: record.revision,
      termId: record.termId,
      submittedBy: record.submittedBy,
      submittedByName: names[record.submittedBy] ?? null,
      isMine,
      reason: isMine ? record.reason : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      items: items.map((item) => {
        const cur = described.get(item.occurrenceId) ?? null;
        return {
          occurrenceId: item.occurrenceId,
          kind: item.kind,
          toTeacherId: item.toTeacherId,
          toTeacherName: item.toTeacherId === null ? null : (names[item.toTeacherId] ?? null),
          toDate: item.toDate,
          toPeriod: item.toPeriod,
          current:
            cur === null
              ? null
              : {
                  classId: cur.classId,
                  className: cur.className,
                  subjectName: cur.subjectName,
                  teacherId: cur.teacherId,
                  teacherName: cur.teacherName,
                  date: cur.date,
                  period: cur.period,
                  cancelled: cur.cancelled,
                },
        };
      }),
      required,
      requiredNames: names,
      confirmations: confirmations.map((c) => ({
        teacherId: c.teacherId,
        teacherName: names[c.teacherId] ?? null,
        revision: c.revision,
        decision: c.decision,
        recordedAt: c.recordedAt,
      })),
      awaitingMe,
      canWithdraw: isMine && canTransition(record.status, 'WITHDRAWN'),
    };
  }

  /** 我发起的 + 等我确认的。没有教师身份时两项均为空，不返回全校数据。 */
  listMine(principal: Principal): { submitted: ChangeCaseView[]; awaiting: ChangeCaseView[] } {
    const me = principal.teacherId;
    if (!me || principal.mustChangePassword) return { submitted: [], awaiting: [] };
    return {
      submitted: this.store.listBySubmitter(me).map((r) => this.toView(r, me)),
      awaiting: this.store.listAwaitingConfirmation(me).map((r) => this.toView(r, me)),
    };
  }

  /**
   * 查看单个方案。
   * 可见范围：发起人、被要求确认者、曾就该方案表态者、以及具备全校审计权者。
   * 理由字段只对发起人开放——权限矩阵中"查看他人私人理由"没有任何授权角色。
   */
  detail(principal: Principal, changeId: string): ChangeCaseDetail {
    if (principal.mustChangePassword) return { ok: false, code: 'FORBIDDEN', case: null };
    const record = this.store.getCase(changeId);
    if (!record) return { ok: false, code: 'CASE_NOT_FOUND', case: null };
    const me = principal.teacherId;
    const participates =
      me !== null &&
      (record.submittedBy === me ||
        this.store.requiredOf(record.id, record.revision).includes(me) ||
        this.store.confirmationsOf(record.id).some((c) => c.teacherId === me));
    const schoolAudit = can(principal, 'VIEW_SCHOOL_AUDIT').allowed;
    if (!participates && !schoolAudit) return { ok: false, code: 'FORBIDDEN', case: null };
    return { ok: true, code: 'FOUND', case: this.toView(record, me) };
  }

  activeAssignments(termId: string, from?: string, to?: string): ActiveAssignment[] {
    return this.store.activeAssignments(termId, from, to);
  }

  notifications(changeId: string): Array<{ recipientId: string; kind: string; delivery: string }> {
    return this.store.notificationsOf(changeId);
  }

  audit(changeId: string): Array<{
    at: string;
    actor: string;
    action: string;
    beforeState: string | null;
    afterState: string | null;
  }> {
    return this.store.auditOf(changeId);
  }

  /**
   * 录入执行事实：BIZ-03 未定，权限矩阵中 S/R 均为 TBD_BLOCKED，因此没有任何角色可以调用。
   * 保留这个方法是为了让"调用会被拒绝"可被测试，而不是留一个后门。
   * 测试若需要构造"已执行"事实，只能直接写表，并明确标注这是 P6 之前的占位。
   */
  recordExecution(_principal: Principal, _occurrenceId: string, _executed: boolean): never {
    throw new PolicyDeniedError('ROLE_NOT_ASSIGNED', 'RECORD_EXECUTION_FACT');
  }
}
