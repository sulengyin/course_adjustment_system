/**
 * 应急请求存储。只做读写与字段映射，不做业务判定。
 *
 * 注意：`note` 可能包含教师私人情况，只在业务表保存；
 * 审计只记录状态与对象，不写 note（见 EmergencyService 的审计字段）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CoordinationStatus, TeachingVerification } from '../domain/emergency.js';
import { AuditLog } from './audit-log.js';

export interface EmergencyRequestRecord {
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
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RequestRow {
  id: string;
  term_id: string;
  occurrence_id: string;
  requester_teacher_id: string;
  note: string;
  status: string;
  owner_teacher_id: string | null;
  provisional_teacher_id: string | null;
  teaching_verification: string;
  closure_submitted_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

function mapRequest(row: RequestRow): EmergencyRequestRecord {
  return {
    id: row.id,
    termId: row.term_id,
    occurrenceId: row.occurrence_id,
    requesterTeacherId: row.requester_teacher_id,
    note: row.note,
    status: row.status as CoordinationStatus,
    ownerTeacherId: row.owner_teacher_id,
    provisionalTeacherId: row.provisional_teacher_id,
    teachingVerification: row.teaching_verification as TeachingVerification,
    closureSubmittedAt: row.closure_submitted_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, term_id, occurrence_id, requester_teacher_id, note, status,
  owner_teacher_id, provisional_teacher_id, teaching_verification, closure_submitted_at,
  idempotency_key, created_at, updated_at`;

export class EmergencyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly auditLog: AuditLog,
  ) {}

  insert(record: EmergencyRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO emergency_request(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.termId,
        record.occurrenceId,
        record.requesterTeacherId,
        record.note,
        record.status,
        record.ownerTeacherId,
        record.provisionalTeacherId,
        record.teachingVerification,
        record.closureSubmittedAt,
        record.idempotencyKey,
        record.createdAt,
        record.updatedAt,
      );
    this.auditLog.append({
      at: record.createdAt,
      actor: record.requesterTeacherId,
      action: 'EMERGENCY_REQUESTED',
      objectType: 'EMERGENCY_REQUEST',
      objectId: record.id,
      // 只写状态类事实，不写 note
      afterState: JSON.stringify({
        status: record.status,
        occurrenceId: record.occurrenceId,
        ownerTeacherId: record.ownerTeacherId,
        teachingVerification: record.teachingVerification,
      }),
    });
  }

  findByKey(key: string): EmergencyRequestRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM emergency_request WHERE idempotency_key = ?`)
      .get(key) as RequestRow | undefined;
    return row ? mapRequest(row) : null;
  }

  get(id: string): EmergencyRequestRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM emergency_request WHERE id = ?`)
      .get(id) as RequestRow | undefined;
    return row ? mapRequest(row) : null;
  }

  /** 我发起的求助，最近的在前。含说明文本，只应返回给求助人本人。 */
  listByRequester(teacherId: string, limit = 50): EmergencyRequestRecord[] {
    const safe = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 50;
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM emergency_request WHERE requester_teacher_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(teacherId, safe) as unknown as RequestRow[];
    return rows.map(mapRequest);
  }

  /** 记录"尝试了但被拒绝"的审计；用于发现越权尝试（权限矩阵 §5）。 */
  auditDenied(input: {
    at: string;
    actor: string;
    action: string;
    code: string;
    requestId: string | null;
  }): void {
    this.auditLog.append({
      at: input.at,
      actor: input.actor,
      action: 'EMERGENCY_ACTION_DENIED',
      objectType: 'EMERGENCY_ACTION',
      objectId: input.requestId ?? input.action,
      reason: `${input.action}:${input.code}`,
    });
  }
}
