import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  BellEntry,
  CalendarException,
  DataOrigin,
  ExceptionKind,
  Occurrence,
  SchoolSnapshot,
  TemplateParity,
  Weekday,
  WeekParity,
} from '../domain/model.js';

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
  data_origin  TEXT NOT NULL CHECK (data_origin IN ('SIMULATED','IMPORTED_UNVERIFIED','OFFICIAL'))
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
}

const SELECT_TIMETABLE = `
SELECT o.id             AS occurrence_id,
       o.date           AS date,
       o.period         AS period,
       o.starts_at      AS starts_at,
       o.ends_at        AS ends_at,
       o.certainty      AS certainty,
       o.unknown_reason AS unknown_reason,
       o.class_id       AS class_id,
       c.display_name   AS class_name,
       o.teacher_id     AS teacher_id,
       t.display_name   AS teacher_name,
       o.subject_id     AS subject_id,
       s.name           AS subject_name,
       o.data_origin    AS data_origin
  FROM occurrence o
  JOIN school_class c ON c.id = o.class_id
  JOIN teacher t      ON t.id = o.teacher_id
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
  };
}

export class CourseDatabase {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(DDL);
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', 'p2-1');
  }

  close(): void {
    this.db.close();
  }

  /** 仅供测试：清空全部表，不改结构。 */
  clearAll(): void {
    for (const table of [
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
           FROM teaching_template WHERE term_id = ? ORDER BY weekday, period, class_id`,
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
          WHERE o.term_id = ? AND o.teacher_id = ? AND o.date BETWEEN ? AND ?
          ORDER BY o.date, o.period, o.class_id, o.id`,
      )
      .all(termId, teacherId, from, to) as unknown as RawTimetableRow[];
    return rows.map(toRow);
  }

  queryByClass(termId: string, classId: string, from: string, to: string): TimetableRow[] {
    const rows = this.db
      .prepare(
        `${SELECT_TIMETABLE}
          WHERE o.term_id = ? AND o.class_id = ? AND o.date BETWEEN ? AND ?
          ORDER BY o.date, o.period, o.teacher_id, o.id`,
      )
      .all(termId, classId, from, to) as unknown as RawTimetableRow[];
    return rows.map(toRow);
  }

  queryAll(termId: string, from: string, to: string): TimetableRow[] {
    const rows = this.db
      .prepare(
        `${SELECT_TIMETABLE}
          WHERE o.term_id = ? AND o.date BETWEEN ? AND ?
          ORDER BY o.date, o.period, o.class_id, o.id`,
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
}
