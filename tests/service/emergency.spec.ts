import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPrincipal, type Principal, type Role } from '../../src/auth/principal.js';
import { ChangeService } from '../../src/service/change-service.js';
import { EmergencyService } from '../../src/service/emergency-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import type { ActiveAssignment } from '../../src/store/change-store.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';
const NOW = '2026-09-07T07:00:00+08:00';

let db: CourseDatabase;
let changes: ChangeService;
let emergency: EmergencyService;
let seq = 0;
let mine: ActiveAssignment;
let foreign: ActiveAssignment;

function who(teacherId: string | null, roles: Role[], actingRole: Role, userId = `U-${teacherId ?? 'X'}`): Principal {
  return mintPrincipal({
    userId,
    teacherId,
    displayName: teacherId ?? '管理员',
    roles,
    actingRole,
    sessionId: `S-${userId}`,
    mustChangePassword: false,
  });
}

const t01 = (): Principal => who('T01', ['T'], 'T');
const t02 = (): Principal => who('T02', ['T'], 'T');
const admin = (): Principal => who(null, ['A'], 'A', 'U-ADMIN');
const recorder = (): Principal => who('T02', ['T', 'R'], 'R');
const coordinator = (): Principal => who('T02', ['T', 'C'], 'C');
const scheduler = (): Principal => who('T02', ['T', 'S'], 'S');

function ask(whoPrincipal: Principal, occurrenceId: string, key = `ER-KEY-${++seq}`) {
  return emergency.requestHelp({
    principal: whoPrincipal,
    termId: TERM,
    occurrenceId,
    note: '临时无法到校，需要有人代为照看',
    idempotencyKey: key,
  });
}

beforeEach(() => {
  seq = 0;
  db = new CourseDatabase(':memory:');
  const timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(TERM, FROM, TO);
  changes = new ChangeService(db);
  emergency = new EmergencyService(db, {
    now: () => NOW,
    newId: () => `ER-${(seq += 1)}`,
  });

  const active = changes.activeAssignments(TERM).filter((a) => !a.cancelled);
  const own = active.find((a) => a.teacherId === 'T01');
  const other = active.find((a) => a.teacherId !== 'T01');
  if (!own || !other) throw new Error('虚构样本不足');
  mine = own;
  foreign = other;
});

afterEach(() => db.close());

describe('E2 求助：只能为本人课次，且只记录事实', () => {
  it('教师为本人课次求助：状态 REQUESTED，无负责人、未送达、未核验', () => {
    const before = db.occurrenceFingerprint(TERM);
    const r = ask(t01(), mine.occurrenceId);
    expect(r.ok).toBe(true);
    expect(r.code).toBe('REQUESTED');
    expect(r.status).toBe('REQUESTED');
    expect(r.ownerTeacherId).toBeNull();
    expect(r.provisionalTeacherId).toBeNull();
    expect(r.notified).toBe(false);
    expect(r.teachingVerification).toBe('PENDING');
    expect(r.request?.note).toContain('临时无法到校');
    expect(db.occurrenceFingerprint(TERM)).toBe(before);
  });

  it('为他人课次求助被拒绝，并留审计', () => {
    const r = ask(t01(), foreign.occurrenceId);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
    expect(db.countEmergencyRequests()).toBe(0);

    const denied = db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'EMERGENCY_ACTION_DENIED'")
      .get() as { n: number };
    expect(denied.n).toBe(1);
  });

  it('管理员没有教师身份，不能发起求助', () => {
    const r = ask(admin(), mine.occurrenceId);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });

  it('同一幂等键重放不产生第二条请求；他人复用同一键被拒', () => {
    const first = ask(t01(), mine.occurrenceId, 'KEY-1');
    const replay = ask(t01(), mine.occurrenceId, 'KEY-1');
    expect(replay.code).toBe('DUPLICATE_REPLAY');
    expect(replay.requestId).toBe(first.requestId);
    expect(db.countEmergencyRequests()).toBe(1);

    const stolen = ask(t02(), foreign.occurrenceId, 'KEY-1');
    expect(stolen.code).toBe('NOT_OWNER');
    expect(db.countEmergencyRequests()).toBe(1);
  });

  it('空说明、超长说明、缺幂等键都按 BAD_INPUT 拒绝', () => {
    expect(
      emergency.requestHelp({ principal: t01(), termId: TERM, occurrenceId: mine.occurrenceId, note: '  ', idempotencyKey: 'K-A' }).code,
    ).toBe('BAD_INPUT');
    expect(
      emergency.requestHelp({
        principal: t01(),
        termId: TERM,
        occurrenceId: mine.occurrenceId,
        note: 'x'.repeat(2001),
        idempotencyKey: 'K-B',
      }).code,
    ).toBe('BAD_INPUT');
    expect(
      emergency.requestHelp({ principal: t01(), termId: TERM, occurrenceId: mine.occurrenceId, note: '需要帮助', idempotencyKey: ' ' }).code,
    ).toBe('BAD_INPUT');
    expect(db.countEmergencyRequests()).toBe(0);
  });

  it('已取消的课次不能求助', () => {
    db.handle
      .prepare(
        `INSERT INTO assignment_state(occurrence_id, term_id, class_id, subject_id, teacher_id, date, period, cancelled, version, change_id, updated_at)
         VALUES(?,?,?,?,?,?,?,1,1,NULL,?)`,
      )
      .run(mine.occurrenceId, TERM, mine.classId, mine.subjectId, mine.teacherId, mine.date, mine.period, NOW);
    const r = ask(t01(), mine.occurrenceId);
    expect(r.code).toBe('INVALID_OCCURRENCE');
  });

  it('只有求助人本人能查看，其他教师与管理员均不可见', () => {
    const created = ask(t01(), mine.occurrenceId);
    const id = created.requestId as string;

    expect(emergency.getForRequester(t01(), id).code).toBe('FOUND');
    expect(emergency.getForRequester(t02(), id).code).toBe('FORBIDDEN');
    expect(emergency.getForRequester(admin(), id).code).toBe('FORBIDDEN');
    expect(emergency.getForRequester(t01(), 'NO-SUCH').code).toBe('NOT_FOUND');
  });
});

describe('E3 / E10 口头登记与追认入口受门禁阻断', () => {
  it('记录者是 TBD_BLOCKED：任何角色都不能登记口头接受，状态不变', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.recordOralAcceptance(recorder(), id).code).toBe('ROLE_NOT_ASSIGNED');
    expect(emergency.recordOralAcceptance(t02(), id).code).toBe('FORBIDDEN');
    const after = emergency.getForRequester(t01(), id);
    expect(after.status).toBe('REQUESTED');
    expect(after.ownerTeacherId).toBeNull();
    expect(after.provisionalTeacherId).toBeNull();
  });
});

describe('E7 接单入口：候选范围未定，不允许任何人先接', () => {
  it('教师无权接单；协调者虽有权但规则未定，返回 NOT_CONFIGURED', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.claim(t02(), id).code).toBe('FORBIDDEN');

    const c = emergency.claim(coordinator(), id);
    expect(c.code).toBe('NOT_CONFIGURED');
    expect(c.blockedBy).toEqual(['E5', 'D07', 'O2-1']);
    expect(c.ownerTeacherId).toBeNull();
    expect(db.countEmergencyRequests()).toBe(1);
  });

  it('移交同样未定', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.transfer(coordinator(), id).code).toBe('NOT_CONFIGURED');
  });
});

describe('E4 / E6 / E8 / E9 未决规则不自动推进', () => {
  it('补确认逾期未配置：不返回任何截止钟点', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    const r = emergency.overdue(t01(), id);
    expect(r.code).toBe('NOT_CONFIGURED');
    expect(r.blockedBy).toEqual(['BIZ-04', 'TIME']);
  });

  it('主责拒绝：要求升级，但代理岗位未定', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.escalate(t02(), id, false).code).toBe('NO_ESCALATION');
    const r = emergency.escalate(t02(), id, true);
    expect(r.code).toBe('NOT_CONFIGURED');
    expect(r.blockedBy).toEqual(['E5']);
  });

  it('没有负责人时不能提交结案；批准人未定', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.submitClosure(coordinator(), id).code).toBe('NO_COORDINATION_OWNER');
    expect(emergency.submitClosure(t02(), id).code).toBe('FORBIDDEN');
    expect(emergency.confirmClosure(scheduler(), id).code).toBe('ROLE_NOT_ASSIGNED');
    expect(emergency.confirmClosure(t02(), id).code).toBe('FORBIDDEN');
  });

  it('送达判定未定：不提供"已通知"结果', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    const r = emergency.markNotified(t01(), id);
    expect(r.code).toBe('NOT_CONFIGURED');
    expect(r.blockedBy).toEqual(['BIZ-13']);
    expect(r.notified).toBe(false);
  });

  it('执行事实录入未定：S / R 均被拒绝', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    expect(emergency.recordExecutionFact(scheduler(), id).code).toBe('ROLE_NOT_ASSIGNED');
    expect(emergency.recordExecutionFact(recorder(), id).code).toBe('ROLE_NOT_ASSIGNED');
    expect(emergency.recordExecutionFact(t02(), id).code).toBe('FORBIDDEN');
  });
});

describe('隐私与审计边界', () => {
  it('求助说明留在业务表，不进审计链', () => {
    ask(t01(), mine.occurrenceId);
    const leaked = db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE reason LIKE '%无法到校%' OR after_state LIKE '%无法到校%'")
      .get() as { n: number };
    expect(leaked.n).toBe(0);

    const stored = db.handle.prepare('SELECT note FROM emergency_request').get() as { note: string };
    expect(stored.note).toContain('无法到校');
  });

  it('被拒绝的尝试也会留痕，且审计链保持完整', () => {
    const id = ask(t01(), mine.occurrenceId).requestId as string;
    emergency.claim(coordinator(), id);
    emergency.recordOralAcceptance(recorder(), id);
    emergency.confirmClosure(scheduler(), id);

    const denied = db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'EMERGENCY_ACTION_DENIED'")
      .get() as { n: number };
    expect(denied.n).toBe(3);
    expect(db.auditLog.verify().ok).toBe(true);
  });
});
