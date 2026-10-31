import { afterAll, describe, expect, it } from 'vitest';
import { ROW_SEP, TimetableService, canonicalRow } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { buildRandomCase } from '../helpers/random-snapshot.js';

const db = new CourseDatabase(':memory:');
const service = new TimetableService(db);

afterAll(() => db.close());

interface CaseSummary {
  seed: number;
  teacherRows: string[];
  classRows: string[];
  occurrences: number;
}

function runCase(seed: number): CaseSummary {
  const c = buildRandomCase(seed);
  db.loadSnapshot(c.snapshot);
  const build = service.build(c.snapshot.term.id, c.from, c.to);

  const teacherRows = c.teacherIds.flatMap((id) =>
    db.queryByTeacher(c.snapshot.term.id, id, c.from, c.to).map(canonicalRow),
  );
  const classRows = c.classIds.flatMap((id) =>
    db.queryByClass(c.snapshot.term.id, id, c.from, c.to).map(canonicalRow),
  );
  return { seed, teacherRows, classRows, occurrences: build.occurrenceCount };
}

describe('教师视图 / 班级视图一致性（属性测试）', () => {
  it('1000 组随机校历：两个视角逐行一致，且不重不漏', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const r = runCase(seed);

      const a = [...r.teacherRows].sort().join('\n');
      const b = [...r.classRows].sort().join('\n');
      if (a !== b) {
        throw new Error(`seed=${seed} 教师视图与班级视图不一致`);
      }

      if (r.teacherRows.length !== r.occurrences) {
        throw new Error(
          `seed=${seed} 课次数不一致：视图 ${r.teacherRows.length}，构建 ${r.occurrences}`,
        );
      }

      const unique = new Set(r.teacherRows);
      if (unique.size !== r.teacherRows.length) {
        throw new Error(`seed=${seed} 同一课次在视图中重复出现`);
      }
    }
  }, 180_000);

  it('缺结束时间的课次一律 certainty=UNKNOWN，且不产生 ends_at', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = runCase(seed);
      for (const line of r.teacherRows) {
        const [, , , startsAt, endsAt, certainty] = line.split(ROW_SEP);
        if (certainty === 'KNOWN') {
          if (!startsAt || !endsAt || startsAt === '-' || endsAt === '-') {
            throw new Error(`seed=${seed} KNOWN 课次缺时间: ${line}`);
          }
        } else if (endsAt && endsAt !== '-') {
          throw new Error(`seed=${seed} UNKNOWN 课次不应有结束时间: ${line}`);
        }
      }
    }
  }, 60_000);

  it('轮换课绝不出现推算出的课次', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const c = buildRandomCase(seed);
      db.loadSnapshot(c.snapshot);
      service.build(c.snapshot.term.id, c.from, c.to);

      const customIds = new Set(
        c.snapshot.templates.filter((t) => t.rotation === 'CUSTOM').map((t) => t.id),
      );
      if (customIds.size === 0) continue;
      const rows = db.queryAll(c.snapshot.term.id, c.from, c.to);
      for (const row of rows) {
        if (customIds.has(row.occurrenceId.split('|')[1] ?? '')) {
          throw new Error(`seed=${seed} 轮换课被生成了课次: ${row.occurrenceId}`);
        }
      }
    }
  }, 60_000);
});

describe('重复构建的确定性', () => {
  it('同一份资料构建两次，课次指纹完全一致', () => {
    const c = buildRandomCase(42);
    service.load(c.snapshot);
    service.build(c.snapshot.term.id, c.from, c.to);
    const first = db.occurrenceFingerprint(c.snapshot.term.id);
    service.build(c.snapshot.term.id, c.from, c.to);
    const second = db.occurrenceFingerprint(c.snapshot.term.id);
    expect(second).toBe(first);
  });

  it('重建只影响指定区间，区间外课次保持不变', () => {
    const c = buildRandomCase(7);
    service.load(c.snapshot);
    service.build(c.snapshot.term.id, c.from, c.to);
    const before = db.occurrenceFingerprint(c.snapshot.term.id);

    const mid = c.from;
    service.build(c.snapshot.term.id, mid, mid);
    const after = db.occurrenceFingerprint(c.snapshot.term.id);

    // 单日重建结果应与全区间构建一致（派生表无副作用）
    expect(after).toBe(before);
  });
});
