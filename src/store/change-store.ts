/**
 * P4 变更协商的存储层。只做读写，不做业务判定。
 * 所有字段逐一手工映射，禁止用 `as` 把 snake_case 行直接当驼峰对象（P3 已因此出过假通过）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { AuditLog } from './audit-log.js';
import type { CaseStatus, ChangeItemKind } from '../domain/change.js';

export interface ChangeCaseRecord {
  readonly id: string;
  readonly termId: string;
  readonly kind: 'CHANGE' | 'RECOVERY';
  readonly parentChangeId: string | null;
  readonly status: CaseStatus;
  readonly revision: number;
  readonly submittedBy: string;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredItem {
  readonly occurrenceId: string;
  readonly kind: ChangeItemKind;
  readonly toTeacherId: string | null;
  readonly toDate: string | null;
  readonly toPeriod: number | null;
  readonly expectedVersion: number;
}

export interface StoredConfirmation {
  readonly teacherId: string;
  readonly revision: number;
  readonly decision: 'ACCEPT' | 'DECLINE';
  readonly recordedAt: string;
}

export interface ActiveAssignment {
  readonly occurrenceId: string;
  readonly classId: string;
  readonly subjectId: string;
  readonly teacherId: string;
  readonly date: string;
  readonly period: number;
  readonly cancelled: boolean;
  readonly version: number;
}

interface CaseRow {
  id: string;
  term_id: string;
  kind: string;
  parent_change_id: string | null;
  status: string;
  revision: number;
  submitted_by: string;
  reason: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  occurrence_id: string;
  kind: string;
  to_teacher_id: string | null;
  to_date: string | null;
  to_period: number | null;
  expected_version: number;
}

interface ConfirmationRow {
  teacher_id: string;
  revision: number;
  decision: string;
  recorded_at: string;
}

interface ActiveRow {
  occurrence_id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  date: string;
  period: number;
  cancelled: number;
  version: number;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(Math.trunc(limit), 200));
}

function mapCase(row: CaseRow): ChangeCaseRecord {
  return {
    id: row.id,
    termId: row.term_id,
    kind: row.kind === 'RECOVERY' ? 'RECOVERY' : 'CHANGE',
    parentChangeId: row.parent_change_id,
    status: row.status as CaseStatus,
    revision: row.revision,
    submittedBy: row.submitted_by,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: ItemRow): StoredItem {
  return {
    occurrenceId: row.occurrence_id,
    kind: row.kind as ChangeItemKind,
    toTeacherId: row.to_teacher_id,
    toDate: row.to_date,
    toPeriod: row.to_period,
    expectedVersion: row.expected_version,
  };
}

export class ChangeStore {
  private readonly auditLog: AuditLog;

  constructor(private readonly db: DatabaseSync) {
    this.auditLog = new AuditLog(db);
  }

  insertCase(record: ChangeCaseRecord): void {
    this.db
      .prepare(
        `INSERT INTO change_case(id, term_id, kind, parent_change_id, status, revision, submitted_by, reason, idempotency_key, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.termId,
        record.kind,
        record.parentChangeId,
        record.status,
        record.revision,
        record.submittedBy,
        record.reason,
        record.idempotencyKey,
        record.createdAt,
        record.updatedAt,
      );
  }

  getCase(id: string): ChangeCaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM change_case WHERE id = ?')
      .get(id) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  findByKey(key: string): ChangeCaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM change_case WHERE idempotency_key = ?')
      .get(key) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  /** 我发起的方案，最近更新的在前。 */
  listBySubmitter(submittedBy: string, limit = 50): ChangeCaseRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM change_case WHERE submitted_by = ?
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(submittedBy, clampLimit(limit)) as unknown as CaseRow[];
    return rows.map(mapCase);
  }

  /**
   * 等我确认的方案：状态为待确认、当前版本把我列为必要确认者、且我尚未就当前版本表态。
   * 之前的版本上表过态不算——版本一变就要重新确认（AC06）。
   */
  listAwaitingConfirmation(teacherId: string, limit = 50): ChangeCaseRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM change_case c
           JOIN change_required r ON r.change_id = c.id AND r.revision = c.revision
          WHERE r.teacher_id = ?
            AND c.status = 'PENDING_CONFIRMATION'
            AND NOT EXISTS (
              SELECT 1 FROM change_confirmation f
               WHERE f.change_id = c.id AND f.teacher_id = ? AND f.revision = c.revision
            )
          ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(teacherId, teacherId, clampLimit(limit)) as unknown as CaseRow[];
    return rows.map(mapCase);
  }

  /** 我参与过的方案（发起或曾作为确认者），用于"我的审计"取对象集合。 */
  caseIdsTouching(teacherId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id FROM change_case c
            LEFT JOIN change_required r ON r.change_id = c.id
            LEFT JOIN change_confirmation f2 ON f2.change_id = c.id
          WHERE c.submitted_by = ? OR r.teacher_id = ? OR f2.teacher_id = ?`,
      )
      .all(teacherId, teacherId, teacherId) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  updateStatus(id: string, status: CaseStatus, at: string): void {
    this.db
      .prepare('UPDATE change_case SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, at, id);
  }

  bumpRevision(id: string, at: string): number {
    this.db
      .prepare('UPDATE change_case SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(at, id);
    const row = this.db
      .prepare('SELECT revision FROM change_case WHERE id = ?')
      .get(id) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  replaceItems(changeId: string, revision: number, items: readonly StoredItem[]): void {
    this.db
      .prepare('DELETE FROM change_item WHERE change_id = ? AND revision = ?')
      .run(changeId, revision);
    const insert = this.db.prepare(
      `INSERT INTO change_item(change_id, revision, occurrence_id, kind, to_teacher_id, to_date, to_period, expected_version)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const item of items) {
      insert.run(
        changeId,
        revision,
        item.occurrenceId,
        item.kind,
        item.toTeacherId,
        item.toDate,
        item.toPeriod,
        item.expectedVersion,
      );
    }
  }

  itemsOf(changeId: string, revision: number): StoredItem[] {
    const rows = this.db
      .prepare(
        `SELECT occurrence_id, kind, to_teacher_id, to_date, to_period, expected_version
           FROM change_item WHERE change_id = ? AND revision = ? ORDER BY occurrence_id`,
      )
      .all(changeId, revision) as unknown as ItemRow[];
    return rows.map(mapItem);
  }

  upsertConfirmation(
    changeId: string,
    teacherId: string,
    revision: number,
    decision: 'ACCEPT' | 'DECLINE',
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO change_confirmation(change_id, teacher_id, revision, decision, recorded_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(change_id, teacher_id, revision) DO UPDATE SET decision = excluded.decision, recorded_at = excluded.recorded_at`,
      )
      .run(changeId, teacherId, revision, decision, at);
  }

  /** 提交时固化必要确认者；同一版本重写。 */
  replaceRequired(
    changeId: string,
    revision: number,
    teacherIds: readonly string[],
  ): void {
    this.db
      .prepare('DELETE FROM change_required WHERE change_id = ? AND revision = ?')
      .run(changeId, revision);
    const insert = this.db.prepare(
      'INSERT INTO change_required(change_id, revision, teacher_id) VALUES(?,?,?)',
    );
    for (const id of teacherIds) insert.run(changeId, revision, id);
  }

  requiredOf(changeId: string, revision: number): string[] {
    const rows = this.db
      .prepare(
        'SELECT teacher_id FROM change_required WHERE change_id = ? AND revision = ? ORDER BY teacher_id',
      )
      .all(changeId, revision) as unknown as Array<{ teacher_id: string }>;
    return rows.map((r) => r.teacher_id);
  }

  confirmationsOf(changeId: string): StoredConfirmation[] {    const rows = this.db
      .prepare(
        'SELECT teacher_id, revision, decision, recorded_at FROM change_confirmation WHERE change_id = ? ORDER BY teacher_id, revision',
      )
      .all(changeId) as unknown as ConfirmationRow[];
    return rows.map((r) => ({
      teacherId: r.teacher_id,
      revision: r.revision,
      decision: r.decision === 'DECLINE' ? 'DECLINE' : 'ACCEPT',
      recordedAt: r.recorded_at,
    }));
  }

  /** 当前有效归属：派生课次叠加已生效变更。 */
  activeAssignments(termId: string, from?: string, to?: string): ActiveAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT o.id AS occurrence_id, o.class_id, o.subject_id,
                COALESCE(s.teacher_id, o.teacher_id) AS teacher_id,
                COALESCE(s.date, o.date) AS date,
                COALESCE(s.period, o.period) AS period,
                COALESCE(s.cancelled, 0) AS cancelled,
                COALESCE(s.version, 0) AS version
           FROM occurrence o
           LEFT JOIN assignment_state s ON s.occurrence_id = o.id
          WHERE o.term_id = ?
            AND (? IS NULL OR COALESCE(s.date, o.date) >= ?)
            AND (? IS NULL OR COALESCE(s.date, o.date) <= ?)
          ORDER BY o.id`,
      )
      .all(termId, from ?? null, from ?? null, to ?? null, to ?? null) as unknown as ActiveRow[];
    return rows.map((r) => ({
      occurrenceId: r.occurrence_id,
      classId: r.class_id,
      subjectId: r.subject_id,
      teacherId: r.teacher_id,
      date: r.date,
      period: r.period,
      cancelled: r.cancelled === 1,
      version: r.version,
    }));
  }

  /** 方案条目展示用：当前生效归属 + 班级/学科/教师显示名。 */
  describeOccurrences(ids: readonly string[]): Array<{
    occurrenceId: string;
    classId: string;
    className: string;
    subjectId: string;
    subjectName: string;
    teacherId: string;
    teacherName: string;
    date: string;
    period: number;
    cancelled: boolean;
    version: number;
  }> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT o.id AS occurrence_id, o.class_id, c.display_name AS class_name,
                o.subject_id, sub.name AS subject_name,
                COALESCE(st.teacher_id, o.teacher_id) AS teacher_id, t.display_name AS teacher_name,
                COALESCE(st.date, o.date) AS date, COALESCE(st.period, o.period) AS period,
                COALESCE(st.cancelled, 0) AS cancelled, COALESCE(st.version, 0) AS version
           FROM occurrence o
           LEFT JOIN assignment_state st ON st.occurrence_id = o.id
           JOIN school_class c ON c.id = o.class_id
           JOIN subject sub ON sub.id = o.subject_id
           JOIN teacher t ON t.id = COALESCE(st.teacher_id, o.teacher_id)
          WHERE o.id IN (${placeholders})
          ORDER BY o.id`,
      )
      .all(...ids) as unknown as Array<{
      occurrence_id: string;
      class_id: string;
      class_name: string;
      subject_id: string;
      subject_name: string;
      teacher_id: string;
      teacher_name: string;
      date: string;
      period: number;
      cancelled: number;
      version: number;
    }>;
    return rows.map((r) => ({
      occurrenceId: r.occurrence_id,
      classId: r.class_id,
      className: r.class_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      teacherId: r.teacher_id,
      teacherName: r.teacher_name,
      date: r.date,
      period: r.period,
      cancelled: r.cancelled === 1,
      version: r.version,
    }));
  }

  /** 教师显示名；未知 ID 不出现在结果中（界面显示原 ID，不假装已解析）。 */
  teacherNames(ids: readonly string[]): Record<string, string> {
    if (ids.length === 0) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, display_name FROM teacher WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as Array<{ id: string; display_name: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.id] = r.display_name;
    return out;
  }

  versionOf(occurrenceId: string): number {
    const row = this.db
      .prepare('SELECT version FROM assignment_state WHERE occurrence_id = ?')
      .get(occurrenceId) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  writeAssignment(
    input: {
      occurrenceId: string;
      termId: string;
      classId: string;
      subjectId: string;
      teacherId: string;
      date: string;
      period: number;
      cancelled: boolean;
      version: number;
      changeId: string;
    },
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO assignment_state(occurrence_id, term_id, class_id, subject_id, teacher_id, date, period, cancelled, version, change_id, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(occurrence_id) DO UPDATE SET
           teacher_id = excluded.teacher_id,
           date = excluded.date,
           period = excluded.period,
           cancelled = excluded.cancelled,
           version = excluded.version,
           change_id = excluded.change_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.occurrenceId,
        input.termId,
        input.classId,
        input.subjectId,
        input.teacherId,
        input.date,
        input.period,
        input.cancelled ? 1 : 0,
        input.version,
        input.changeId,
        at,
      );
  }

  isExecuted(occurrenceId: string): boolean {
    const row = this.db
      .prepare('SELECT executed FROM execution_fact WHERE occurrence_id = ?')
      .get(occurrenceId) as { executed: number } | undefined;
    return row?.executed === 1;
  }

  recordExecution(
    occurrenceId: string,
    executed: boolean,
    by: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO execution_fact(occurrence_id, executed, registered_by, registered_at)
         VALUES(?,?,?,?)
         ON CONFLICT(occurrence_id) DO UPDATE SET executed = excluded.executed, registered_by = excluded.registered_by, registered_at = excluded.registered_at`,
      )
      .run(occurrenceId, executed ? 1 : 0, by, at);
  }

  insertEffective(input: {
    id: string;
    changeId: string;
    revision: number;
    termId: string;
    kind: 'CHANGE' | 'RECOVERY';
    appliedBy: string;
    appliedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO effective_change(id, change_id, revision, term_id, kind, applied_by, applied_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.changeId,
        input.revision,
        input.termId,
        input.kind,
        input.appliedBy,
        input.appliedAt,
      );
  }

  countEffective(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM effective_change')
      .get() as { n: number };
    return row.n;
  }

  insertAudit(input: {
    at: string;
    actor: string;
    action: string;
    objectType: string;
    objectId: string;
    beforeState: string | null;
    afterState: string | null;
    reason: string | null;
  }): void {
    // 唯一写入口：哈希链、序号与链接由 AuditLog 统一负责。
    this.auditLog.append(input);
  }

  auditOf(objectId: string): Array<{
    at: string;
    actor: string;
    action: string;
    beforeState: string | null;
    afterState: string | null;
  }> {
    const rows = this.db
      .prepare(
        'SELECT at, actor, action, before_state, after_state FROM audit_event WHERE object_id = ? ORDER BY seq',
      )
      .all(objectId) as Array<{
      at: string;
      actor: string;
      action: string;
      before_state: string | null;
      after_state: string | null;
    }>;
    return rows.map((r) => ({
      at: r.at,
      actor: r.actor,
      action: r.action,
      beforeState: r.before_state,
      afterState: r.after_state,
    }));
  }

  insertNotification(input: {
    id: string;
    changeId: string;
    recipientId: string;
    kind: 'CONFIRMATION_REQUIRED' | 'CLASS_HEAD_NOTICE';
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO notification_event(id, change_id, recipient_id, kind, delivery, created_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(input.id, input.changeId, input.recipientId, input.kind, 'UNDETERMINED', input.at);
  }

  notificationsOf(changeId: string): Array<{
    recipientId: string;
    kind: string;
    delivery: string;
  }> {
    const rows = this.db
      .prepare(
        'SELECT recipient_id, kind, delivery FROM notification_event WHERE change_id = ? ORDER BY recipient_id, kind',
      )
      .all(changeId) as Array<{
      recipient_id: string;
      kind: string;
      delivery: string;
    }>;
    return rows.map((r) => ({
      recipientId: r.recipient_id,
      kind: r.kind,
      delivery: r.delivery,
    }));
  }

  clearNotifications(changeId: string): void {
    this.db.prepare('DELETE FROM notification_event WHERE change_id = ?').run(changeId);
  }
}
