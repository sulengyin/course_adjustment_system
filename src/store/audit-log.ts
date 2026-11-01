/**
 * 审计的唯一写入口。
 *
 * 设计约束（P1 裁定 #9）：append-only + 关键字段哈希链。
 *  - 任何业务模块不得直接 `INSERT INTO audit_event`，只能经 `AuditLog.append`。
 *  - 每行 `hash = sha256(seq|at|actor|action|objectType|objectId|before|after|reason|prevHash)`。
 *  - `verify()` 从头重算，任何一行被改、被删、被换序都会被发现。
 *
 * 已知边界：单进程内原子；链本身无法发现"整段尾部被截断"，
 * 因此备份 manifest 会记录当时的 `length` 与 `lastHash`，由恢复对账做锚点比对。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface AuditAppendInput {
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly beforeState?: string | null;
  readonly afterState?: string | null;
  readonly reason?: string | null;
}

export interface AuditAppendResult {
  readonly seq: number;
  readonly hash: string;
}

export interface AuditChainStatus {
  readonly ok: boolean;
  readonly length: number;
  readonly lastHash: string | null;
  /** 第一条不一致的行号；ok=true 时为 null */
  readonly brokenAt: number | null;
  readonly reason: 'HASH_MISMATCH' | 'SEQUENCE_GAP' | 'UNSEALED_ROW' | null;
}

/** 对外展示用的一行审计。哈希截断由调用方决定，这里给全文以便前端自行截断。 */
export interface AuditViewRow {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly beforeState: string | null;
  readonly afterState: string | null;
  readonly reason: string | null;
  readonly hash: string;
}

interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  action: string;
  object_type: string;
  object_id: string;
  before_state: string | null;
  after_state: string | null;
  reason: string | null;
  prev_hash: string;
  hash: string;
}

const TRIGGER = `
CREATE TRIGGER IF NOT EXISTS audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
`;

function digest(row: Omit<AuditRow, 'hash'>): string {
  // 固定顺序的数组序列化：不依赖对象键顺序，也不受字段内容里出现分隔符影响。
  const payload = JSON.stringify([
    row.seq,
    row.at,
    row.actor,
    row.action,
    row.object_type,
    row.object_id,
    row.before_state,
    row.after_state,
    row.reason,
    row.prev_hash,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  /** 链尾（最后一条已封印的行）。 */
  tail(): { seq: number; hash: string } | null {
    const row = this.db
      .prepare("SELECT seq, hash FROM audit_event WHERE hash <> '' ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;
    return row ?? null;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number };
    return row.n;
  }

  /** 追加一条审计。必须与业务写入处在同一事务内，否则会出现"业务成功、审计缺失"。 */
  append(input: AuditAppendInput): AuditAppendResult {
    const prev = this.tail();
    const maxRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM audit_event').get() as { m: number };
    const seq = Math.max(maxRow.m, prev?.seq ?? 0) + 1;
    const prevHash = prev?.hash ?? '';
    const row = {
      seq,
      at: input.at,
      actor: input.actor,
      action: input.action,
      object_type: input.objectType,
      object_id: input.objectId,
      before_state: input.beforeState ?? null,
      after_state: input.afterState ?? null,
      reason: input.reason ?? null,
      prev_hash: prevHash,
    };
    const hash = digest(row);
    this.db
      .prepare(
        `INSERT INTO audit_event(seq, at, actor, action, object_type, object_id, before_state, after_state, reason, prev_hash, hash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.seq,
        row.at,
        row.actor,
        row.action,
        row.object_type,
        row.object_id,
        row.before_state,
        row.after_state,
        row.reason,
        row.prev_hash,
        hash,
      );
    return { seq, hash };
  }

  /** 最近 N 条，按 seq 倒序。只读，不参与链计算。 */
  recent(limit: number): AuditViewRow[] {
    return this.related({ limit });
  }

  /**
   * 按"与我有关"筛选：我是操作者，或对象是我参与的单据。
   * 两个条件都为空时返回空数组，而不是全表——空条件不得退化成"看全部"。
   */
  related(input: {
    readonly actors?: readonly string[];
    readonly objectIds?: readonly string[];
    readonly limit: number;
  }): AuditViewRow[] {
    const actors = (input.actors ?? []).filter((a) => a !== '');
    const objectIds = (input.objectIds ?? []).filter((o) => o !== '');
    if (actors.length === 0 && objectIds.length === 0) return [];
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (actors.length > 0) {
      clauses.push(`actor IN (${actors.map(() => '?').join(',')})`);
      params.push(...actors);
    }
    if (objectIds.length > 0) {
      clauses.push(`object_id IN (${objectIds.map(() => '?').join(',')})`);
      params.push(...objectIds);
    }
    const limit = Math.max(1, Math.min(Math.trunc(input.limit), 500));
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT seq, at, actor, action, object_type, object_id, before_state, after_state, reason, hash
           FROM audit_event WHERE ${clauses.join(' OR ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params) as unknown as AuditRow[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      actor: r.actor,
      action: r.action,
      objectType: r.object_type,
      objectId: r.object_id,
      beforeState: r.before_state,
      afterState: r.after_state,
      reason: r.reason,
      hash: r.hash,
    }));
  }

  verify(): AuditChainStatus {
    const rows = this.db
      .prepare(
        `SELECT seq, at, actor, action, object_type, object_id, before_state, after_state, reason, prev_hash, hash
           FROM audit_event ORDER BY seq`,
      )
      .all() as unknown as AuditRow[];

    let prevHash = '';
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, length: rows.length, lastHash: prevHash || null, brokenAt: row.seq, reason: 'SEQUENCE_GAP' };
      }
      if (row.hash === '') {
        return { ok: false, length: rows.length, lastHash: prevHash || null, brokenAt: row.seq, reason: 'UNSEALED_ROW' };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, length: rows.length, lastHash: prevHash || null, brokenAt: row.seq, reason: 'HASH_MISMATCH' };
      }
      const expect = digest(row);
      if (expect !== row.hash) {
        return { ok: false, length: rows.length, lastHash: prevHash || null, brokenAt: row.seq, reason: 'HASH_MISMATCH' };
      }
      prevHash = row.hash;
      expectedSeq += 1;
    }
    return { ok: true, length: rows.length, lastHash: prevHash || null, brokenAt: null, reason: null };
  }

  /**
   * 封印历史遗留行（P5 之前建的库没有 hash 列）。
   * 只补算哈希，不改任何业务字段；补算行为本身不写审计（否则会与"补算到哪一行"互相依赖）。
   * 新库没有遗留行，此方法为空操作。
   */
  sealLegacy(): number {
    const legacy = this.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE hash = ''").get() as { n: number };
    if (legacy.n === 0) return 0;
    this.db.exec('DROP TRIGGER IF EXISTS audit_event_no_update');
    try {
      const rows = this.db
        .prepare(
          `SELECT seq, at, actor, action, object_type, object_id, before_state, after_state, reason, prev_hash
             FROM audit_event ORDER BY seq`,
        )
        .all() as unknown as Array<Omit<AuditRow, 'hash'>>;
      let prevHash = '';
      const update = this.db.prepare('UPDATE audit_event SET prev_hash = ?, hash = ? WHERE seq = ?');
      for (const row of rows) {
        const hash = digest({ ...row, prev_hash: prevHash });
        update.run(prevHash, hash, row.seq);
        prevHash = hash;
      }
      return legacy.n;
    } finally {
      this.db.exec(TRIGGER);
    }
  }
}

export { TRIGGER as AUDIT_TRIGGER_DDL };
