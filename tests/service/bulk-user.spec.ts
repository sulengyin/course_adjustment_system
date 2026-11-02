/**
 * 批量开通账号的边界：整批预检、不造孤儿账号、不授予未定职责、初始口令不可外部指定。
 */

import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../../src/auth/service.js';
import { BulkUserService, type BulkUserRow } from '../../src/service/bulk-user-service.js';
import type { Principal } from '../../src/auth/principal.js';

const ADMIN_PASS = 'Admin!Pass2026x';

interface Harness {
  db: CourseDatabase;
  auth: AuthService;
  service: BulkUserService;
  admin: Principal;
  userCount(): number;
}

function seedTeacher(db: CourseDatabase, id: string, name: string): void {
  db.handle.prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES(?,?, 'SIMULATED')").run(id, name);
}

function harness(teacherIds: readonly string[] = ['T01', 'T02', 'T03']): Harness {
  const db = new CourseDatabase(':memory:');
  for (const id of teacherIds) seedTeacher(db, id, `教师${id}`);
  const auth = new AuthService(db);
  const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '系统管理员' });
  const first = auth.login('admin', boot.initialPassword, 'A');
  if (!first.ok) throw new Error('管理员初始登录失败');
  auth.changePassword(first.principal, boot.initialPassword, ADMIN_PASS);
  const login = auth.login('admin', ADMIN_PASS, 'A');
  if (!login.ok) throw new Error('管理员改密后登录失败');
  return {
    db,
    auth,
    service: new BulkUserService(db, auth),
    admin: login.principal,
    userCount: () => (db.handle.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n,
  };
}

function row(loginName: string, teacherId: string | null, roles: string): BulkUserRow {
  return { loginName, displayName: `教师${loginName}`, teacherId, roles: roles.split('+') };
}

const OK_ROWS: readonly BulkUserRow[] = [
  row('teacher01', 'T01', 'T'),
  row('teacher02', 'T02', 'T'),
  row('teacher03', 'T03', 'T+S'),
];

describe('批量开通账号', () => {
  it('整批成功后每人一个互不相同的初始口令，且首登必须改密', () => {
    const h = harness();
    const before = h.userCount();
    const result = h.service.import(h.admin, OK_ROWS);
    expect(result.rejected).toEqual([]);
    expect(result.created).toHaveLength(3);
    expect(h.userCount()).toBe(before + 3);

    const passwords = result.created.map((c) => c.initialPassword);
    expect(new Set(passwords).size).toBe(3);
    for (const p of passwords) {
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(/[A-Za-z]/.test(p) && /\d/.test(p)).toBe(true);
    }
    for (const c of result.created) {
      const user = h.db.handle.prepare('SELECT must_change_password FROM app_user WHERE login_name = ?').get(c.loginName) as {
        must_change_password: number;
      };
      expect(user.must_change_password).toBe(1);
      // 初始口令必须真的能登录
      expect(h.auth.login(c.loginName, c.initialPassword).ok).toBe(true);
    }
  });

  it('花名册内账号重复时整批拒绝，一个都不建', () => {
    const h = harness();
    const before = h.userCount();
    const result = h.service.import(h.admin, [
      row('teacher01', 'T01', 'T'),
      row('teacher01', 'T02', 'T'),
      row('teacher03', 'T03', 'T'),
    ]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe('DUPLICATE_IN_FILE');
    expect(result.rejected[0]?.line).toBe(3); // 第 1 行表头，重复行是第 3 行
    expect(h.userCount()).toBe(before);
  });

  it('账号在库中已存在时整批拒绝', () => {
    const h = harness();
    h.service.import(h.admin, [row('teacher01', 'T01', 'T')]);
    const before = h.userCount();
    const result = h.service.import(h.admin, [row('teacher01', 'T01', 'T'), row('teacher02', 'T02', 'T')]);
    expect(result.created).toEqual([]);
    expect(result.rejected[0]?.code).toBe('LOGIN_NAME_TAKEN');
    expect(h.userCount()).toBe(before);
  });

  it('教师档案里没有该编号时拒绝，不造孤儿账号', () => {
    const h = harness();
    const before = h.userCount();
    const result = h.service.import(h.admin, [row('teacher01', 'T01', 'T'), row('teacher99', 'T99', 'T')]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe('TEACHER_NOT_FOUND');
    expect(h.userCount()).toBe(before);
  });

  it('教师账号不填编号时拒绝', () => {
    const h = harness();
    const result = h.service.import(h.admin, [row('teacher01', null, 'T')]);
    expect(result.rejected[0]?.code).toBe('BAD_INPUT');
    expect(result.rejected[0]?.message).toContain('教师编号');
  });

  it('非教师账号填了编号时拒绝，避免张冠李戴', () => {
    const h = harness();
    const result = h.service.import(h.admin, [row('staff01', 'T01', 'S')]);
    expect(result.rejected[0]?.code).toBe('BAD_INPUT');
    expect(result.rejected[0]?.message).toContain('T+S');
  });

  it('未定职责（R/J/C）一律拒绝授予', () => {
    const h = harness();
    for (const role of ['R', 'J', 'C']) {
      const result = h.service.import(h.admin, [row('teacher01', 'T01', `T+${role}`)]);
      expect(result.rejected[0]?.code).toBe('ROLE_NOT_GRANTABLE');
    }
    expect(h.userCount()).toBe(1); // 只有管理员
  });

  it('同一教师编号不能挂在两个账号上（文件内与库内都拒绝）', () => {
    const h = harness();
    // 文件内重复
    const inFile = h.service.import(h.admin, [row('teacher01', 'T01', 'T'), row('teacher01b', 'T01', 'T')]);
    expect(inFile.rejected[0]?.code).toBe('DUPLICATE_TEACHER_IN_FILE');
    expect(inFile.created).toEqual([]);

    // 库内已绑定
    h.service.import(h.admin, [row('teacher01', 'T01', 'T')]);
    const already = h.service.import(h.admin, [row('teacher01b', 'T01', 'T')]);
    expect(already.rejected[0]?.code).toBe('TEACHER_ALREADY_BOUND');
    expect(already.created).toEqual([]);
  });

  it('未知角色与空账号分别按 BAD_INPUT / UNKNOWN_ROLE 拒绝', () => {
    const h = harness();
    expect(h.service.import(h.admin, [row('teacher01', 'T01', 'X')]).rejected[0]?.code).toBe('UNKNOWN_ROLE');
    expect(h.service.import(h.admin, [row('', 'T01', 'T')]).rejected[0]?.code).toBe('BAD_INPUT');
    expect(h.service.import(h.admin, [row('teacher01', 'T01', '')]).rejected[0]?.code).toBe('BAD_INPUT');
  });

  it('没有 MANAGE_ACCOUNTS 权限的执行人被挡在预检之前', () => {
    const h = harness();
    const first = h.service.import(h.admin, [row('teacher01', 'T01', 'T')]);
    const initial = first.created[0]?.initialPassword ?? '';
    const before = h.userCount();

    // 教师先完成首登改密，确保被测的是权限而不是改密闸门
    const teacherLogin = h.auth.login('teacher01', initial, 'T');
    if (!teacherLogin.ok) throw new Error('教师初始登录失败');
    h.auth.changePassword(teacherLogin.principal, initial, 'Teacher!Pass2026x');
    const teacher = h.auth.login('teacher01', 'Teacher!Pass2026x', 'T');
    if (!teacher.ok) throw new Error('教师改密后登录失败');

    expect(() => h.service.import(teacher.principal, [row('teacher02', 'T02', 'T')])).toThrow(PolicyDeniedError);
    expect(h.userCount()).toBe(before);
  });

  it('尚未改密的执行人同样被挡住', () => {
    const h = harness();
    const first = h.service.import(h.admin, [row('teacher01', 'T01', 'T')]);
    const initial = first.created[0]?.initialPassword ?? '';
    const teacherLogin = h.auth.login('teacher01', initial, 'T');
    if (!teacherLogin.ok) throw new Error('教师初始登录失败');
    const before = h.userCount();

    expect(() => h.service.import(teacherLogin.principal, [row('teacher02', 'T02', 'T')])).toThrow(
      /首次登录必须先修改口令/,
    );
    expect(h.userCount()).toBe(before);
  });

  it('每次建号都留审计，条数与建号数一致', () => {
    const h = harness();
    const before = h.db.auditLog.verify().length;
    h.service.import(h.admin, OK_ROWS);
    const after = h.db.auditLog.verify().length;
    expect(after - before).toBe(3);
    expect(h.db.auditLog.verify().ok).toBe(true);
  });
});
