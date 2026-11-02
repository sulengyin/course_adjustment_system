/**
 * 教师名单导入的边界：整批预检、姓名唯一、编号不可撞、真实名单只算"已导入未核实"、
 * 以及与管理无关的缺口——导入之后批量开号才能用得上这些编号。
 */

import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../../src/auth/service.js';
import { TeacherRosterService, type RosterRow } from '../../src/service/teacher-roster-service.js';
import { BulkUserService } from '../../src/service/bulk-user-service.js';
import type { Principal } from '../../src/auth/principal.js';

const STAFF_PASS = 'Staff!Pass2026x';
const AT = '2026-11-02T00:00:00.000Z';

interface Harness {
  db: CourseDatabase;
  auth: AuthService;
  service: TeacherRosterService;
  staff: Principal;
  admin: Principal;
  teacherCount(): number;
}

function seedTeacher(db: CourseDatabase, id: string, name: string): void {
  db.handle.prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES(?,?, 'SIMULATED')").run(id, name);
}

function harness(): Harness {
  const db = new CourseDatabase(':memory:');
  seedTeacher(db, 'T01', '示例教师甲');
  const auth = new AuthService(db);

  const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '系统管理员' });
  const first = auth.login('admin', boot.initialPassword, 'A');
  if (!first.ok) throw new Error('管理员初始登录失败');
  auth.changePassword(first.principal, boot.initialPassword, 'Admin!Pass2026x');
  const adminLogin = auth.login('admin', 'Admin!Pass2026x', 'A');
  if (!adminLogin.ok) throw new Error('管理员改密后登录失败');

  // 名单导入归课务管理人员，管理员不得代管
  const staff = auth.createUser(adminLogin.principal, {
    loginName: 'staff',
    displayName: '课务管理员',
    teacherId: null,
    roles: ['S'],
  });
  const staffFirst = auth.login('staff', staff.initialPassword, 'S');
  if (!staffFirst.ok) throw new Error('课务账号初始登录失败');
  auth.changePassword(staffFirst.principal, staff.initialPassword, STAFF_PASS);
  const staffLogin = auth.login('staff', STAFF_PASS, 'S');
  if (!staffLogin.ok) throw new Error('课务账号改密后登录失败');

  return {
    db,
    auth,
    service: new TeacherRosterService(db, auth, () => AT),
    staff: staffLogin.principal,
    admin: adminLogin.principal,
    teacherCount: () => (db.handle.prepare('SELECT COUNT(*) AS n FROM teacher').get() as { n: number }).n,
  };
}

function row(name: string, id: string | null = null): RosterRow {
  return { displayName: name, teacherId: id };
}

describe('教师名单导入', () => {
  it('整批成功后编号互不重复，且数据来源是「已导入未核实」', () => {
    const h = harness();
    const before = h.teacherCount();
    const result = h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师乙'), row('虚构教师丙')]);

    expect(result.rejected).toEqual([]);
    expect(result.imported).toHaveLength(3);
    expect(h.teacherCount()).toBe(before + 3);
    expect(new Set(result.imported.map((t) => t.teacherId)).size).toBe(3);

    for (const t of result.imported) {
      const stored = h.db.handle
        .prepare('SELECT display_name, data_origin FROM teacher WHERE id = ?')
        .get(t.teacherId) as { display_name: string; data_origin: string };
      expect(stored.display_name).toBe(t.displayName);
      // 真实名单未经校方核对前，不得被当成官方数据
      expect(stored.data_origin).toBe('IMPORTED_UNVERIFIED');
    }
  });

  it('自动编号从现有序列接着走，不与库中已有编号相撞', () => {
    const h = harness();
    const result = h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师乙')]);
    // 库里已有 T01，因此从 T002 起
    expect(result.imported.map((t) => t.teacherId)).toEqual(['T002', 'T003']);
    expect(result.imported.every((t) => t.generated)).toBe(true);
  });

  it('名单自带编号时按名单走，并标记为非生成', () => {
    const h = harness();
    const result = h.service.import(h.staff, [row('虚构教师甲', 'JS001'), row('虚构教师乙', 'JS002')]);
    expect(result.rejected).toEqual([]);
    expect(result.imported.map((t) => t.teacherId)).toEqual(['JS001', 'JS002']);
    expect(result.imported.every((t) => t.generated)).toBe(false);
  });

  it('同批里既有自带编号又有留空时，生成的编号会避开自带的那几个', () => {
    const h = harness();
    const result = h.service.import(h.staff, [row('虚构教师甲', 'T002'), row('虚构教师乙')]);
    expect(result.rejected).toEqual([]);
    expect(result.imported[0]!.teacherId).toBe('T002');
    // T002 已被本批占用，自动编号必须跳过它
    expect(result.imported[1]!.teacherId).toBe('T003');
  });

  it('姓名重复整批拒绝：课表按姓名匹配，重名会让后续导入无法区分', () => {
    const h = harness();
    const before = h.teacherCount();
    const result = h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师乙'), row('虚构教师甲')]);

    expect(result.imported).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.code).toBe('DUPLICATE_NAME_IN_FILE');
    expect(result.rejected[0]!.line).toBe(4);
    expect(h.teacherCount()).toBe(before);
  });

  it('与库中已有教师同名也拒绝，不做覆盖式更新', () => {
    const h = harness();
    const result = h.service.import(h.staff, [row('虚构教师甲'), row('示例教师甲')]);
    expect(result.imported).toEqual([]);
    expect(result.rejected.map((r) => r.code)).toEqual(['NAME_ALREADY_EXISTS']);
    expect(
      (h.db.handle.prepare("SELECT data_origin FROM teacher WHERE id = 'T01'").get() as { data_origin: string })
        .data_origin,
    ).toBe('SIMULATED');
  });

  it('编号在本批内重复 / 与库中已有编号相撞分别按对应原因拒绝', () => {
    const h = harness();
    const dup = h.service.import(h.staff, [row('虚构教师甲', 'JS001'), row('虚构教师乙', 'JS001')]);
    expect(dup.rejected.map((r) => r.code)).toEqual(['DUPLICATE_ID_IN_FILE']);

    const clash = h.service.import(h.staff, [row('虚构教师甲', 'T01')]);
    expect(clash.rejected.map((r) => r.code)).toEqual(['ID_ALREADY_EXISTS']);
  });

  it('空姓名与不合规编号分别按 EMPTY_NAME / BAD_ID_FORMAT 拒绝', () => {
    const h = harness();
    const empty = h.service.import(h.staff, [row('   ')]);
    expect(empty.rejected.map((r) => r.code)).toEqual(['EMPTY_NAME']);

    const bad = h.service.import(h.staff, [row('虚构教师甲', 'T 01')]);
    expect(bad.rejected.map((r) => r.code)).toEqual(['BAD_ID_FORMAT']);
  });

  it('多个问题一次列出，而不是只报第一个', () => {
    const h = harness();
    const result = h.service.import(h.staff, [row(''), row('虚构教师甲', 'T01'), row('虚构教师乙', 'X 1')]);
    expect(result.rejected.map((r) => r.code)).toEqual(['EMPTY_NAME', 'ID_ALREADY_EXISTS', 'BAD_ID_FORMAT']);
  });

  it('留一条审计，且不把姓名清单复制进审计', () => {
    const h = harness();
    h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师乙')], { fileName: 'teachers.csv', sha256: 'a'.repeat(64) });

    const rows = h.db.handle.prepare("SELECT * FROM audit_event WHERE action = 'IMPORT_ROSTER'").all() as Array<{
      actor: string;
      object_type: string;
      after_state: string;
      reason: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.object_type).toBe('TEACHER_ROSTER');
    expect(rows[0]!.after_state).not.toContain('虚构教师甲');
    expect(JSON.parse(rows[0]!.after_state)).toMatchObject({ count: 2, generatedIds: 2, dataOrigin: 'IMPORTED_UNVERIFIED' });
    // 生成编号是占位，审计里要留下这条提示
    expect(rows[0]!.reason).toBe('IDS_GENERATED_PENDING_OFFICIAL');
  });

  it('整批拒绝时不写审计、不写数据', () => {
    const h = harness();
    const before = h.teacherCount();
    h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师甲')]);
    expect((h.db.handle.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'IMPORT_ROSTER'").get() as { n: number }).n).toBe(0);
    expect(h.teacherCount()).toBe(before);
  });

  it('管理员没有导入名单的权限（业务基础资料归课务管理人员）', () => {
    const h = harness();
    expect(() => h.service.import(h.admin, [row('虚构教师甲')])).toThrow(PolicyDeniedError);
  });

  it('导入之后，批量开号才能用这些编号建教师账号', () => {
    const h = harness();
    const roster = h.service.import(h.staff, [row('虚构教师甲'), row('虚构教师乙')]);
    const ids = roster.imported.map((t) => t.teacherId);

    const bulk = new BulkUserService(h.db, h.auth);
    const created = bulk.import(h.admin, [
      { loginName: 'jsjia', displayName: '虚构教师甲', teacherId: ids[0]!, roles: ['T'] },
      { loginName: 'jsyi', displayName: '虚构教师乙', teacherId: ids[1]!, roles: ['T'] },
    ]);
    expect(created.rejected).toEqual([]);
    expect(created.created).toHaveLength(2);
  });
});
