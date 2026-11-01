import { createHash } from 'node:crypto';
import type { Principal } from '../auth/principal.js';
import { can } from '../auth/policy.js';
import type { DataOrigin } from '../domain/model.js';
import type { ImportBatchRecord, CourseDatabase } from '../store/database.js';
import { applyMapping, proposeMapping } from './mapping.js';
import { parseTimetableFile, selectParser } from './registry.js';
import type { DiffReport, Mapping, MappingProposal, RowIssue, ValidatedRow } from './types.js';
import { validateRows } from './validate.js';

export interface UploadRequest {
  readonly batchId: string;
  readonly termId: string;
  readonly fileName: string;
  readonly buffer: Buffer;
  /** 上传人身份来自会话，不接受调用方声明 */
  readonly principal: Principal;
  readonly uploadedAt: string;
  /** 已确认的字段映射；未提供时只返回建议，不落库 */
  readonly mapping?: Mapping;
}

export type UploadResult =
  | {
      readonly status: 'IMPORTED_NOT_PUBLISHED';
      readonly batchId: string;
      readonly rowCount: number;
      readonly diff: DiffReport;
    }
  | {
      readonly status: 'REJECTED';
      readonly batchId: string;
      readonly code: string;
      readonly message: string;
      readonly issues: readonly RowIssue[];
    }
  | { readonly status: 'NEEDS_MAPPING'; readonly proposal: MappingProposal }
  | { readonly status: 'SIMULATED_REMAINS'; readonly code: 'SIMULATED_REMAINS'; readonly message: string }
  | { readonly status: 'UNKNOWN_TERM'; readonly code: 'UNKNOWN_TERM'; readonly message: string };

export type PublishFailure =
  | 'BATCH_NOT_FOUND'
  | 'BAD_STATUS'
  | 'NOT_CONFIGURED'
  | 'AMBIGUOUS_ROLE'
  | 'NOT_AUTHORIZED'
  | 'CONFLICT_REQUIRES_ACK'
  | 'DUPLICATE_SLOT'
  | 'SIMULATED_REMAINS';

export type PublishResult =
  | {
      readonly ok: true;
      readonly status: 'PUBLISHED';
      readonly wrote: boolean;
      readonly diff: DiffReport;
    }
  | {
      readonly ok: false;
      readonly code: PublishFailure;
      readonly message: string;
      readonly conflicts?: readonly string[];
    };

export type RevokeResult =
  | {
      readonly ok: true;
      readonly status: 'REVOKED';
      readonly tombstonedTemplateIds: readonly string[];
      readonly markers: number;
    }
  | { readonly ok: false; readonly code: PublishFailure; readonly message: string };

export interface PublishOptions {
  readonly principal: Principal;
  /**
   * 学校配置的"可发布角色"。空数组 = 尚未配置，发布一律阻断。
   * 代码不内置任何角色，避免开发方替学校决定谁有权发布。
   * 当前只可能配置为 S（课务管理人员）；其他角色在权限矩阵中为 DENY。
   */
  readonly authorizedRoles: readonly string[];
  /**
   * 校方同意开启发布的书面依据编号。未登记时一律阻断——
   * "发布岗位未证实（AC01）"不能用一次参数调用就解除。
   */
  readonly basisDocumentId: string;
  /** 'REPLACE' 会先给本期现有模板打墓碑；必须显式确认 */
  readonly mode: 'APPEND' | 'REPLACE';
  readonly acknowledged?: boolean;
  readonly at: string;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function keyOf(r: {
  teacherId: string;
  classId: string;
  subjectId: string;
  weekday: number;
  period: number;
  parity: string;
  validFrom: string | null;
  validTo: string | null;
}): string {
  return [
    r.classId,
    r.teacherId,
    r.subjectId,
    r.weekday,
    r.period,
    r.parity,
    r.validFrom ?? '-',
    r.validTo ?? '-',
  ].join('|');
}

export function diffAgainst(
  batchRows: readonly ValidatedRow[],
  existing: readonly {
    teacherId: string;
    classId: string;
    subjectId: string;
    weekday: number;
    period: number;
    parity: string;
    validFrom: string | null;
    validTo: string | null;
  }[],
): DiffReport {
  const existingKeys = new Set(existing.map(keyOf));
  const batchKeys = new Set(batchRows.map(keyOf));

  const addedKeys = [...batchKeys].filter((k) => !existingKeys.has(k)).sort();
  const removedKeys = [...existingKeys].filter((k) => !batchKeys.has(k)).sort();
  const unchanged = [...batchKeys].filter((k) => existingKeys.has(k)).length;

  return { added: addedKeys.length, removed: removedKeys.length, unchanged, addedKeys, removedKeys };
}

export class ImportPipeline {
  constructor(private readonly db: CourseDatabase) {}

  previewMapping(fileName: string, buffer: Buffer): MappingProposal | { error: string } {
    const parsed = parseTimetableFile(fileName, buffer);
    if (!parsed.ok) return { error: `${parsed.code}:${parsed.message}` };
    return proposeMapping(parsed.table.headers);
  }

  diffOf(batchId: string, termId: string): DiffReport {
    return diffAgainst(this.db.rowsOfBatch(batchId), this.db.activeTemplates(termId));
  }

  /**
   * 上传并校验。全程不写"正式数据"：
   * 校验通过只产生批次与暂存行，模板表一条不动。
   */
  upload(req: UploadRequest): UploadResult {
    // 导入权限只属于课务管理人员；不依赖前端隐藏入口。
    const decision = can(req.principal, 'IMPORT_TIMETABLE');
    if (!decision.allowed) {
      return {
        status: 'REJECTED',
        batchId: req.batchId,
        code: decision.code === 'ROLE_NOT_ASSIGNED' ? 'ROLE_NOT_ASSIGNED' : 'FORBIDDEN',
        message: '当前身份无权导入课表',
        issues: [],
      };
    }
    if (!this.db.getTerm(req.termId)) {
      return { status: 'UNKNOWN_TERM', code: 'UNKNOWN_TERM', message: `学期 ${req.termId} 不存在` };
    }
    if (this.db.hasSimulated(req.termId)) {
      // CFG-08：模拟数据与真实导入不得混存
      return {
        status: 'SIMULATED_REMAINS',
        code: 'SIMULATED_REMAINS',
        message: '本学期仍存在模拟数据，请先显式清除后才能导入',
      };
    }

    const parsed = parseTimetableFile(req.fileName, req.buffer);
    if (!parsed.ok) {
      this.recordRejectedBatch(req, `${parsed.code}:${parsed.message}`, []);
      return {
        status: 'REJECTED',
        batchId: req.batchId,
        code: parsed.code,
        message: parsed.message,
        issues: [],
      };
    }

    const proposal = proposeMapping(parsed.table.headers);
    if (!req.mapping) {
      return { status: 'NEEDS_MAPPING', proposal };
    }

    const mapped = applyMapping(parsed.table, req.mapping);
    const report = validateRows(mapped, {
      teachers: () => this.db.refs().teachers,
      classes: () => this.db.refs().classes,
      subjects: () => this.db.refs().subjects,
    });

    if (!report.ok) {
      this.recordRejectedBatch(req, '校验未通过，整批拒绝', report.issues);
      return {
        status: 'REJECTED',
        batchId: req.batchId,
        code: 'VALIDATION_FAILED',
        message: '校验未通过，整批拒绝；正式数据未改动',
        issues: report.issues,
      };
    }

    const parser = selectParser(req.fileName)!;
    const batch: ImportBatchRecord = {
      id: req.batchId,
      termId: req.termId,
      fileName: req.fileName,
      fileSha256: sha256(req.buffer),
      parser: parser.name,
      rowCount: report.rows.length,
      status: 'IMPORTED_NOT_PUBLISHED',
      dataOrigin: 'IMPORTED_UNVERIFIED',
      uploadedAt: req.uploadedAt,
      uploadedBy: req.principal.userId,
      publishedAt: null,
      publishedBy: null,
      publishMode: null,
      rejectedNote: null,
    };

    this.db.execTransaction(() => {
      this.db.createBatch(batch);
      this.db.insertRows(req.batchId, report.rows);
      this.db.auditLog.append({
        at: req.uploadedAt,
        actor: req.principal.userId,
        action: 'IMPORT_UPLOAD',
        objectType: 'IMPORT_BATCH',
        objectId: req.batchId,
        afterState: 'IMPORTED_NOT_PUBLISHED',
        reason: `rows=${report.rows.length}`,
      });
    });

    return {
      status: 'IMPORTED_NOT_PUBLISHED',
      batchId: req.batchId,
      rowCount: report.rows.length,
      diff: this.diffOf(req.batchId, req.termId),
    };
  }

  private recordRejectedBatch(req: UploadRequest, note: string, issues: readonly RowIssue[]): void {
    if (this.db.getBatch(req.batchId)) return;
    const parser = selectParser(req.fileName);
    this.db.createBatch({
      id: req.batchId,
      termId: req.termId,
      fileName: req.fileName,
      fileSha256: sha256(req.buffer),
      parser: parser?.name ?? 'none',
      rowCount: 0,
      status: 'REJECTED',
      dataOrigin: 'IMPORTED_UNVERIFIED',
      uploadedAt: req.uploadedAt,
      uploadedBy: req.principal.userId,
      publishedAt: null,
      publishedBy: null,
      publishMode: null,
      rejectedNote: issues.length > 0 ? `${note}（${issues.length} 条问题）` : note,
    });
  }

  publish(batchId: string, opts: PublishOptions): PublishResult {
    const batch = this.db.getBatch(batchId);
    if (!batch) {
      return { ok: false, code: 'BATCH_NOT_FOUND', message: '批次不存在' };
    }
    if (batch.status !== 'IMPORTED_NOT_PUBLISHED') {
      return {
        ok: false,
        code: 'BAD_STATUS',
        message: `批次状态为 ${batch.status}，不能发布`,
      };
    }
    if (opts.authorizedRoles.length === 0) {
      return {
        ok: false,
        code: 'NOT_CONFIGURED',
        message: '尚未配置"可发布角色"，发布被阻断；请在设置中由校方指定',
      };
    }
    if (opts.basisDocumentId.trim() === '') {
      return {
        ok: false,
        code: 'NOT_CONFIGURED',
        message: '发布岗位尚未由校方书面确认；登记依据编号后才能开启',
      };
    }
    if (opts.authorizedRoles.some((role) => role !== 'S')) {
      return {
        ok: false,
        code: 'NOT_CONFIGURED',
        message: '发布职责只能配置给课务管理人员（S）；其他角色在权限矩阵中为禁止',
      };
    }
    const { principal } = opts;
    const effectiveRole = principal.actingRole;
    if (!opts.authorizedRoles.includes(effectiveRole)) {
      return { ok: false, code: 'NOT_AUTHORIZED', message: `角色 ${effectiveRole} 无发布权限` };
    }
    if (this.db.hasSimulated(batch.termId)) {
      return { ok: false, code: 'SIMULATED_REMAINS', message: '本学期仍存在模拟数据，禁止发布' };
    }

    const rows = this.db.rowsOfBatch(batchId);
    const existing = this.db.activeTemplates(batch.termId);
    const diff = diffAgainst(rows, existing);

    // 幂等：同一文件再次发布，净变化为 0 时不动任何模板
    if (diff.added === 0 && diff.removed === 0) {
      this.db.execTransaction(() => {
        this.db.updateBatch(batchId, {
          status: 'PUBLISHED',
          publishedAt: opts.at,
          publishedBy: principal.userId,
          publishMode: opts.mode,
        });
        this.db.auditLog.append({
          at: opts.at,
          actor: principal.userId,
          action: 'PUBLISH_BATCH',
          objectType: 'IMPORT_BATCH',
          objectId: batchId,
          beforeState: 'IMPORTED_NOT_PUBLISHED',
          afterState: 'PUBLISHED',
          reason: `basis=${opts.basisDocumentId};wrote=false`,
        });
      });
      return { ok: true, status: 'PUBLISHED', wrote: false, diff };
    }

    if (opts.mode === 'APPEND') {
      const slotDup = rows.filter((r) =>
        existing.some(
          (e) =>
            e.classId === r.classId &&
            e.weekday === r.weekday &&
            e.period === r.period &&
            (e.parity === r.parity || e.parity === 'ALL' || r.parity === 'ALL'),
        ),
      );
      if (slotDup.length > 0) {
        return {
          ok: false,
          code: 'DUPLICATE_SLOT',
          message: '追加模式下与现有课表存在同班同时段冲突，请改用覆盖模式或先清理',
          conflicts: slotDup.map(keyOf),
        };
      }
    }

    if (opts.mode === 'REPLACE' && existing.length > 0 && opts.acknowledged !== true) {
      return {
        ok: false,
        code: 'CONFLICT_REQUIRES_ACK',
        message: `覆盖模式将停用本学期现有 ${existing.length} 条排课，需要显式确认`,
        conflicts: existing.map((e) => e.id),
      };
    }

    this.db.execTransaction(() => {
      if (opts.mode === 'REPLACE') {
        this.db.tombstoneTermTemplates(batch.termId, opts.at);
      }
      this.db.insertTemplates(batchId, batch.termId, rows, 'OFFICIAL' satisfies DataOrigin);
      this.db.updateBatch(batchId, {
        status: 'PUBLISHED',
        publishedAt: opts.at,
        publishedBy: principal.userId,
        publishMode: opts.mode,
      });
      this.db.auditLog.append({
        at: opts.at,
        actor: principal.userId,
        action: 'PUBLISH_BATCH',
        objectType: 'IMPORT_BATCH',
        objectId: batchId,
        beforeState: 'IMPORTED_NOT_PUBLISHED',
        afterState: 'PUBLISHED',
        reason: `basis=${opts.basisDocumentId};wrote=true;added=${diff.added};removed=${diff.removed}`,
      });
    });

    return { ok: true, status: 'PUBLISHED', wrote: true, diff };
  }

  /** 撤销批次：不删除任何已生效数据，只打墓碑并留标记 */
  revoke(batchId: string, opts: { at: string; reason: string; principal: Principal }): RevokeResult {
    const decision = can(opts.principal, 'IMPORT_TIMETABLE');
    if (!decision.allowed) {
      return { ok: false, code: 'NOT_AUTHORIZED', message: '当前身份无权撤销批次' };
    }
    const batch = this.db.getBatch(batchId);
    if (!batch) return { ok: false, code: 'BATCH_NOT_FOUND', message: '批次不存在' };
    if (batch.status !== 'PUBLISHED') {
      return { ok: false, code: 'BAD_STATUS', message: `批次状态为 ${batch.status}，不能撤销` };
    }

    const tombstoned: string[] = [];
    this.db.execTransaction(() => {
      const ids = this.db.tombstoneBatchTemplates(batchId, opts.at);
      tombstoned.push(...ids);
      for (const id of ids) {
        this.db.addRevocationMarker({
          id: `RM-${batchId}-${id}`,
          batchId,
          templateId: id,
          reason: opts.reason,
          createdAt: opts.at,
        });
      }
      this.db.updateBatch(batchId, { status: 'REVOKED' });
      this.db.auditLog.append({
        at: opts.at,
        actor: opts.principal.userId,
        action: 'REVOKE_BATCH',
        objectType: 'IMPORT_BATCH',
        objectId: batchId,
        beforeState: 'PUBLISHED',
        afterState: 'REVOKED',
        reason: `tombstoned=${tombstoned.length}`,
      });
    });

    return {
      ok: true,
      status: 'REVOKED',
      tombstonedTemplateIds: tombstoned,
      markers: this.db.countRevocationMarkers(batchId),
    };
  }

  batches(termId: string): ImportBatchRecord[] {
    return this.db.listBatches(termId);
  }

  /** 课表是否已被学校正式发布过（供查询页展示"未正式生效"） */
  publicationState(termId: string): {
    published: boolean;
    lastPublishedBatchId: string | null;
    pendingBatchIds: readonly string[];
  } {
    const list = this.db.listBatches(termId);
    const published = list.filter((b) => b.status === 'PUBLISHED');
    return {
      published: published.length > 0,
      lastPublishedBatchId: published.at(-1)?.id ?? null,
      pendingBatchIds: list.filter((b) => b.status === 'IMPORTED_NOT_PUBLISHED').map((b) => b.id),
    };
  }
}
