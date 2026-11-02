/**
 * 只读的"系统状态"与"我的可用操作"视图。
 *
 * 这里只聚合事实，不产生任何业务判定：
 *  - 能力表直接读 `POLICY`，不在界面里另写一份"管理员能干什么"。
 *  - 审计链状态来自 `AuditLog.verify()`，不是"看起来正常"。
 *  - 数据来源分项统计，避免把模拟数据与正式数据混成一个总数。
 */

import type { DeploymentMode } from '../domain/model.js';
import type { Principal } from '../auth/principal.js';
import { ALL_ACTIONS, ACTION_LABEL, can } from '../auth/policy.js';
import type { ChangeStore } from '../store/change-store.js';
import { ChangeStore as ChangeStoreImpl } from '../store/change-store.js';
import type { CourseDatabase } from '../store/database.js';
import { EmergencyStore } from '../store/emergency-store.js';
import type { AuditViewRow } from '../store/audit-log.js';

export interface CapabilityView {
  readonly action: string;
  readonly label: string;
  readonly verdict: 'ALLOWED' | 'FORBIDDEN' | 'ROLE_NOT_ASSIGNED';
}

export interface MetaView {
  readonly ok: true;
  readonly serverTime: string;
  readonly schemaVersion: string | null;
  /** 库的环境；null 表示尚未设定（此时服务应拒绝启动，界面不会走到这里） */
  readonly deploymentMode: DeploymentMode | null;
  readonly terms: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly startMonday: string;
    readonly endDate: string;
    readonly dataOrigin: string;
  }>;
  readonly capabilities: readonly CapabilityView[];
}

export interface SchoolStatusView {
  readonly ok: true;
  readonly serverTime: string;
  readonly schemaVersion: string | null;
  readonly audit: {
    readonly ok: boolean;
    readonly length: number;
    readonly lastHash: string | null;
    readonly brokenAt: number | null;
    readonly reason: string | null;
  };
  readonly counts: {
    readonly teachers: number;
    readonly classes: number;
    readonly subjects: number;
    readonly occurrences: number;
    readonly changeCases: number;
    readonly effectiveChanges: number;
    readonly emergencyRequests: number;
    readonly accounts: number;
  };
  readonly origins: {
    readonly simulated: number;
    readonly importedUnverified: number;
    readonly official: number;
  };
  readonly capabilities: readonly CapabilityView[];
}

export class StatusService {
  private readonly changes: ChangeStore;

  constructor(
    private readonly db: CourseDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.changes = new ChangeStoreImpl(db.handle);
  }

  meta(principal: Principal): MetaView {
    return {
      ok: true,
      serverTime: this.now(),
      schemaVersion: this.db.getMeta('schema_version'),
      deploymentMode: this.db.deploymentMode(),
      terms: this.db.listTerms().map((t) => ({
        id: t.id,
        label: t.label,
        startMonday: t.startMonday,
        endDate: t.endDate,
        dataOrigin: t.dataOrigin,
      })),
      capabilities: this.capabilities(principal),
    };
  }

  private capabilities(principal: Principal): CapabilityView[] {
    return ALL_ACTIONS.map((action) => {
      const decision = can(principal, action);
      return { action, label: ACTION_LABEL[action], verdict: decision.code };
    });
  }

  /** 全校状态：需要"查看全校审计"权限（S / A），教师不可见。 */
  school(principal: Principal): SchoolStatusView | null {
    const allowed = can(principal, 'VIEW_SCHOOL_AUDIT').allowed;
    if (!allowed) return null;
    const chain = this.db.auditLog.verify();
    const terms = this.db.listTerms();
    const termId = terms[0]?.id ?? null;
    const stats = termId === null
      ? { total: 0, simulated: 0, importedUnverified: 0, official: 0 }
      : this.db.occurrenceStats(termId);
    const refs = this.db.refs();
    return {
      ok: true,
      serverTime: this.now(),
      schemaVersion: this.db.getMeta('schema_version'),
      audit: {
        ok: chain.ok,
        length: chain.length,
        lastHash: chain.lastHash,
        brokenAt: chain.brokenAt,
        reason: chain.reason,
      },
      counts: {
        teachers: refs.teachers.length,
        classes: refs.classes.length,
        subjects: refs.subjects.length,
        occurrences: stats.total,
        changeCases: this.db.countChangeCases(),
        effectiveChanges: this.changes.countEffective(),
        emergencyRequests: this.db.countEmergencyRequests(),
        accounts: this.db.countAccounts(),
      },
      origins: {
        simulated: stats.simulated,
        importedUnverified: stats.importedUnverified,
        official: stats.official,
      },
      capabilities: this.capabilities(principal),
    };
  }

  /**
   * 本人相关审计：我是操作者，或对象是我参与过的单据。
   * 管理员要看全校请走 `schoolAudit`，两者不合并，避免"顺手看全部"。
   */
  auditForSelf(principal: Principal): readonly AuditViewRow[] {
    const me = principal.teacherId;
    const objectIds: string[] = [...this.changes.caseIdsTouching(me ?? '')];
    if (me !== null) {
      const requests = new EmergencyStore(this.db.handle, this.db.auditLog).listByRequester(me, 200);
      objectIds.push(...requests.map((r) => r.id));
    }
    const actors = [principal.userId, me ?? ''].filter((id) => id !== '');
    return this.db.auditLog.related({ actors, objectIds, limit: 200 });
  }

  /** 全校审计：仅 VIEW_SCHOOL_AUDIT。 */
  schoolAudit(principal: Principal, limit: number): readonly AuditViewRow[] | null {
    if (!can(principal, 'VIEW_SCHOOL_AUDIT').allowed) return null;
    return this.db.auditLog.recent(limit);
  }
}
