import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

let db: CourseDatabase;
let service: TimetableService;
const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

beforeEach(() => {
  db = new CourseDatabase(':memory:');
  service = new TimetableService(db);
  service.load(DEMO_SNAPSHOT);
});

afterEach(() => db.close());

describe('只读课表（虚构样本）', () => {
  it('构建后教师视图返回该教师的课次', () => {
    service.build(TERM, FROM, TO);
    const view = service.teacherView(TERM, 'T01', FROM, TO);
    expect(view.rows.length).toBeGreaterThan(0);
    for (const row of view.rows) {
      expect(row.teacherId).toBe('T01');
      expect(row.teacherName).toBe('示例教师甲');
    }
  });

  it('班级视图与教师视图对同一课次给出同一时间', () => {
    service.build(TERM, FROM, TO);
    const teacherView = service.teacherView(TERM, 'T02', FROM, TO);
    const classView = service.classView(TERM, 'C1', FROM, TO);
    const key = teacherView.rows[0]!;
    const peer = classView.rows.find((r) => r.occurrenceId === key.occurrenceId);
    expect(peer).toBeDefined();
    expect(peer?.date).toBe(key.date);
    expect(peer?.period).toBe(key.period);
    expect(peer?.startsAt).toBe(key.startsAt);
    expect(peer?.endsAt).toBe(key.endsAt);
    expect(peer?.certainty).toBe(key.certainty);
  });

  it('第 5 节只有开始时间：ends_at 为空且 certainty=UNKNOWN', () => {
    service.build(TERM, FROM, TO);
    const rows = service.teacherView(TERM, 'T04', FROM, TO).rows.filter((r) => r.period === 5);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.startsAt).toBe('13:30');
      expect(r.endsAt).toBeNull();
      expect(r.certainty).toBe('UNKNOWN');
      expect(r.unknownReason).toBe('BELL_END_NOT_CONFIGURED');
    }
  });

  it('轮换课不生成课次，视图显式返回未决项', () => {
    service.build(TERM, FROM, TO);
    const view = service.teacherView(TERM, 'T03', FROM, TO);
    expect(view.rows.some((r) => r.occurrenceId.includes('TP-07'))).toBe(false);
    expect(view.unresolved.length).toBeGreaterThan(0);
    expect(view.unresolved.every((u) => u.contractCode === 'UNKNOWN_ROTATION')).toBe(true);
    expect(view.complete).toBe(false);
  });

  it('无法判定的日期在视图中显式列出，不当作"没课"', () => {
    const build = service.build(TERM, FROM, TO);
    const dates = build.unknownDays.map((d) => d.date);
    expect(dates).toContain('2026-09-15');
    expect(dates).toContain('2026-12-02');

    const view = service.teacherView(TERM, 'T01', FROM, TO);
    expect(view.unknownDays.map((d) => d.date)).toContain('2026-12-02');
    expect(view.complete).toBe(false);
  });

  it('冲突报告：教师同一时段两个班为硬冲突', () => {
    const build = service.build(TERM, FROM, TO);
    const teacherConflicts = build.conflicts.hard.filter((c) => c.kind === 'TEACHER');
    expect(teacherConflicts.length).toBeGreaterThan(0);
    // 2026-08-31 周一第 1 节 T01 同时给 C1/C2
    const first = teacherConflicts.find((c) => c.date === '2026-08-31' && c.period === 1);
    expect(first).toBeDefined();
    expect(first?.occurrenceIds).toEqual(['TERM-2026-FALL|TP-01|2026-08-31', 'TERM-2026-FALL|TP-04|2026-08-31']);
  });

  it('explainDay 说明某天为什么没有课', () => {
    expect(service.explainDay(TERM, '2026-10-01')).toMatchObject({ status: 'HOLIDAY' });
    expect(service.explainDay(TERM, '2026-12-02')).toMatchObject({
      status: 'UNKNOWN_CALENDAR',
      reason: 'MAKEUP_WEEKDAY_NOT_SPECIFIED',
    });
    expect(service.explainDay(TERM, '2026-10-10')).toMatchObject({
      status: 'CLASS_DAY',
      weekday: 4,
    });
    expect(service.explainDay(TERM, '2026-08-30')).toMatchObject({ status: 'OUTSIDE_TERM' });
  });

  it('V2.3 必测 7：应急登记不改动课表', () => {
    service.build(TERM, FROM, TO);
    const before = db.occurrenceFingerprint(TERM);
    // 记录本身是存储层事实；"谁有权登记"由 P6 的权限矩阵决定（当前 R 角色 TBD_BLOCKED）。
    db.insertEmergencyNote({
      id: 'NOTE-1',
      termId: TERM,
      date: '2026-09-07',
      period: 2,
      classId: 'C1',
      note: '口头告知：由代课教师临时顶课',
      recordedBy: 'U-COORD',
      recordedAt: '2026-09-07T07:30:00Z',
    });
    expect(db.countEmergencyNotes()).toBe(1);
    expect(db.occurrenceFingerprint(TERM)).toBe(before);

    const rows = service.teacherView(TERM, 'T02', FROM, TO).rows;
    expect(rows.some((r) => r.date === '2026-09-07' && r.period === 2)).toBe(true);
  });

  it('模拟数据永远不会变成正式数据', () => {
    service.build(TERM, FROM, TO);
    const rows = db.queryAll(TERM, FROM, TO);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.dataOrigin).toBe('SIMULATED');
  });
});
