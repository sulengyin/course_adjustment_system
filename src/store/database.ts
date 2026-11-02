import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AuditLog } from './audit-log.js';
import type {
  BellEntry,
  CalendarException,
  DataOrigin,
  DeploymentMode,
  ExceptionKind,
  Occurrence,
  SchoolSnapshot,
  TemplateParity,
  Weekday,
  WeekParity,
} from '../domain/model.js';

/** 环境名称：错误消息与界面都用它，避免各处各写一套说法。 */
export const MODE_LABEL: Readonly<Record<DeploymentMode, string>> = Object.freeze({
  DEMO: '演示 / 联调环境',
  PRODUCTION: '正式业务环境',
});

/**
 * P2 存储层：SQLite（node:sqlite 内置模块，无原生依赖）。
 * 只存"学校资料"与"派生课次"。派生课次可整段重建，不承载任何已生效事实。
 *
 * 不引入迁移框架：P2 尚无历史库，DDL 幂等创建即可；版本写入 meta 表，
 * 后续阶段若改表，必须显式提供迁移而不是改这段 DDL。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teacher (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  data_origin  TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
);

CREATE TABLE IF NOT EXISTS school_class (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  grade        TEXT NOT NULL,
  data_origin  TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
);

CREATE TABLE IF NOT EXISTS subject (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
);

CREATE TABLE IF NOT EXISTS term (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  start_monday       TEXT NOT NULL,
  end_date           TEXT NOT NULL,
  first_week_parity  TEXT NULL CHECK (first_week_parity IN ('ODD','EVEN')),
  data_origin        TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
);

CREATE TABLE IF NOT EXISTS bell (
  term_id     TEXT NOT NULL REFERENCES term(id),
  period      INTEGER NOT NULL,
  starts_at   TEXT NULL,
  ends_at     TEXT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL')),
  PRIMARY KEY (term_id, period)
);

CREATE TABLE IF NOT EXISTS calendar_exception (
  id                TEXT PRIMARY KEY,
  term_id           TEXT NOT NULL REFERENCES term(id),
  date              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('HOLIDAY','MAKEUP_DAY','SUSPENDED')),
  follows_weekday   INTEGER NULL,
  suspended_periods TEXT NULL,
  reason            TEXT NULL,
  data_origin       TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL')),
  UNIQUE (term_id, date, id)
);

CREATE INDEX IF NOT EXISTS idx_exception_date ON calendar_exception(term_id, date);

CREATE TABLE IF NOT EXISTS teaching_template (
  id           TEXT PRIMARY KEY,
  term_id      TEXT NOT NULL REFERENCES term(id),
  class_id     TEXT NOT NULL REFERENCES school_class(id),
  teacher_id   TEXT NOT NULL REFERENCES teacher(id),
  subject_id   TEXT NOT NULL REFERENCES subject(id),
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 5),
  period       INTEGER NOT NULL,
  parity       TEXT NOT NULL CHECK (parity IN ('ALL','ODD','EVEN')),
  rotation     TEXT NOT NULL CHECK (rotation IN ('NONE','CUSTOM')),
  valid_from   TEXT NULL,
  valid_to     TEXT NULL,
  data_origin  TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL')),
  source_batch_id TEXT NULL,
  revoked_at   TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_weekday ON teaching_template(term_id, weekday);

-- 派生表：完全可由 template + calendar + bell 重建，不是"已生效事实"。
CREATE TABLE IF NOT EXISTS occurrence (
  id             TEXT PRIMARY KEY,
  term_id        TEXT NOT NULL,
  template_id    TEXT NOT NULL,
  date           TEXT NOT NULL,
  period         INTEGER NOT NULL,
  class_id       TEXT NOT NULL,
  teacher_id     TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  starts_at      TEXT NULL,
  ends_at        TEXT NULL,
  certainty      TEXT NOT NULL CHECK (certainty IN ('KNOWN','UNKNOWN')),
  unknown_reason TEXT NULL,
  data_origin    TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
);

CREATE INDEX IF NOT EXISTS idx_occ_teacher ON occurrence(term_id, teacher_id, date);
CREATE INDEX IF NOT EXISTS idx_occ_class   ON occurrence(term_id, class_id, date);

-- 应急登记：只记录"有人说了什么"，不改课表（V2.3 必测 7）。
CREATE TABLE IF NOT EXISTS emergency_note (
  id           TEXT PRIMARY KEY,
  term_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  period       INTEGER NOT NULL,
  class_id     TEXT NOT NULL,
  note         TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  counts_as_teacher_confirmation INTEGER NOT NULL CHECK (counts_as_teacher_confirmation = 0)
);

-- 求助请求：只记录"谁在什么时候说了需要帮助"，不推断已通知或已有人接。
-- teaching_verification 独立于 status：结案不蕴含授课已核验（INV-04）。
CREATE TABLE IF NOT EXISTS emergency_request (
  id                    TEXT PRIMARY KEY,
  term_id               TEXT NOT NULL,
  occurrence_id         TEXT NOT NULL REFERENCES occurrence(id),
  requester_teacher_id  TEXT NOT NULL,
  note                  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('REQUESTED','NOTIFIED','NO_OWNER','OWNED','AMBIGUOUS','CLOSURE_SUBMITTED','CLOSED')),
  owner_teacher_id      TEXT NULL,
  provisional_teacher_id TEXT NULL,
  teaching_verification TEXT NOT NULL CHECK (teaching_verification IN ('PENDING','VERIFIED')),
  closure_submitted_at  TEXT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emergency_term ON emergency_request(term_id, status);

-- 导入批次：一次上传 = 一条记录。状态推进只允许单向。
CREATE TABLE IF NOT EXISTS import_batch (
  id            TEXT PRIMARY KEY,
  term_id       TEXT NOT NULL REFERENCES term(id),
  file_name     TEXT NOT NULL,
  file_sha256   TEXT NOT NULL,
  parser        TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('VALIDATED','REJECTED','IMPORTED_NOT_PUBLISHED','PUBLISHED','REVOKED')),
  data_origin   TEXT NOT NULL CHECK (data_origin IN ('IMPORTED_UNVERIFIED')),
  uploaded_at   TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL,
  published_at  TEXT NULL,
  published_by  TEXT NULL,
  publish_mode  TEXT NULL CHECK (publish_mode IN ('APPEND','REPLACE')),
  rejected_note TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_sha ON import_batch(file_sha256);

-- 暂存行：仅 VALIDATED 及之后的批次保留，拒绝批次不落行
CREATE TABLE IF NOT EXISTS import_row (
  batch_id     TEXT NOT NULL REFERENCES import_batch(id),
  line_no      INTEGER NOT NULL,
  teacher_id   TEXT NOT NULL,
  class_id     TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  weekday      INTEGER NOT NULL,
  period       INTEGER NOT NULL,
  parity       TEXT NOT NULL,
  valid_from   TEXT NULL,
  valid_to     TEXT NULL,
  PRIMARY KEY (batch_id, line_no)
);

-- 撤销批次时留下的标记：不删除任何已生效数据，只记录"这条来自被撤销的批次"
CREATE TABLE IF NOT EXISTS revocation_marker (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  template_id  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ===== P4 变更协商 =====

CREATE TABLE IF NOT EXISTS change_case (
  id               TEXT PRIMARY KEY,
  term_id          TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('CHANGE','RECOVERY')),
  parent_change_id TEXT NULL,
  status           TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_CONFIRMATION','BLOCKED_CONFLICT','APPLYING','EFFECTIVE','REJECTED','WITHDRAWN')),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  submitted_by     TEXT NOT NULL,
  reason           TEXT NULL,
  idempotency_key  TEXT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS change_item (
  change_id        TEXT NOT NULL REFERENCES change_case(id),
  revision         INTEGER NOT NULL,
  occurrence_id    TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('REASSIGN','MOVE','CANCEL')),
  to_teacher_id    TEXT NULL,
  to_date          TEXT NULL,
  to_period        INTEGER NULL,
  expected_version INTEGER NOT NULL,
  PRIMARY KEY (change_id, revision, occurrence_id)
);

CREATE TABLE IF NOT EXISTS change_confirmation (
  change_id   TEXT NOT NULL REFERENCES change_case(id),
  teacher_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('ACCEPT','DECLINE')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (change_id, teacher_id, revision)
);

-- 提交时固化的必要确认者。课表之后变化时整单失效，不得悄悄换确认人。
CREATE TABLE IF NOT EXISTS change_required (
  change_id  TEXT NOT NULL REFERENCES change_case(id),
  revision   INTEGER NOT NULL,
  teacher_id TEXT NOT NULL,
  PRIMARY KEY (change_id, revision, teacher_id)
);

-- 生效记录：append-only，不提供更新或删除方法
CREATE TABLE IF NOT EXISTS effective_change (
  id         TEXT PRIMARY KEY,
  change_id  TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  term_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('CHANGE','RECOVERY')),
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 课次当前有效归属；version 用于并发互斥，每次生效 +1
CREATE TABLE IF NOT EXISTS assignment_state (
  occurrence_id TEXT PRIMARY KEY,
  term_id       TEXT NOT NULL,
  class_id      TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  teacher_id    TEXT NOT NULL,
  date          TEXT NOT NULL,
  period        INTEGER NOT NULL,
  cancelled     INTEGER NOT NULL CHECK (cancelled IN (0,1)),
  version       INTEGER NOT NULL,
  change_id     TEXT NULL,
  updated_at    TEXT NOT NULL
);

-- 执行事实：只有显式登记才有记录，系统不按时间推断
CREATE TABLE IF NOT EXISTS execution_fact (
  occurrence_id TEXT PRIMARY KEY,
  executed      INTEGER NOT NULL CHECK (executed IN (0,1)),
  registered_by TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

-- 通知事件：只记录"应通知谁"，送达与否一律 UNDETERMINED（BIZ-13 未定）
CREATE TABLE IF NOT EXISTS notification_event (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('CONFIRMATION_REQUIRED','CLASS_HEAD_NOTICE')),
  delivery     TEXT NOT NULL CHECK (delivery = 'UNDETERMINED'),
  created_at   TEXT NOT NULL
);

-- 账号与会话：本地账号，管理员开户；不采集手机号、不接外部身份源。
CREATE TABLE IF NOT EXISTS app_user (
  id                   TEXT PRIMARY KEY,
  login_name           TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  teacher_id           TEXT NULL REFERENCES teacher(id),
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0,1)),
  password_hash        TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  password_changed_at  TEXT NULL,
  disabled_at          TEXT NULL,
  disabled_by          TEXT NULL
);

CREATE TABLE IF NOT EXISTS user_role (
  user_id    TEXT NOT NULL REFERENCES app_user(id),
  role       TEXT NOT NULL CHECK (role IN ('T','S','C','R','J','A')),
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TEXT NULL,
  PRIMARY KEY (user_id, role)
);

-- 会话只存 token 的 sha256，不存明文；acting_role 即"本次以哪个身份行事"。
CREATE TABLE IF NOT EXISTS session (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_user(id),
  token_hash     TEXT NOT NULL UNIQUE,
  acting_role    TEXT NOT NULL CHECK (acting_role IN ('T','S','C','R','J','A')),
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT NULL,
  revoked_reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);

-- 审计：append-only + 哈希链。写入口只有 src/store/audit-log.ts。
CREATE TABLE IF NOT EXISTS audit_event (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  before_state TEXT NULL,
  after_state  TEXT NULL,
  reason       TEXT NULL,
  prev_hash    TEXT NOT NULL DEFAULT '',
  hash         TEXT NOT NULL DEFAULT ''
);

-- 数据库层兜底：审计行不可修改（不是靠应用自觉）
CREATE TRIGGER IF NOT EXISTS audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;

CREATE INDEX IF NOT EXISTS idx_change_status ON change_case(status);
CREATE INDEX IF NOT EXISTS idx_assignment_term ON assignment_state(term_id, date);
`;

export interface TimetableRow {
  readonly occurrenceId: string;
  readonly date: string;
  readonly period: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly certainty: 'KNOWN' | 'UNKNOWN';
  readonly unknownReason: string | null;
  readonly classId: string;
  readonly className: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly dataOrigin: DataOrigin;
  /** 已生效方案把该课次停掉：仍列出，但不得计入"有课" */
  readonly cancelled: boolean;
}

interface RawTimetableRow {
  occurrence_id: string;
  date: string;
  period: number;
  starts_at: string | null;
  ends_at: string | null;
  certainty: 'KNOWN' | 'UNKNOWN';
  unknown_reason: string | null;
  class_id: string;
  class_name: string;
  teacher_id: string;
  teacher_name: string;
  subject_id: string;
  subject_name: string;
  data_origin: DataOrigin;
  cancelled: number;
}

/**
 * 课表投影 = 派生课次 + 已生效变更（assignment_state）。
 *
 * P2 只读派生课次时，调课生效后教师视图仍显示原教师——界面会与审计事实相反。
 * 这里统一叠加，教师/班级/全校三个视图共用同一份投影，避免各自拼 SQL 后走样。
 */
const SELECT_TIMETABLE = `
SELECT o.id             AS occurrence_id,
       COALESCE(st.date, o.date)       AS date,
       COALESCE(st.period, o.period)   AS period,
       o.starts_at      AS starts_at,
       o.ends_at        AS ends_at,
       o.certainty      AS certainty,
       o.unknown_reason AS unknown_reason,
       o.class_id       AS class_id,
       c.display_name   AS class_name,
       COALESCE(st.teacher_id, o.teacher_id) AS teacher_id,
       t.display_name   AS teacher_name,
       o.subject_id     AS subject_id,
       s.name           AS subject_name,
       o.data_origin    AS data_origin,
       COALESCE(st.cancelled, 0) AS cancelled
  FROM occurrence o
  LEFT JOIN assignment_state st ON st.occurrence_id = o.id
  JOIN school_class c ON c.id = o.class_id
  JOIN teacher t      ON t.id = COALESCE(st.teacher_id, o.teacher_id)
  JOIN subject s      ON s.id = o.subject_id
`;

function toRow(r: RawTimetableRow): TimetableRow {
  return {
    occurrenceId: r.occurrence_id,
    date: r.date,
    period: r.period,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    certainty: r.certainty,
    unknownReason: r.unknown_reason,
    classId: r.class_id,
    className: r.class_name,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    dataOrigin: r.data_origin,
    cancelled: r.cancelled === 1,
  };
}

export class CourseDatabase {
  private readonly db: DatabaseSync;
  readonly auditLog: AuditLog;

  /** 供子存储共享同一连接（含事务）。业务层不得直接用。 */
  get handle(): DatabaseSync {
    return this.db;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** 库的环境；null = 尚未设定，此时任何读写真实业务的入口都应先拒绝。 */
  deploymentMode(): DeploymentMode | null {
    const v = this.getMeta('deployment_mode');
    return v === 'DEMO' || v === 'PRODUCTION' ? v : null;
  }

  /**
   * 首次设定环境。已设定则抛错——环境不是可以随时切换的开关，
   * 切换意味着此前的数据归属要重新解释，只能另建库。
   */
  setDeploymentMode(mode: DeploymentMode): void {
    const current = this.deploymentMode();
    if (current !== null) {
      throw new Error(`该库已设定为 ${MODE_LABEL[current]}（${current}），不可更改；需要另一种环境请新建库。`);
    }
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('deployment_mode', mode);
  }

  /** 入口闸门：环境不符就抛错，把"虚构数据进正式库 / 真实数据进演示库"挡在写入之前。 */
  requireMode(expected: DeploymentMode): void {
    const actual = this.deploymentMode();
    if (actual === null) {
      throw new Error(`该库尚未设定环境，请先执行：npm run set-mode（当前需要 ${MODE_LABEL[expected]}）`);
    }
    if (actual !== expected) {
      throw new Error(
        `此操作只允许在${MODE_LABEL[expected]}库执行，当前库是${MODE_LABEL[actual]}（${actual}）。` +
          '两种环境的数据不得混装，请换用对应的库。',
      );
    }
  }

  /** 单事务执行；失败整体回滚，不部分生效。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.auditLog = new AuditLog(this.db);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(DDL);
    // 兼容 P2 建的库：CREATE TABLE IF NOT EXISTS 不会补列，必须显式 ALTER
    this.ensureColumn('teaching_template', 'source_batch_id', 'TEXT NULL');
    this.ensureColumn('teaching_template', 'revoked_at', 'TEXT NULL');
    this.ensureColumn('audit_event', 'prev_hash', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('audit_event', 'hash', "TEXT NOT NULL DEFAULT ''");
    // P5 之前建的库没有哈希链：这里只补算哈希，不改业务字段。
    this.auditLog.sealLegacy();
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', 'p6-1');
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** 仅供测试：清空全部表，不改结构。 */
  clearAll(): void {
    for (const table of [
      'session',
      'user_role',
      'app_user',
      'audit_event',
      'notification_event',
      'execution_fact',
      'assignment_state',
      'effective_change',
      'change_confirmation',
      'change_required',
      'change_item',
      'change_case',
      'revocation_marker',
      'import_row',
      'import_batch',
      'emergency_request',
      'emergency_note',
      'occurrence',
      'teaching_template',
      'calendar_exception',
      'bell',
      'term',
      'subject',
      'school_class',
      'teacher',
    ]) {
      this.db.exec(`DELETE FROM ${table}`);
    }
  }

  loadSnapshot(s: SchoolSnapshot): void {
    this.clearAll();
    const insertTerm = this.db.prepare(
      'INSERT INTO term(id, label, start_monday, end_date, first_week_parity, data_origin) VALUES(?,?,?,?,?,?)',
    );
    insertTerm.run(
      s.term.id,
      s.term.label,
      s.term.startMonday,
      s.term.endDate,
      s.term.firstWeekParity,
      s.term.dataOrigin,
    );

    const insertTeacher = this.db.prepare(
      'INSERT INTO teacher(id, display_name, data_origin) VALUES(?,?,?)',
    );
    for (const t of s.teachers) insertTeacher.run(t.id, t.displayName, t.dataOrigin);

    const insertClass = this.db.prepare(
      'INSERT INTO school_class(id, display_name, grade, data_origin) VALUES(?,?,?,?)',
    );
    for (const c of s.classes) insertClass.run(c.id, c.displayName, c.grade, c.dataOrigin);

    const insertSubject = this.db.prepare(
      'INSERT INTO subject(id, name, data_origin) VALUES(?,?,?)',
    );
    for (const sub of s.subjects) insertSubject.run(sub.id, sub.name, sub.dataOrigin);

    const insertBell = this.db.prepare(
      'INSERT INTO bell(term_id, period, starts_at, ends_at, data_origin) VALUES(?,?,?,?,?)',
    );
    for (const b of s.bell) insertBell.run(s.term.id, b.period, b.startsAt, b.endsAt, s.term.dataOrigin);

    const insertException = this.db.prepare(
      'INSERT INTO calendar_exception(id, term_id, date, kind, follows_weekday, suspended_periods, reason, data_origin) VALUES(?,?,?,?,?,?,?,?)',
    );
    for (const e of s.exceptions) {
      insertException.run(
        e.id,
        e.termId,
        e.date,
        e.kind,
        e.followsWeekday,
        e.suspendedPeriods === null || e.suspendedPeriods === 'ALL'
          ? e.suspendedPeriods
          : JSON.stringify(e.suspendedPeriods),
        e.reason,
        e.dataOrigin,
      );
    }

    const insertTemplate = this.db.prepare(
      `INSERT INTO teaching_template(id, term_id, class_id, teacher_id, subject_id, weekday, period, parity, rotation, valid_from, valid_to, data_origin)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of s.templates) {
      insertTemplate.run(
        t.id,
        t.termId,
        t.classId,
        t.teacherId,
        t.subjectId,
        t.weekday,
        t.period,
        t.parity,
        t.rotation,
        t.validFrom,
        t.validTo,
        t.dataOrigin,
      );
    }
  }

  /** 读取学期（P2 单学期；多学期在 P3 随版本化一起处理） */
  getTerm(termId: string): {
    term: {
      id: string;
      label: string;
      startMonday: string;
      endDate: string;
      firstWeekParity: WeekParity | null;
      dataOrigin: DataOrigin;
    };
  } | null {
    const raw = this.db
      .prepare('SELECT id, label, start_monday, end_date, first_week_parity, data_origin FROM term WHERE id = ?')
      .get(termId) as
      | {
          id: string;
          label: string;
          start_monday: string;
          end_date: string;
          first_week_parity: WeekParity | null;
          data_origin: DataOrigin;
        }
      | undefined;
    if (!raw) return null;
    return {
      term: {
        id: raw.id,
        label: raw.label,
        startMonday: raw.start_monday,
        endDate: raw.end_date,
        firstWeekParity: raw.first_week_parity,
        dataOrigin: raw.data_origin,
      },
    };
  }

  /** 全部学期，最近的在前。只读，用于界面选择学期。 */
  listTerms(): Array<{
    id: string;
    label: string;
    startMonday: string;
    endDate: string;
    firstWeekParity: WeekParity | null;
    dataOrigin: DataOrigin;
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, label, start_monday, end_date, first_week_parity, data_origin FROM term ORDER BY start_monday DESC, id',
      )
      .all() as Array<{
      id: string;
      label: string;
      start_monday: string;
      end_date: string;
      first_week_parity: WeekParity | null;
      data_origin: DataOrigin;
    }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      startMonday: r.start_monday,
      endDate: r.end_date,
      firstWeekParity: r.first_week_parity,
      dataOrigin: r.data_origin,
    }));
  }

  /** 课次来源统计。SIMULATED 与 OFFICIAL 必须能分开数，不能混成一个"课次数"。 */
  occurrenceStats(termId: string): {
    total: number;
    simulated: number;
    importedUnverified: number;
    official: number;
  } {
    const rows = this.db
      .prepare('SELECT data_origin, COUNT(*) AS n FROM occurrence WHERE term_id = ? GROUP BY data_origin')
      .all(termId) as Array<{ data_origin: string; n: number }>;
    const stat = { total: 0, simulated: 0, importedUnverified: 0, official: 0 };
    for (const r of rows) {
      stat.total += r.n;
      if (r.data_origin === 'SIMULATED') stat.simulated += r.n;
      else if (r.data_origin === 'IMPORTED_UNVERIFIED') stat.importedUnverified += r.n;
      else if (r.data_origin === 'OFFICIAL') stat.official += r.n;
    }
    return stat;
  }

  countChangeCases(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM change_case').get() as { n: number };
    return row.n;
  }

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number };
    return row.n;
  }

  getBell(termId: string): BellEntry[] {
    const rows = this.db
      .prepare('SELECT period, starts_at, ends_at FROM bell WHERE term_id = ? ORDER BY period')
      .all(termId) as Array<{ period: number; starts_at: string | null; ends_at: string | null }>;
    return rows.map((r) => ({ period: r.period, startsAt: r.starts_at, endsAt: r.ends_at }));
  }

  getTemplates(termId: string): Array<{
    id: string;
    termId: string;
    classId: string;
    teacherId: string;
    subjectId: string;
    weekday: Weekday;
    period: number;
    parity: TemplateParity;
    rotation: 'NONE' | 'CUSTOM';
    validFrom: string | null;
    validTo: string | null;
    dataOrigin: DataOrigin;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, term_id, class_id, teacher_id, subject_id, weekday, period, parity, rotation, valid_from, valid_to, data_origin
           FROM teaching_template
          WHERE term_id = ? AND revoked_at IS NULL
          ORDER BY weekday, period, class_id`,
      )
      .all(termId) as Array<{
      id: string;
      term_id: string;
      class_id: string;
      teacher_id: string;
      subject_id: string;
      weekday: Weekday;
      period: number;
      parity: TemplateParity;
      rotation: 'NONE' | 'CUSTOM';
      valid_from: string | null;
      valid_to: string | null;
      data_origin: DataOrigin;
    }>;
    return rows.map((r) => ({
      id: r.id,
      termId: r.term_id,
      classId: r.class_id,
      teacherId: r.teacher_id,
      subjectId: r.subject_id,
      weekday: r.weekday,
      period: r.period,
      parity: r.parity,
      rotation: r.rotation,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      dataOrigin: r.data_origin,
    }));
  }

  getExceptions(termId: string): CalendarException[] {
    const rows = this.db
      .prepare(
        `SELECT id, term_id, date, kind, follows_weekday, suspended_periods, reason, data_origin
           FROM calendar_exception WHERE term_id = ? ORDER BY date`,
      )
      .all(termId) as Array<{
      id: string;
      term_id: string;
      date: string;
      kind: ExceptionKind;
      follows_weekday: Weekday | null;
      suspended_periods: string | null;
      reason: string | null;
      data_origin: DataOrigin;
    }>;
    return rows.map((r) => ({
      id: r.id,
      termId: r.term_id,
      date: r.date,
      kind: r.kind,
      followsWeekday: r.follows_weekday,
      suspendedPeriods:
        r.suspended_periods === null
          ? null
          : r.suspended_periods === 'ALL'
            ? 'ALL'
            : (JSON.parse(r.suspended_periods) as number[]),
      reason: r.reason,
      dataOrigin: r.data_origin,
    }));
  }

  /** 重建指定区间的派生课次：先删后插，同一事务。 */
  materialize(termId: string, from: string, to: string, occurrences: readonly Occurrence[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM occurrence WHERE term_id = ? AND date BETWEEN ? AND ?')
        .run(termId, from, to);
      const insert = this.db.prepare(
        `INSERT INTO occurrence(id, term_id, template_id, date, period, class_id, teacher_id, subject_id, starts_at, ends_at, certainty, unknown_reason, data_origin)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const o of occurrences) {
        insert.run(
          o.id,
          o.termId,
          o.templateId,
          o.date,
          o.period,
          o.classId,
          o.teacherId,
          o.subjectId,
          o.startsAt,
          o.endsAt,
          o.certainty,
          o.unknownReason,
          o.dataOrigin,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  queryByTeacher(termId: string, teacherId: string, from: string, to: string): TimetableRow[] {
    const rows = this.db
      .prepare(
        `${SELECT_TIMETABLE}
          WHERE o.term_id = ? AND COALESCE(st.teacher_id, o.teacher_id) = ?
            AND COALESCE(st.date, o.date) BETWEEN ? AND ?
          ORDER BY COALESCE(st.date, o.date), COALESCE(st.period, o.period), o.class_id, o.id`,
      )
      .all(termId, teacherId, from, to) as unknown as RawTimetableRow[];
    return rows.map(toRow);
  }

  queryByClass(termId: string, classId: string, from: string, to: string): TimetableRow[] {
    const rows = this.db
      .prepare(
        `${SELECT_TIMETABLE}
          WHERE o.term_id = ? AND o.class_id = ?
            AND COALESCE(st.date, o.date) BETWEEN ? AND ?
          ORDER BY COALESCE(st.date, o.date), COALESCE(st.period, o.period), o.teacher_id, o.id`,
      )
      .all(termId, classId, from, to) as unknown as RawTimetableRow[];
    return rows.map(toRow);
  }

  queryAll(termId: string, from: string, to: string): TimetableRow[] {
    const rows = this.db
      .prepare(
        `${SELECT_TIMETABLE}
          WHERE o.term_id = ? AND COALESCE(st.date, o.date) BETWEEN ? AND ?
          ORDER BY COALESCE(st.date, o.date), COALESCE(st.period, o.period), o.class_id, o.id`,
      )
      .all(termId, from, to) as unknown as RawTimetableRow[];
    return rows.map(toRow);
  }

  /** 课次表指纹：用于断言某操作没有改动课表 */
  occurrenceFingerprint(termId: string): string {
    const rows = this.db
      .prepare(
        `SELECT id, date, period, class_id, teacher_id, subject_id, starts_at, ends_at, certainty, unknown_reason
           FROM occurrence WHERE term_id = ? ORDER BY id`,
      )
      .all(termId);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  insertEmergencyNote(note: {
    id: string;
    termId: string;
    date: string;
    period: number;
    classId: string;
    note: string;
    recordedBy: string;
    recordedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO emergency_note(id, term_id, date, period, class_id, note, recorded_by, recorded_at, counts_as_teacher_confirmation)
         VALUES(?,?,?,?,?,?,?,?,0)`,
      )
      .run(
        note.id,
        note.termId,
        note.date,
        note.period,
        note.classId,
        note.note,
        note.recordedBy,
        note.recordedAt,
      );
  }

  countEmergencyNotes(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM emergency_note').get() as { n: number };
    return row.n;
  }

  countEmergencyRequests(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM emergency_request').get() as { n: number };
    return row.n;
  }

  /* ---------------- 导入（P3） ---------------- */

  /** 供导入校验解析"教师/班级/科目"名称：按 id 与显示名都能匹配 */
  /**
   * 教师名单导入的唯一写入口。
   * 冲突由服务层整批预检拦下；这里不做事后修补——编号一旦落库就会被课表与账号引用。
   */
  insertTeachers(list: readonly { id: string; displayName: string; dataOrigin: DataOrigin }[]): void {
    const stmt = this.db.prepare('INSERT INTO teacher(id, display_name, data_origin) VALUES(?,?,?)');
    for (const t of list) stmt.run(t.id, t.displayName, t.dataOrigin);
  }

  countTerms(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM term').get() as { n: number };
    return row.n;
  }

  /** 学期与作息同批写入：调用方负责校验，这里只管落库。 */
  insertTerm(t: {
    id: string;
    label: string;
    startMonday: string;
    endDate: string;
    firstWeekParity: WeekParity | null;
    dataOrigin: DataOrigin;
  }): void {
    this.db
      .prepare(
        'INSERT INTO term(id, label, start_monday, end_date, first_week_parity, data_origin) VALUES(?,?,?,?,?,?)',
      )
      .run(t.id, t.label, t.startMonday, t.endDate, t.firstWeekParity, t.dataOrigin);
  }

  insertBell(termId: string, list: readonly BellEntry[], dataOrigin: DataOrigin): void {
    const stmt = this.db.prepare(
      'INSERT INTO bell(term_id, period, starts_at, ends_at, data_origin) VALUES(?,?,?,?,?)',
    );
    for (const b of list) stmt.run(termId, b.period, b.startsAt, b.endsAt, dataOrigin);
  }

  refs(): {
    teachers: Array<{ id: string; name: string }>;
    classes: Array<{ id: string; name: string }>;
    subjects: Array<{ id: string; name: string }>;
  } {
    const pick = (sql: string): Array<{ id: string; name: string }> =>
      this.db.prepare(sql).all() as Array<{ id: string; name: string }>;
    return {
      teachers: pick('SELECT id, display_name AS name FROM teacher ORDER BY id'),
      classes: pick('SELECT id, display_name AS name FROM school_class ORDER BY id'),
      subjects: pick('SELECT id, name FROM subject ORDER BY id'),
    };
  }

  createBatch(b: ImportBatchRecord): void {
    this.db
      .prepare(
        `INSERT INTO import_batch(id, term_id, file_name, file_sha256, parser, row_count, status, data_origin,
                                  uploaded_at, uploaded_by, published_at, published_by, publish_mode, rejected_note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.id,
        b.termId,
        b.fileName,
        b.fileSha256,
        b.parser,
        b.rowCount,
        b.status,
        b.dataOrigin,
        b.uploadedAt,
        b.uploadedBy,
        b.publishedAt,
        b.publishedBy,
        b.publishMode,
        b.rejectedNote,
      );
  }

  updateBatch(
    id: string,
    patch: {
      status?: string;
      publishedAt?: string | null;
      publishedBy?: string | null;
      publishMode?: string | null;
      rejectedNote?: string | null;
      rowCount?: number;
    },
  ): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.publishedAt !== undefined) { sets.push('published_at = ?'); args.push(patch.publishedAt); }
    if (patch.publishedBy !== undefined) { sets.push('published_by = ?'); args.push(patch.publishedBy); }
    if (patch.publishMode !== undefined) { sets.push('publish_mode = ?'); args.push(patch.publishMode); }
    if (patch.rejectedNote !== undefined) { sets.push('rejected_note = ?'); args.push(patch.rejectedNote); }
    if (patch.rowCount !== undefined) { sets.push('row_count = ?'); args.push(patch.rowCount); }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE import_batch SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  getBatch(id: string): ImportBatchRecord | null {
    const raw = this.db
      .prepare(
        `SELECT id, term_id, file_name, file_sha256, parser, row_count, status, data_origin,
                uploaded_at, uploaded_by, published_at, published_by, publish_mode, rejected_note
           FROM import_batch WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          term_id: string;
          file_name: string;
          file_sha256: string;
          parser: string;
          row_count: number;
          status: string;
          data_origin: 'IMPORTED_UNVERIFIED';
          uploaded_at: string;
          uploaded_by: string;
          published_at: string | null;
          published_by: string | null;
          publish_mode: 'APPEND' | 'REPLACE' | null;
          rejected_note: string | null;
        }
      | undefined;
    if (!raw) return null;
    return {
      id: raw.id,
      termId: raw.term_id,
      fileName: raw.file_name,
      fileSha256: raw.file_sha256,
      parser: raw.parser,
      rowCount: raw.row_count,
      status: raw.status as ImportBatchRecord['status'],
      dataOrigin: raw.data_origin,
      uploadedAt: raw.uploaded_at,
      uploadedBy: raw.uploaded_by,
      publishedAt: raw.published_at,
      publishedBy: raw.published_by,
      publishMode: raw.publish_mode,
      rejectedNote: raw.rejected_note,
    };
  }

  listBatches(termId: string): ImportBatchRecord[] {
    const ids = this.db
      .prepare('SELECT id FROM import_batch WHERE term_id = ? ORDER BY uploaded_at, id')
      .all(termId) as Array<{ id: string }>;
    return ids.map((r) => this.getBatch(r.id)).filter((b): b is ImportBatchRecord => b !== null);
  }

  countBatches(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM import_batch').get() as { n: number };
    return row.n;
  }

  insertRows(
    batchId: string,
    rows: readonly {
      line: number;
      teacherId: string;
      classId: string;
      subjectId: string;
      weekday: number;
      period: number;
      parity: string;
      validFrom: string | null;
      validTo: string | null;
    }[],
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO import_row(batch_id, line_no, teacher_id, class_id, subject_id, weekday, period, parity, valid_from, valid_to)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      stmt.run(batchId, r.line, r.teacherId, r.classId, r.subjectId, r.weekday, r.period, r.parity, r.validFrom, r.validTo);
    }
  }

  rowsOfBatch(batchId: string): Array<{
    line: number;
    teacherId: string;
    classId: string;
    subjectId: string;
    weekday: Weekday;
    period: number;
    parity: TemplateParity;
    validFrom: string | null;
    validTo: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT line_no, teacher_id, class_id, subject_id, weekday, period, parity, valid_from, valid_to
           FROM import_row WHERE batch_id = ? ORDER BY line_no`,
      )
      .all(batchId) as Array<{
      line_no: number;
      teacher_id: string;
      class_id: string;
      subject_id: string;
      weekday: number;
      period: number;
      parity: string;
      valid_from: string | null;
      valid_to: string | null;
    }>;
    return rows.map((r) => ({
      line: r.line_no,
      teacherId: r.teacher_id,
      classId: r.class_id,
      subjectId: r.subject_id,
      weekday: r.weekday as Weekday,
      period: r.period,
      parity: r.parity as TemplateParity,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
  }

  activeTemplates(termId: string): Array<{
    id: string;
    teacherId: string;
    classId: string;
    subjectId: string;
    weekday: number;
    period: number;
    parity: string;
    validFrom: string | null;
    validTo: string | null;
    sourceBatchId: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, teacher_id, class_id, subject_id, weekday, period, parity, valid_from, valid_to, source_batch_id
           FROM teaching_template WHERE term_id = ? AND revoked_at IS NULL`,
      )
      .all(termId) as Array<{
      id: string;
      teacher_id: string;
      class_id: string;
      subject_id: string;
      weekday: number;
      period: number;
      parity: string;
      valid_from: string | null;
      valid_to: string | null;
      source_batch_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      teacherId: r.teacher_id,
      classId: r.class_id,
      subjectId: r.subject_id,
      weekday: r.weekday,
      period: r.period,
      parity: r.parity,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      sourceBatchId: r.source_batch_id,
    }));
  }

  /** 批次的暂存行写成模板；ID 由批次与行号决定，重复执行不会产生新 ID */
  insertTemplates(
    batchId: string,
    termId: string,
    rows: readonly {
      line: number;
      teacherId: string;
      classId: string;
      subjectId: string;
      weekday: number;
      period: number;
      parity: string;
      validFrom: string | null;
      validTo: string | null;
    }[],
    dataOrigin: DataOrigin,
  ): string[] {
    const stmt = this.db.prepare(
      `INSERT INTO teaching_template(id, term_id, class_id, teacher_id, subject_id, weekday, period, parity, rotation,
                                     valid_from, valid_to, data_origin, source_batch_id, revoked_at)
       VALUES(?,?,?,?,?,?,?,?, 'NONE', ?,?,?,?, NULL)`,
    );
    const ids: string[] = [];
    for (const r of rows) {
      const id = `TP-${batchId}-${r.line}`;
      stmt.run(
        id,
        termId,
        r.classId,
        r.teacherId,
        r.subjectId,
        r.weekday,
        r.period,
        r.parity,
        r.validFrom,
        r.validTo,
        dataOrigin,
        batchId,
      );
      ids.push(id);
    }
    return ids;
  }

  /** 撤销：只打墓碑，不删除任何行 */
  tombstoneBatchTemplates(batchId: string, at: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM teaching_template WHERE source_batch_id = ? AND revoked_at IS NULL')
      .all(batchId) as Array<{ id: string }>;
    this.db
      .prepare('UPDATE teaching_template SET revoked_at = ? WHERE source_batch_id = ? AND revoked_at IS NULL')
      .run(at, batchId);
    return rows.map((r) => r.id);
  }

  /** 覆盖发布：给本学期现有模板整体打墓碑（不删除） */
  tombstoneTermTemplates(termId: string, at: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM teaching_template WHERE term_id = ? AND revoked_at IS NULL')
      .all(termId) as Array<{ id: string }>;
    this.db
      .prepare('UPDATE teaching_template SET revoked_at = ? WHERE term_id = ? AND revoked_at IS NULL')
      .run(at, termId);
    return rows.map((r) => r.id);
  }

  execTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  addRevocationMarker(marker: {
    id: string;
    batchId: string;
    templateId: string;
    reason: string;
    createdAt: string;
  }): void {
    this.db
      .prepare('INSERT INTO revocation_marker(id, batch_id, template_id, reason, created_at) VALUES(?,?,?,?,?)')
      .run(marker.id, marker.batchId, marker.templateId, marker.reason, marker.createdAt);
  }

  countRevocationMarkers(batchId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM revocation_marker WHERE batch_id = ?')
      .get(batchId) as { n: number };
    return row.n;
  }

  /** 模板表指纹：用于断言"正式数据未被改动" */
  templateFingerprint(termId: string): string {
    const rows = this.db
      .prepare(
        `SELECT id, class_id, teacher_id, subject_id, weekday, period, parity, valid_from, valid_to,
                data_origin, source_batch_id, revoked_at
           FROM teaching_template WHERE term_id = ? ORDER BY id`,
      )
      .all(termId);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  /** 含墓碑在内的模板总数：撤销只打墓碑不删行，用这个数验证 */
  countTemplates(termId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM teaching_template WHERE term_id = ?')
      .get(termId) as { n: number };
    return row.n;
  }

  /** 是否存在模拟数据残留（CFG-08） */
  hasSimulated(termId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM teaching_template WHERE term_id = ? AND data_origin = 'SIMULATED') AS t,
           (SELECT COUNT(*) FROM occurrence WHERE term_id = ? AND data_origin = 'SIMULATED') AS o`,
      )
      .get(termId, termId) as { t: number; o: number };
    return row.t > 0 || row.o > 0;
  }

  /** 显式清除模拟数据：只能由调用方在用户确认后触发，不自动执行 */
  clearSimulated(termId: string): { templates: number; occurrences: number } {
    this.db.exec('BEGIN');
    try {
      const o = this.db
        .prepare(`DELETE FROM occurrence WHERE term_id = ? AND data_origin = 'SIMULATED'`)
        .run(termId);
      const t = this.db
        .prepare(`DELETE FROM teaching_template WHERE term_id = ? AND data_origin = 'SIMULATED'`)
        .run(termId);
      this.db.exec('COMMIT');
      return { templates: Number(t.changes), occurrences: Number(o.changes) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export type ImportBatchStatus =
  | 'VALIDATED'
  | 'REJECTED'
  | 'IMPORTED_NOT_PUBLISHED'
  | 'PUBLISHED'
  | 'REVOKED';

export interface ImportBatchRecord {
  readonly id: string;
  readonly termId: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly parser: string;
  readonly rowCount: number;
  readonly status: ImportBatchStatus;
  readonly dataOrigin: 'IMPORTED_UNVERIFIED';
  readonly uploadedAt: string;
  readonly uploadedBy: string;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly publishMode: 'APPEND' | 'REPLACE' | null;
  readonly rejectedNote: string | null;
}
