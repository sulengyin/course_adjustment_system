import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPrincipal, type Principal } from '../../src/auth/principal.js';
import type { SchoolSnapshot } from '../../src/domain/model.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

let db: CourseDatabase;
let service: CandidateService;

/**
 * 固定"今天"。服务现在会过滤掉已过去的课次，用真实时钟会让这些用例在学期结束后集体变红。
 * 用本地中午构造再转 ISO：无论跑在哪个时区，取回的本地日期都是同一天。
 */
function at(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

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
  // 学期开始前一天：全部课次都在"未来"
  service = new CandidateService(db, { now: () => at(2026, 8, 30) });
});

afterEach(() => db.close());

function firstOccurrence() {
  const row = db.queryAll(TERM, FROM, TO).find((r) => !r.cancelled);
  if (!row) throw new Error('虚构样本中没有课次');
  return row;
}

/** 找一节"同一时段还有别的教师在上课"的课次；演示排课无冲突时退回第一节。 */
function occurrenceWithCollision() {
  for (const row of db.queryAll(TERM, FROM, TO)) {
    if (row.cancelled) continue;
    const busyElsewhere = db
      .queryAll(TERM, row.date, row.date)
      .some((o) => !o.cancelled && o.period === row.period && o.teacherId !== row.teacherId);
    if (busyElsewhere) return row;
  }
  return firstOccurrence();
}

describe('代课候选推荐服务', () => {
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

describe('代课候选：偏好生效与目标时段', () => {
  const PREF_BASE = {
    consider: { sameClass: true, sameGrade: true, sameSubject: true, lightLoad: true },
    exclude: {
      consecutive: false,
      consecutiveLimit: 3,
      dayTotal: false,
      dayTotalLimit: 6,
    },
    hint: { classSubjectDay: true, classSubjectDayLimit: 2 },
  };

  it('候选里不出现该节次有课的人；被排除者连同原因返回', () => {
    const occ = occurrenceWithCollision();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId));
    const busy = new Set(
      db
        .queryAll(TERM, occ.date, occ.date)
        .filter((r) => !r.cancelled && r.period === occ.period)
        .map((r) => r.teacherId),
    );
    // 候选里每个人在目标节次都没课；有课的人一个都不能混进来
    for (const c of result.candidates) {
      expect(c.freeAtSlot).toBe(true);
      expect(busy.has(c.teacherId)).toBe(false);
    }
    // 被排除的人也必须是撞课的，并写明原因，不允许悄悄消失
    for (const e of result.excluded) {
      expect(busy.has(e.teacherId)).toBe(true);
      expect(e.reasons.join('；')).toContain('该节次本人有课');
      expect(e.teacherName).not.toBeNull();
    }
    expect(result.candidates.length + result.excluded.length).toBe(
      db.refs().teachers.length - 1,
    );
  });

  it('偏好只影响连堂与总量阈值，不会把撞课的教师放回候选', () => {
    const occ = firstOccurrence();
    const result = service.suggest(TERM, occ.occurrenceId, teacher(occ.teacherId), {
      preference: {
        ...PREF_BASE,
        exclude: { ...PREF_BASE.exclude, consecutive: false, dayTotal: false },
      },
    });
    for (const c of result.candidates) expect(c.freeAtSlot).toBe(true);
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
      expect(c.freeAtSlot).toBe(true);
      expect(busy.has(c.teacherId)).toBe(false);
    }
  });

  it('按科目名认定语数教师：空课日接第4节时给出提示，非语数教师不提示', () => {
    // 虚构样本里 T01 教语文、T02 教数学，T03 教英语；周四只有 T01 的第4节。
    const occ = db
      .queryAll(TERM, FROM, TO)
      .find((r) => !r.cancelled && r.teacherId === 'T01' && r.period === 4);
    if (!occ) throw new Error('虚构样本中没有周四第4节的课次');

    const result = service.suggest(TERM, occ.occurrenceId, teacher('T01'));
    expect(result.ok).toBe(true);

    const t02 = result.candidates.find((c) => c.teacherId === 'T02');
    expect(t02?.hints.join('；')).toContain('当天只有上午第4节');

    const t03 = result.candidates.find((c) => c.teacherId === 'T03');
    expect(t03?.hints.join('；') ?? '').not.toContain('当天只有上午第4节');
  });
});

describe('跨天对调：先选人，再选对方可让出的课次', () => {
  it('列出对方课次并算清让出后当天还剩几节', () => {
    // T02 是数学教师；T01 的周四第4节是 T01 当天唯一一节课。
    const mine = db
      .queryAll(TERM, FROM, TO)
      .find((r) => !r.cancelled && r.teacherId === 'T02' && r.period === 2);
    if (!mine) throw new Error('虚构样本中没有 T02 的课次');

    const result = service.swapOptions(TERM, mine.occurrenceId, 'T01', teacher('T02'));
    expect(result.ok).toBe(true);
    expect(result.counterpart?.teacherId).toBe('T01');

    // T01 周四第4节：让出后当天一节不剩，语数教师 → 提示
    const thu = result.options.find((o) => o.period === 4);
    expect(thu?.remainingCount).toBe(0);
    expect(thu?.hints.join('；')).toContain('对调后该教师当天没有课');

    // 同一时段还有另一节课的对调不可选，原因照实返回
    for (const option of result.options) {
      expect(option.occurrenceId).not.toBe(mine.occurrenceId);
    }
  });

  it('不是自己的课次不给对调选项', () => {
    const mine = db
      .queryAll(TERM, FROM, TO)
      .find((r) => !r.cancelled && r.teacherId === 'T01' && r.period === 4);
    if (!mine) throw new Error('虚构样本中没有 T01 的周四第4节');
    const result = service.swapOptions(TERM, mine.occurrenceId, 'T02', teacher('T02'));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_OWNER');
  });
});

describe('对调对象推荐：只推荐同班教师，具体到日期 + 节次', () => {
  function c1LessonOfT01() {
    const row = db
      .queryAll(TERM, FROM, TO)
      .find((r) => !r.cancelled && r.classId === 'C1' && r.teacherId === 'T01');
    if (!row) throw new Error('虚构样本中没有 C1 的 T01 课次');
    return row;
  }

  it('推荐组只含本学期任教该班的教师，且每人都落到具体课次', () => {
    const occ = c1LessonOfT01();
    const r = service.swapCandidates(TERM, occ.occurrenceId, teacher('T01'));
    expect(r.ok).toBe(true);

    const c1Teachers = new Set(['T01', 'T02', 'T03', 'T04']);
    expect(r.recommended.length).toBeGreaterThan(0);
    for (const c of r.recommended) {
      expect(c1Teachers.has(c.teacherId)).toBe(true);
      expect(c.teacherId).not.toBe('T01');
      expect(c.tier).toBe('SAME_CLASS');
      // “具体到日期 + 第几节”：不能只给一个人名
      expect(c.sampleOptions.length).toBeGreaterThan(0);
      for (const o of c.sampleOptions) {
        expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(o.period).toBeGreaterThan(0);
        expect(o.blockedReasons).toEqual([]);
      }
    }
  });

  it('不推荐的教师逐个给理由，且没有人在名单里消失', () => {
    const occ = c1LessonOfT01();
    const r = service.swapCandidates(TERM, occ.occurrenceId, teacher('T01'));

    for (const c of r.notRecommended) {
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(c.viableCount).toBe(0);
    }
    for (const c of r.notRecommended.filter((x) => x.tier !== 'SAME_CLASS')) {
      expect(c.reasons[0]?.includes('本学期不任教该班')).toBe(true);
    }

    const listed = [...r.recommended, ...r.notRecommended].map((c) => c.teacherId);
    expect(new Set(listed).size).toBe(db.refs().teachers.length - 1);
  });

  it('不是自己的课次不给名单', () => {
    const occ = c1LessonOfT01();
    const r = service.swapCandidates(TERM, occ.occurrenceId, teacher('T02'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_OWNER');
  });
});

describe('对调的两条硬性前提：已发生的课不能调、时长不等不能换', () => {
  /**
   * 演示样本原本第 4 节是 40 分钟，与真实作息不符（真实库第 4 节 11:20–11:40 只有 20 分钟）。
   * 这里单独造一份"第 4 节 20 分钟"的样本，并给 T04 加一节周五第 4 节，
   * 用来验证"第 4 节只能换第 4 节"而不影响其它用例。
   */
  const P4_SNAPSHOT: SchoolSnapshot = {
    ...DEMO_SNAPSHOT,
    bell: DEMO_SNAPSHOT.bell.map((b) => (b.period === 4 ? { ...b, endsAt: '11:00' } : b)),
    templates: [
      ...DEMO_SNAPSHOT.templates,
      {
        id: 'TP-TEST-P4',
        termId: TERM,
        classId: 'C2',
        teacherId: 'T04',
        subjectId: 'S-TY',
        weekday: 5,
        period: 4,
        parity: 'ALL',
        rotation: 'NONE',
        validFrom: null,
        validTo: null,
        dataOrigin: 'SIMULATED',
      },
    ],
  };

  let local: CourseDatabase;
  let svc: CandidateService;

  beforeEach(() => {
    local = new CourseDatabase(':memory:');
    const timetable = new TimetableService(local);
    timetable.load(P4_SNAPSHOT);
    timetable.build(TERM, FROM, TO);
    svc = new CandidateService(local, { now: () => at(2026, 8, 30) });
  });

  afterEach(() => local.close());

  function occurrenceOf(templateId: string) {
    const prefix = `${TERM}|${templateId}|`;
    const row = local.queryAll(TERM, FROM, TO).find((r) => r.occurrenceId.startsWith(prefix));
    if (!row) throw new Error(`样本中没有 ${templateId} 的课次`);
    return row;
  }

  it('20 分钟的第 4 节只能和同样 20 分钟的第 4 节对调', () => {
    const mine = occurrenceOf('TP-10'); // 周四第 4 节，20 分钟
    const r = svc.swapOptions(TERM, mine.occurrenceId, 'T04', teacher('T01'));

    const p4 = r.options.filter((o) => o.period === 4);
    expect(p4.length).toBeGreaterThan(0);
    for (const o of p4) expect(o.blockedReasons).toEqual([]);

    const others = r.options.filter((o) => o.period !== 4);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      // 40 分钟的课、以及缺结束时间的课（第 5 节）都必须挡在"时长"这一关
      expect(o.blockedReasons.some((x) => x.includes('时长'))).toBe(true);
    }
  });

  it('40 分钟的课不能拿来换 20 分钟的第 4 节', () => {
    const mine = occurrenceOf('TP-01'); // 周一第 1 节，40 分钟
    const r = svc.swapOptions(TERM, mine.occurrenceId, 'T04', teacher('T01'));

    const p4 = r.options.filter((o) => o.period === 4);
    expect(p4.length).toBeGreaterThan(0);
    for (const o of p4) {
      expect(o.blockedReasons.some((x) => x.includes('时长不等'))).toBe(true);
    }

    // 同为 40 分钟的第 2 节仍然可选：不是"一律不能跨节次换"
    const p2 = r.options.find((o) => o.period === 2);
    expect(p2?.blockedReasons).toEqual([]);
  });

  it('缺结束时间、算不出时长的课次不可对调，并写明原因', () => {
    const mine = occurrenceOf('TP-01');
    const r = svc.swapOptions(TERM, mine.occurrenceId, 'T04', teacher('T01'));
    const p5 = r.options.find((o) => o.period === 5);
    expect(p5?.blockedReasons.some((x) => x.includes('缺少起止时间'))).toBe(true);
  });

  it('对方已经过去的课次不出现在可选列表里', () => {
    const svcSep = new CandidateService(local, { now: () => at(2026, 9, 20) });
    const mine = local
      .queryAll(TERM, FROM, TO)
      .find((r) => r.occurrenceId.startsWith(`${TERM}|TP-10|`) && r.date >= '2026-09-20');
    if (!mine) throw new Error('样本中没有 9 月 20 日之后的课次');

    const r = svcSep.swapOptions(TERM, mine.occurrenceId, 'T04', teacher('T01'));
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) expect(o.date >= '2026-09-20').toBe(true);

    // 确认确实有被过滤掉的过去课次，否则这条断言等于没测
    const past = local
      .queryByTeacher(TERM, 'T04', FROM, TO)
      .filter((x) => !x.cancelled && x.date < '2026-09-20');
    expect(past.length).toBeGreaterThan(0);
  });

  it('我这节课已经过去时，列出的每个课次都不可选并说明原因', () => {
    const svcSep = new CandidateService(local, { now: () => at(2026, 9, 20) });
    const mine = occurrenceOf('TP-01'); // 2026-08-31，已过去
    const r = svcSep.swapOptions(TERM, mine.occurrenceId, 'T04', teacher('T01'));
    expect(r.ok).toBe(true);
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      expect(o.blockedReasons.join('')).toContain('已经过去');
    }
  });

  it('推荐名单同样不把已过去的课次算进可选数量', () => {
    const svcSep = new CandidateService(local, { now: () => at(2026, 9, 20) });
    const mine = local
      .queryAll(TERM, FROM, TO)
      .find((r) => r.occurrenceId.startsWith(`${TERM}|TP-10|`) && r.date >= '2026-09-20');
    if (!mine) throw new Error('样本中没有 9 月 20 日之后的课次');

    const r = svcSep.swapCandidates(TERM, mine.occurrenceId, teacher('T01'));
    expect(r.ok).toBe(true);
    for (const c of [...r.recommended, ...r.notRecommended]) {
      for (const o of c.sampleOptions) expect(o.date >= '2026-09-20').toBe(true);
    }
  });
});
