/**
 * 课表视图必须叠加"已生效变更"。
 *
 * 只读派生课次的实现会让教师在调课生效后仍看到自己是任课人——
 * 界面与审计事实相反，属于最容易被当成"数据显示错误"而忽视的缺陷。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPrincipal, type Principal } from '../../src/auth/principal.js';
import { ChangeService } from '../../src/service/change-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import type { ActiveAssignment } from '../../src/store/change-store.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

let db: CourseDatabase;
let timetable: TimetableService;
let changes: ChangeService;
let seq = 0;

function teacher(teacherId: string): Principal {
  return mintPrincipal({
    userId: `U-${teacherId}`,
    teacherId,
    displayName: teacherId,
    roles: ['T'],
    actingRole: 'T',
    sessionId: `S-${teacherId}`,
    mustChangePassword: false,
  });
}

function active(): ActiveAssignment[] {
  return changes.activeAssignments(TERM).filter((a) => !a.cancelled);
}

beforeEach(() => {
  seq = 0;
  db = new CourseDatabase(':memory:');
  timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(TERM, FROM, TO);
  changes = new ChangeService(db, {
    now: () => '2026-10-31T10:00:00.000Z',
    newId: () => `ID-${(seq += 1)}`,
  });
});

afterEach(() => db.close());

describe('课表叠加已生效变更', () => {
  it('改派生效后：原教师视图移除、新教师视图出现、班级视图换人', () => {
    const all = active();
    const teachers = [...new Set(all.map((a) => a.teacherId))];
    const busy = (id: string, date: string, period: number): boolean =>
      all.some((x) => x.teacherId === id && x.date === date && x.period === period);

    let target: ActiveAssignment | null = null;
    let to: string | null = null;
    for (const occ of all) {
      const candidate = teachers.find(
        (t) => t !== occ.teacherId && !busy(t, occ.date, occ.period),
      );
      if (candidate) {
        target = occ;
        to = candidate;
        break;
      }
    }
    expect(target).not.toBeNull();
    expect(to).not.toBeNull();
    const occ = target as ActiveAssignment;
    const toTeacher = to as string;
    const fromTeacher = occ.teacherId;

    const submitted = changes.submitNew({
      termId: TERM,
      principal: teacher(fromTeacher),
      items: [
        {
          occurrenceId: occ.occurrenceId,
          kind: 'REASSIGN',
          toTeacherId: toTeacher,
          toDate: null,
          toPeriod: null,
        },
      ],
      reason: null,
      idempotencyKey: 'OVERLAY-1',
    });
    expect(submitted.status).toBe('PENDING_CONFIRMATION');

    for (const confirmer of submitted.required) {
      changes.decide(submitted.caseId as string, teacher(confirmer), 'ACCEPT');
    }

    expect(changes.getCase(submitted.caseId as string)?.status).toBe('EFFECTIVE');

    const fromView = timetable.teacherView(TERM, fromTeacher, FROM, TO);
    expect(fromView.rows.some((r) => r.occurrenceId === occ.occurrenceId)).toBe(false);

    const toView = timetable.teacherView(TERM, toTeacher, FROM, TO);
    const moved = toView.rows.find((r) => r.occurrenceId === occ.occurrenceId);
    expect(moved).toBeDefined();
    expect(moved?.teacherId).toBe(toTeacher);
    expect(moved?.teacherName).not.toBe(fromTeacher);

    const classView = timetable.classView(TERM, occ.classId, FROM, TO);
    const sameSlot = classView.rows.find((r) => r.occurrenceId === occ.occurrenceId);
    expect(sameSlot?.teacherId).toBe(toTeacher);
  });

  it('停课生效后：课次仍可见但标记 cancelled，教师视图不再把它当作有课', () => {
    const occ = active()[0] as ActiveAssignment;
    const submitted = changes.submitNew({
      termId: TERM,
      principal: teacher(occ.teacherId),
      items: [
        {
          occurrenceId: occ.occurrenceId,
          kind: 'CANCEL',
          toTeacherId: null,
          toDate: null,
          toPeriod: null,
        },
      ],
      reason: null,
      idempotencyKey: 'OVERLAY-2',
    });
    for (const confirmer of submitted.required) {
      changes.decide(submitted.caseId as string, teacher(confirmer), 'ACCEPT');
    }

    const view = timetable.teacherView(TERM, occ.teacherId, FROM, TO);
    const row = view.rows.find((r) => r.occurrenceId === occ.occurrenceId);
    expect(row).toBeDefined();
    expect(row?.cancelled).toBe(true);
  });

  it('重建派生课次不会抹掉已生效变更', () => {
    const occ = active()[0] as ActiveAssignment;
    const submitted = changes.submitNew({
      termId: TERM,
      principal: teacher(occ.teacherId),
      items: [
        {
          occurrenceId: occ.occurrenceId,
          kind: 'CANCEL',
          toTeacherId: null,
          toDate: null,
          toPeriod: null,
        },
      ],
      reason: null,
      idempotencyKey: 'OVERLAY-3',
    });
    for (const confirmer of submitted.required) {
      changes.decide(submitted.caseId as string, teacher(confirmer), 'ACCEPT');
    }

    timetable.build(TERM, FROM, TO);
    const row = timetable
      .teacherView(TERM, occ.teacherId, FROM, TO)
      .rows.find((r) => r.occurrenceId === occ.occurrenceId);
    expect(row?.cancelled).toBe(true);
  });
});
