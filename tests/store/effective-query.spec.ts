/**
 * 有效课次投影的等价性测试。
 *
 * 这层 SQL 从 `COALESCE(st.x, o.x)` 改成了 base ∪ overlay 两段，目的是让两段各自命中索引
 * （40k 行从百毫秒级降到个位数毫秒）。改写必须**语义完全一致**，否则推荐会基于错的课表。
 * 这里逐条钉住改写后容易出错的地方：
 *   - 换教师：原教师查不到、新教师查得到；
 *   - 改日期：区间按"生效日期"算，原始日期在区间外也要能查到；
 *   - 停课：标记透传；
 *   - 批量按教师取，与全校取的结果集完全一致。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TimetableService } from '../../src/service/timetable-service.js';
import { ChangeStore } from '../../src/store/change-store.js';
import { CourseDatabase, type TimetableRow } from '../../src/store/database.js';
import { buildRandomCase } from '../helpers/random-snapshot.js';

const databases: CourseDatabase[] = [];

afterAll(() => {
  for (const db of databases) db.close();
});

function setup(seed: number) {
  const db = new CourseDatabase(':memory:');
  databases.push(db);
  const c = buildRandomCase(seed);
  db.loadSnapshot(c.snapshot);
  new TimetableService(db).build(c.snapshot.term.id, c.from, c.to);
  return { db, store: new ChangeStore(db.handle), c, termId: c.snapshot.term.id };
}

function patch(
  store: ChangeStore,
  termId: string,
  row: TimetableRow,
  change: {
    readonly teacherId?: string;
    readonly date?: string;
    readonly period?: number;
    readonly cancelled?: boolean;
  },
): void {
  store.writeAssignment(
    {
      occurrenceId: row.occurrenceId,
      termId,
      classId: row.classId,
      subjectId: row.subjectId,
      teacherId: change.teacherId ?? row.teacherId,
      date: change.date ?? row.date,
      period: change.period ?? row.period,
      cancelled: change.cancelled ?? false,
      version: 1,
      changeId: 'CH-TEST',
    },
    '2026-09-01T00:00:00.000Z',
  );
}

const ids = (rows: readonly TimetableRow[]): string[] =>
  rows.map((r) => r.occurrenceId).sort();

describe('有效课次投影（base ∪ overlay）', () => {
  it('换教师后，原教师查不到，新教师查得到且姓名跟着换', () => {
    const { db, store, c, termId } = setup(11);
    const row = db.queryAll(termId, c.from, c.to)[0]!;
    const other = c.teacherIds.find((id) => id !== row.teacherId)!;

    patch(store, termId, row, { teacherId: other });

    expect(ids(db.queryByTeacher(termId, row.teacherId, c.from, c.to))).not.toContain(
      row.occurrenceId,
    );
    const moved = db
      .queryByTeacher(termId, other, c.from, c.to)
      .find((r) => r.occurrenceId === row.occurrenceId);
    expect(moved).toBeDefined();
    expect(moved?.teacherId).toBe(other);
    expect(moved?.teacherName).not.toBe(row.teacherName);
  });

  it('改期后按生效日期出现在新区间，原始日期查不到', () => {
    const { db, store, c, termId } = setup(12);
    const row = db.queryAll(termId, c.from, c.to)[0]!;
    // 目标日期放到学期最后一天之后，保证与原始日期不在同一个单日区间
    const target = `${c.to.slice(0, 4)}-12-31`;

    patch(store, termId, row, { date: target });

    // 单个日期作为区间：原始日期已不在区间内，只有第 2 段（按 st.date）能取到
    expect(ids(db.queryByTeacher(termId, row.teacherId, row.date, row.date))).not.toContain(
      row.occurrenceId,
    );
    expect(ids(db.queryByTeacher(termId, row.teacherId, target, target))).toContain(
      row.occurrenceId,
    );
    expect(ids(db.queryAll(termId, target, target))).toContain(row.occurrenceId);
  });

  it('停课标记透传，且仍出现在查询结果里（由上层决定如何处理）', () => {
    const { db, store, c, termId } = setup(13);
    const row = db.queryAll(termId, c.from, c.to)[0]!;

    patch(store, termId, row, { cancelled: true });

    const found = db
      .queryByTeacher(termId, row.teacherId, c.from, c.to)
      .find((r) => r.occurrenceId === row.occurrenceId);
    expect(found?.cancelled).toBe(true);
  });

  it('批量按教师取，与全校取的结果集逐行一致（含变更）', () => {
    for (const seed of [21, 22, 23]) {
      const { db, store, c, termId } = setup(seed);
      const all = db.queryAll(termId, c.from, c.to);
      // 每 3 行改一次：换教师 / 改节次 / 停课，务必让两段分支都跑到
      all.slice(0, 9).forEach((row, i) => {
        const other = c.teacherIds.find((id) => id !== row.teacherId)!;
        if (i % 3 === 0) patch(store, termId, row, { teacherId: other });
        else if (i % 3 === 1) patch(store, termId, row, { period: (row.period % 8) + 1 });
        else patch(store, termId, row, { cancelled: true });
      });

      const expected = db.queryAll(termId, c.from, c.to).map(canonical);
      const batch = db
        .queryByTeachers(termId, c.teacherIds, c.from, c.to)
        .map(canonical);

      expect(batch.sort()).toEqual(expected.sort());
    }
  });
});

/** 只比较内容，不比顺序：批量接口不保证顺序（省掉整段排序）。 */
function canonical(r: TimetableRow): string {
  return [
    r.occurrenceId,
    r.date,
    r.period,
    r.classId,
    r.className,
    r.teacherId,
    r.teacherName,
    r.subjectId,
    r.subjectName,
    r.cancelled ? '1' : '0',
  ].join('|');
}
