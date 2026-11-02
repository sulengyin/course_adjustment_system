import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPrincipal, type Principal } from '../../src/auth/principal.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

let db: CourseDatabase;
let service: CandidateService;

function teacher(teacherId: string | null): Principal {
  return mintPrincipal({
    userId: `U-${teacherId ?? 'admin'}`,
    teacherId,
    displayName: teacherId ?? '管理员',
    roles: ['T'],
    actingRole: 'T',
    sessionId: 'S-1',
    mustChangePassword: false,
  });
}

beforeEach(() => {
  db = new CourseDatabase(':memory:');
  const timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(TERM, FROM, TO);
  service = new CandidateService(db);
});

afterEach(() => db.close());

function firstOccurrence() {
  const row = db.queryAll(TERM, FROM, TO).find((r) => !r.cancelled);
  if (!row) throw new Error('虚构样本中没有课次');
  return row;
}

describe('调课候选推荐服务', () => {
  it('本人课次给出候选，且不含本人', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId));
    expect(result.ok).toBe(true);
    expect(result.occurrence?.occurrenceId).toBe(occ.occurrenceId);
    expect(result.candidates.length).toBe(db.refs().teachers.length - 1);
    expect(result.candidates.some((c) => c.teacherId === occ.teacherId)).toBe(false);
  });

  it('该节次有课的判定与当天课表一致', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId));
    const busy = new Set(
      db
        .queryAll(TERM, occ.date, occ.date)
        .filter((r) => !r.cancelled && r.period === occ.period)
        .map((r) => r.teacherId),
    );
    for (const candidate of result.candidates) {
      expect(candidate.freeAtSlot).toBe(!busy.has(candidate.teacherId));
    }
  });

  it('无课的候选排在有课的候选之前，同组内按分数降序', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId));
    const free = result.candidates.filter((c) => c.freeAtSlot);
    const busy = result.candidates.filter((c) => !c.freeAtSlot);
    expect(free.length + busy.length).toBe(result.candidates.length);
    const firstBusyIndex = result.candidates.findIndex((c) => !c.freeAtSlot);
    if (firstBusyIndex >= 0) {
      expect(result.candidates.slice(firstBusyIndex).every((c) => !c.freeAtSlot)).toBe(true);
    }
    for (let i = 1; i < free.length; i += 1) expect(free[i - 1]!.score).toBeGreaterThanOrEqual(free[i]!.score);
  });

  it('他人课次拿不到候选名单', () => {
    const occ = firstOccurrence();
    const other = db.refs().teachers.find((t) => t.id !== occ.teacherId);
    expect(other).toBeDefined();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(other!.id));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_OWNER');
    expect(result.candidates).toEqual([]);
  });

  it('课次不存在时不猜测，明确返回未找到', () => {
    const result = service.suggest(TERM, 'NO-SUCH-OCCURRENCE', teacher('T-ANY'));
    expect(result.code).toBe('OCCURRENCE_NOT_FOUND');
  });

  it('没有教师身份的人不给出名单', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(null));
    expect(result.code).toBe('NOT_A_TEACHER');
  });
});

describe('调课候选：偏好生效与目标时段', () => {
  const PREF_BASE = {
    consider: { sameClass: true, sameGrade: true, sameSubject: true, lightLoad: true },
    exclude: {
      busyAtSlot: false,
      consecutive: false,
      consecutiveLimit: 3,
      dayTotal: false,
      dayTotalLimit: 6,
    },
    hint: { classSubjectDay: true, classSubjectDayLimit: 2 },
  };

  it('默认不隐藏任何人', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId));
    expect(result.excluded).toEqual([]);
  });

  it('勾选排除后，被排除的教师连同原因返回', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId), {
      preference: {
        ...PREF_BASE,
        exclude: { ...PREF_BASE.exclude, busyAtSlot: true },
      },
    });
    const busy = new Set(
      db
        .queryAll(TERM, occ.date, occ.date)
        .filter((r) => !r.cancelled && r.period === occ.period)
        .map((r) => r.teacherId),
    );
    for (const c of result.candidates) expect(c.freeAtSlot).toBe(true);
    for (const e of result.excluded) {
      expect(busy.has(e.teacherId)).toBe(true);
      expect(e.reasons.join('；')).toContain('该节次本人有课');
      expect(e.teacherName).not.toBeNull();
    }
    expect(result.candidates.length + result.excluded.length).toBe(db.refs().teachers.length - 1);
  });

  it('换时间的方案按目标时段评估，不按原时段', () => {
    const occ = firstOccurrence();
    const targetDate = '2026-11-05';
    const targetPeriod = 2;
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId), {
      toDate: targetDate,
      toPeriod: targetPeriod,
    });
    expect(result.ok).toBe(true);
    expect(result.evaluatedAt).toEqual({ date: targetDate, period: targetPeriod });

    const busy = new Set(
      db
        .queryAll(TERM, targetDate, targetDate)
        .filter((r) => !r.cancelled && r.period === targetPeriod)
        .map((r) => r.teacherId),
    );
    for (const c of result.candidates) {
      expect(c.freeAtSlot).toBe(!busy.has(c.teacherId));
    }
  });
});
