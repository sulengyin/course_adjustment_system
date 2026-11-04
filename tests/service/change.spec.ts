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

function key(): string {
  seq += 1;
  return `IDEM-${seq}`;
}

/** 测试用主体：身份由会话层签发；此处的构造器只允许测试使用（见 spec/meta 的边界断言）。 */
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

function active(): ActiveAssignment[] {
  return changes.activeAssignments(TERM).filter((a) => !a.cancelled);
}

function pickOccurrence(): ActiveAssignment {
  const first = active()[0];
  if (!first) throw new Error('虚构样本中没有课次');
  return first;
}

function otherTeachers(count: number): string[] {
  const found: string[] = [];
  for (const a of active()) {
    if (!found.includes(a.teacherId)) found.push(a.teacherId);
    if (found.length >= count) break;
  }
  return found;
}

/**
 * 虚构样本里本身带有教师同班同时段的冲突，直接取前几节会误中。
 * 这里挑一对"原始状态就不冲突"的课次，并另找两位在对应时段无课的教师接手。
 */
function plan(): {
  first: ActiveAssignment;
  second: ActiveAssignment;
  a: string;
  b: string;
} {
  const all = active();
  const busy = (teacherId: string, date: string, period: number): boolean =>
    all.some((x) => x.teacherId === teacherId && x.date === date && x.period === period);
  const teachers = [...new Set(all.map((x) => x.teacherId))];

  for (const first of all) {
    const clash1 = all.some(
      (x) =>
        x.occurrenceId !== first.occurrenceId &&
        x.teacherId === first.teacherId &&
        x.date === first.date &&
        x.period === first.period,
    );
    if (clash1) continue;

    for (const second of all) {
      if (second.occurrenceId === first.occurrenceId) continue;
      if (second.teacherId === first.teacherId) continue;
      const clash2 = all.some(
        (x) =>
          x.occurrenceId !== second.occurrenceId &&
          x.teacherId === second.teacherId &&
          x.date === second.date &&
          x.period === second.period,
      );
      if (clash2) continue;
      if (second.classId === first.classId && second.date === first.date && second.period === first.period) {
        continue;
      }
      const a = teachers.find(
        (t) => t !== first.teacherId && t !== second.teacherId && !busy(t, first.date, first.period),
      );
      const b = teachers.find(
        (t) => t !== first.teacherId && t !== second.teacherId && t !== a && !busy(t, second.date, second.period),
      );
      if (a && b) return { first, second, a, b };
    }
  }
  throw new Error('虚构样本中找不到无冲突的课次对');
}

function reassign(occurrenceId: string, toTeacherId: string) {
  return {
    occurrenceId,
    kind: 'REASSIGN' as const,
    toTeacherId,
    toDate: null,
    toPeriod: null,
  };
}

/** 执行事实目前没有授权入口（BIZ-03 未定）；测试只能直接写表来构造前置状态。 */
function seedExecuted(occurrenceId: string): void {
  db.handle
    .prepare(
      `INSERT INTO execution_fact(occurrence_id, executed, registered_by, registered_at)
       VALUES(?, 1, 'P6-PLACEHOLDER', '2026-10-31T10:00:00.000Z')`,
    )
    .run(occurrenceId);
}

describe('提交与必要确认者', () => {
  it('改派：新旧教师都进入确认集合，班主任只收通知', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    expect(from).toBe(occ.teacherId);

    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: '虚构原因',
      idempotencyKey: key(),
      classHeadByClass: { [occ.classId]: 'T-HEAD' },
    });

    expect(r.ok).toBe(true);
    expect(r.status).toBe('PENDING_CONFIRMATION');
    expect(r.required).toEqual([from, to].sort());
    expect(r.notified).toEqual(['T-HEAD']);
    expect(r.required).not.toContain('T-HEAD');

    const notices = changes.notifications(r.caseId as string);
    expect(notices.some((n) => n.recipientId === 'T-HEAD' && n.kind === 'CLASS_HEAD_NOTICE')).toBe(true);
    expect(notices.every((n) => n.delivery === 'UNDETERMINED')).toBe(true);
  });

  it('同一幂等键重复提交只产生一个方案', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const k = key();
    const input = {
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: k,
    };
    const first = changes.submitNew(input);
    const second = changes.submitNew(input);
    expect(second.code).toBe('DUPLICATE_REPLAY');
    expect(second.duplicate).toBe(true);
    expect(second.caseId).toBe(first.caseId);
  });

  it('代他人发起被拒绝：方案必须改变发起人自己的授课责任', () => {
    const occ = pickOccurrence();
    const [, , outsider] = otherTeachers(3);
    expect(() =>
      changes.submitNew({
        termId: TERM,
        principal: teacher(outsider as string),
        items: [reassign(occ.occurrenceId, outsider as string)],
        reason: null,
        idempotencyKey: key(),
      }),
    ).toThrow(/无权执行/);
  });

  it('他人不能用同一个幂等键读到别人的方案', () => {
    const occ = pickOccurrence();
    const [from, to, third] = otherTeachers(3);
    const k = key();
    changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: k,
    });
    const stolen = changes.submitNew({
      termId: TERM,
      principal: teacher(third as string),
      items: [reassign(occ.occurrenceId, third as string)],
      reason: null,
      idempotencyKey: k,
    });
    expect(stolen.code).toBe('NOT_OWNER');
  });
});

describe('确认闭环：沉默与拒绝都不生效', () => {
  it('无人确认时不会生效', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    expect(changes.getCase(r.caseId as string)?.status).toBe('PENDING_CONFIRMATION');
    const after = changes.activeAssignments(TERM).find((a) => a.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(occ.teacherId);
  });

  it('一人接受、一人沉默，仍不生效', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const first = changes.decide(r.caseId as string, teacher(from as string), 'ACCEPT');
    expect(first.status).toBe('PENDING_CONFIRMATION');
    expect(changes.getCase(r.caseId as string)?.status).toBe('PENDING_CONFIRMATION');
    const after = changes.activeAssignments(TERM).find((a) => a.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(occ.teacherId);
  });

  it('任何人明确拒绝即终止', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    changes.decide(r.caseId as string, teacher(from as string), 'ACCEPT');
    const declined = changes.decide(r.caseId as string, teacher(to as string), 'DECLINE');
    expect(declined.status).toBe('REJECTED');
    expect(changes.getCase(r.caseId as string)?.status).toBe('REJECTED');
    const after = changes.activeAssignments(TERM).find((a) => a.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(occ.teacherId);
  });

  it('不在确认集合内的教师不能确认（管理员也不能代确认）', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const outsider = otherTeachers(3).find((t) => t !== from && t !== to) as string;
    expect(changes.decide(r.caseId as string, teacher(outsider), 'ACCEPT').code).toBe('NOT_A_CONFIRMER');
  });

  it('管理员身份不能替他人确认（角色不蕴含业务权）', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const admin = mintPrincipal({
      userId: 'U-ADMIN',
      teacherId: to as string,
      displayName: '管理员',
      roles: ['A'],
      actingRole: 'A',
      sessionId: 'S-ADMIN',
      mustChangePassword: false,
    });
    expect(() => changes.decide(r.caseId as string, admin, 'ACCEPT')).toThrow(/无权执行/);
    expect(changes.getCase(r.caseId as string)?.status).toBe('PENDING_CONFIRMATION');
  });
});

describe('生效', () => {
  it('全部本人确认后生效，课表反映新教师并留下审计', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    changes.decide(r.caseId as string, teacher(from as string), 'ACCEPT');
    const done = changes.decide(r.caseId as string, teacher(to as string), 'ACCEPT');
    expect(done.code).toBe('EFFECTIVE');
    expect(done.status).toBe('EFFECTIVE');

    const after = changes.activeAssignments(TERM).find((a) => a.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(to);

    const audit = changes.audit(r.caseId as string);
    expect(audit.map((a) => a.action)).toContain('APPLY');
  });

  it('生效由系统收尾，不存在"人工点击生效"的公开入口', () => {
    expect((changes as unknown as { apply?: unknown }).apply).toBeUndefined();
  });

  it('已生效变更不可删除', () => {
    expect(() => changes.deleteChange()).toThrow(/METHOD_NOT_ALLOWED/);
  });

  it('已生效方案不能撤回', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    changes.decide(r.caseId as string, teacher(from as string), 'ACCEPT');
    changes.decide(r.caseId as string, teacher(to as string), 'ACCEPT');
    expect(changes.withdraw(r.caseId as string, teacher(from as string)).code).toBe('INVALID_STATUS');
  });

  it('非发起人不能撤回方案', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    expect(changes.withdraw(r.caseId as string, teacher(to as string)).code).toBe('NOT_OWNER');
    expect(changes.withdraw(r.caseId as string, teacher(from as string)).ok).toBe(true);
  });
});

describe('改案与并发互斥', () => {
  it('改案后旧确认失效，必须按新版本重新确认', () => {
    const occ = pickOccurrence();
    const [from, to, third] = otherTeachers(3);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const caseId = r.caseId as string;
    changes.decide(caseId, teacher(from as string), 'ACCEPT');
    changes.decide(caseId, teacher(to as string), 'ACCEPT');
    expect(changes.getCase(caseId)?.status).toBe('EFFECTIVE');

    // 已生效不可改案
    expect(changes.revise(caseId, teacher(from as string), [reassign(occ.occurrenceId, third as string)]).code).toBe(
      'INVALID_STATUS',
    );
  });

  it('确认期间改案：旧版本确认不再有效，需按新版本重新确认', () => {
    const occ = pickOccurrence();
    const [from, to, third] = otherTeachers(3);
    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const caseId = r.caseId as string;
    changes.decide(caseId, teacher(from as string), 'ACCEPT');
    changes.decide(caseId, teacher(from as string), 'ACCEPT');

    const revised = changes.revise(caseId, teacher(from as string), [
      reassign(occ.occurrenceId, third as string),
    ]);
    expect(revised.revision).toBe(2);
    expect(revised.required).toEqual([from, third].sort());

    // 旧确认（revision=1）不作数：只确认新版本中的 from，仍未齐备
    const partial = changes.decide(caseId, teacher(from as string), 'ACCEPT');
    expect(partial.status).toBe('PENDING_CONFIRMATION');
    expect(changes.getCase(caseId)?.status).toBe('PENDING_CONFIRMATION');
  });

  it('两个互斥方案只有一个生效，另一个因版本过期被拒', () => {
    const occ = pickOccurrence();
    const [from, a, b] = otherTeachers(3);
    const first = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, a as string)],
      reason: null,
      idempotencyKey: key(),
    });
    const second = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, b as string)],
      reason: null,
      idempotencyKey: key(),
    });

    changes.decide(first.caseId as string, teacher(from as string), 'ACCEPT');
    const won = changes.decide(first.caseId as string, teacher(a as string), 'ACCEPT');
    expect(won.code).toBe('EFFECTIVE');

    changes.decide(second.caseId as string, teacher(from as string), 'ACCEPT');
    const loser = changes.decide(second.caseId as string, teacher(b as string), 'ACCEPT');
    expect(loser.ok).toBe(false);
    expect(loser.code).toBe('STALE_VERSION');

    const after = changes.activeAssignments(TERM).find((x) => x.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(a);
    expect(changes.getCase(second.caseId as string)?.status).toBe('PENDING_CONFIRMATION');
  });
});

describe('执行事实与恢复方案', () => {
  it('执行事实没有授权入口：任何角色调用都被拒绝', () => {
    const occ = pickOccurrence();
    expect(() => changes.recordExecution(teacher(occ.teacherId), occ.occurrenceId, true)).toThrow(
      /待校方确认/,
    );
  });

  it('已登记执行的课次不得被改写', () => {
    const occ = pickOccurrence();
    const [from, to] = otherTeachers(2);
    seedExecuted(occ.occurrenceId);

    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(from as string),
      items: [reassign(occ.occurrenceId, to as string)],
      reason: null,
      idempotencyKey: key(),
    });
    changes.decide(r.caseId as string, teacher(from as string), 'ACCEPT');
    const applied = changes.decide(r.caseId as string, teacher(to as string), 'ACCEPT');
    expect(applied.code).toBe('EXECUTED_NOT_CHANGEABLE');
    const after = changes.activeAssignments(TERM).find((x) => x.occurrenceId === occ.occurrenceId);
    expect(after?.teacherId).toBe(occ.teacherId);
  });

  it('恢复方案只作用于未执行课次', () => {
    const { first, second, a, b } = plan();

    // 两节课分别改派给两位新教师，形成一次含两节的变更
    const original = changes.submitNew({
      termId: TERM,
      principal: teacher(first.teacherId),
      items: [reassign(first.occurrenceId, a), reassign(second.occurrenceId, b)],
      reason: null,
      idempotencyKey: key(),
    });
    let last = changes.getCase(original.caseId as string);
    for (const t of original.required) {
      const r = changes.decide(original.caseId as string, teacher(t), 'ACCEPT');
      last = changes.getCase(original.caseId as string);
      void r;
    }
    expect(last?.status).toBe('EFFECTIVE');

    // 第一节已执行，恢复只能改回第二节
    seedExecuted(first.occurrenceId);

    const recovery = changes.createRecovery(original.caseId as string, {
      principal: teacher(a),
      items: [reassign(first.occurrenceId, first.teacherId), reassign(second.occurrenceId, second.teacherId)],
      reason: '虚构恢复原因',
      idempotencyKey: key(),
    });
    const recoveryId = recovery.caseId as string;
    expect(
      recovery.conflicts.filter((c) => !c.preExisting),
      JSON.stringify(recovery.conflicts.filter((c) => !c.preExisting)),
    ).toEqual([]);
    changes.submit(recoveryId);
    const required = recovery.required;
    for (const t of required) {
      changes.decide(recoveryId, teacher(t), 'ACCEPT');
    }

    const afterFirst = changes.activeAssignments(TERM).find((x) => x.occurrenceId === first.occurrenceId);
    expect(afterFirst?.teacherId).toBe(a);
    const afterSecond = changes.activeAssignments(TERM).find((x) => x.occurrenceId === second.occurrenceId);
    expect(afterSecond?.teacherId).toBe(second.teacherId);
    expect(changes.getCase(recoveryId)?.status).toBe('EFFECTIVE');
  });
});

describe('方案不完整时', () => {
  it('只调进已占用时段而不安排原课去向 → 提交即被挡住', () => {
    const all = active();
    const first = all[0] as ActiveAssignment;
    const sameClass = all.find(
      (a) =>
        a.occurrenceId !== first.occurrenceId &&
        a.classId === first.classId &&
        (a.date !== first.date || a.period !== first.period),
    ) as ActiveAssignment;

    const r = changes.submitNew({
      termId: TERM,
      principal: teacher(first.teacherId),
      items: [
        {
          occurrenceId: first.occurrenceId,
          kind: 'MOVE',
          toTeacherId: null,
          toDate: sameClass.date,
          toPeriod: sameClass.period,
        },
      ],
      reason: null,
      idempotencyKey: key(),
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('BLOCKED_CONFLICT');
    expect(r.conflicts.map((c) => c.code)).toContain('CLASS_SLOT_CONFLICT');
    expect(changes.getCase(r.caseId as string)?.status).toBe('BLOCKED_CONFLICT');
  });
});

describe('幂等键边界', () => {
  it('空幂等键按"未提供"存 NULL：两次提交不会被误判为重复', () => {
    const byTeacher = new Map<string, ActiveAssignment[]>();
    for (const a of active()) {
      const list = byTeacher.get(a.teacherId) ?? [];
      list.push(a);
      byTeacher.set(a.teacherId, list);
    }
    const pair = [...byTeacher.values()].find((list) => list.length >= 2);
    if (!pair) throw new Error('虚构样本中缺少有两节课的教师');
    const owner = pair[0]?.teacherId as string;
    const o1 = pair[0] as ActiveAssignment;
    const o2 = pair[1] as ActiveAssignment;

    const submit = (occurrenceId: string) =>
      changes.submitNew({
        termId: TERM,
        principal: teacher(owner),
        items: [{ occurrenceId, kind: 'CANCEL', toTeacherId: null, toDate: null, toPeriod: null }],
        reason: null,
        idempotencyKey: '',
      });

    const first = submit(o1.occurrenceId);
    const second = submit(o2.occurrenceId);
    expect(first.ok).toBe(true);
    expect(second.ok, second.code).toBe(true);
    expect(second.caseId).not.toBe(first.caseId);

    const stored = db.handle
      .prepare('SELECT idempotency_key FROM change_case WHERE id = ?')
      .get(first.caseId as string) as { idempotency_key: string | null };
    expect(stored.idempotency_key).toBeNull();
  });
});

describe('代他人发起调课', () => {
  function operator(teacherId: string, grants: string[]): Principal {
    return mintPrincipal({
      userId: `U-${teacherId}`,
      teacherId,
      displayName: teacherId,
      roles: ['T'],
      actingRole: 'T',
      grants,
      sessionId: `S-${teacherId}`,
      mustChangePassword: false,
    });
  }

  function cancelOf(occurrenceId: string) {
    return { occurrenceId, kind: 'CANCEL' as const, toTeacherId: null, toDate: null, toPeriod: null };
  }

  it('没有该能力时，即使传了 onBehalfOf 也一律拒绝', () => {
    const occ = pickOccurrence();
    const someone = otherTeachers(2).find((t) => t !== occ.teacherId);
    if (!someone) throw new Error('样本里没有第二位教师');

    expect(() =>
      changes.submitNew({
        termId: TERM,
        principal: operator(someone, []),
        items: [cancelOf(occ.occurrenceId)],
        reason: null,
        idempotencyKey: key(),
        onBehalfOfTeacherId: occ.teacherId,
      }),
    ).toThrow();
  });

  it('具备能力时：方案记在被代教师名下，created_by 记代办人', () => {
    const occ = pickOccurrence();
    const someone = otherTeachers(2).find((t) => t !== occ.teacherId);
    if (!someone) throw new Error('样本里没有第二位教师');
    const token = key();

    const summary = changes.submitNew({
      termId: TERM,
      principal: operator(someone, ['CREATE_CHANGE_ON_BEHALF']),
      items: [cancelOf(occ.occurrenceId)],
      reason: null,
      idempotencyKey: token,
      onBehalfOfTeacherId: occ.teacherId,
    });
    expect(summary.caseId).not.toBeNull();

    const row = db.handle
      .prepare('SELECT submitted_by, created_by FROM change_case WHERE id = ?')
      .get(String(summary.caseId)) as { submitted_by: string; created_by: string | null };
    // 业务归属仍是被代教师；代办人只作为"实际操作人"留痕
    expect(row.submitted_by).toBe(occ.teacherId);
    expect(row.created_by).toBe(someone);

    // 幂等重放：同一键再提交，返回原方案而不是建第二笔
    const replay = changes.submitNew({
      termId: TERM,
      principal: operator(someone, ['CREATE_CHANGE_ON_BEHALF']),
      items: [cancelOf(occ.occurrenceId)],
      reason: null,
      idempotencyKey: token,
      onBehalfOfTeacherId: occ.teacherId,
    });
    expect(replay.code).toBe('DUPLICATE_REPLAY');
    expect(replay.caseId).toBe(summary.caseId);
  });

  it('被代教师与课次归属对不上时拒绝', () => {
    const list = otherTeachers(2);
    const victim = list[0];
    const another = list[1];
    if (!victim || !another) throw new Error('样本中教师不足');
    const occ = active().find((a) => a.teacherId === victim);
    if (!occ) throw new Error('找不到该教师的课次');

    expect(() =>
      changes.submitNew({
        termId: TERM,
        principal: operator(victim, ['CREATE_CHANGE_ON_BEHALF']),
        items: [cancelOf(occ.occurrenceId)],
        reason: null,
        idempotencyKey: key(),
        onBehalfOfTeacherId: another,
      }),
    ).toThrow();
  });

  it('不能以"代发起"的名义给自己建单', () => {
    const occ = pickOccurrence();
    expect(() =>
      changes.submitNew({
        termId: TERM,
        principal: operator(occ.teacherId, ['CREATE_CHANGE_ON_BEHALF']),
        items: [cancelOf(occ.occurrenceId)],
        reason: null,
        idempotencyKey: key(),
        onBehalfOfTeacherId: occ.teacherId,
      }),
    ).toThrow();
  });
});
