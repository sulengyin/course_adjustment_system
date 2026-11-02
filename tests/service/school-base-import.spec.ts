/**
 * 班级与科目导入的边界：只允许课务、整批预检、库中已有则拒绝。
 */

import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../../src/auth/service.js';
import { BaseImportError, SchoolBaseImportService } from '../../src/service/school-base-import-service.js';
import type { Principal } from '../../src/auth/principal.js';

const ADMIN_PASS = 'Admin!Pass2026x';
const STAFF_PASS = 'Staff!Pass2026x';

interface Harness {
  db: CourseDatabase;
  service: SchoolBaseImportService;
  admin: Principal;
  staff: Principal;
  teacher: Principal;
}

function harness(): Harness {
  const db = new CourseDatabase(':memory:');
  const auth = new AuthService(db);
  const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '管理员' });
  const first = auth.login('admin', boot.initialPassword, 'A');
  if (!first.ok) throw new Error('管理员首次登录失败');
  auth.changePassword(first.principal, boot.initialPassword, ADMIN_PASS);
  const admin = auth.login('admin', ADMIN_PASS, 'A');
  if (!admin.ok) throw new Error('管理员改密后登录失败');

  const mk = (loginName: string, roles: Array<'T' | 'S'>, teacherId: string | null): Principal => {
    const created = auth.createUser(admin.principal, { loginName, displayName: loginName, teacherId, roles });
    const f = auth.login(loginName, created.initialPassword);
    if (!f.ok) throw new Error(`${loginName} 首次登录失败`);
    const pass = roles.includes('S') ? STAFF_PASS : ADMIN_PASS;
    auth.changePassword(f.principal, created.initialPassword, pass);
    const next = auth.login(loginName, pass, roles[0]);
    if (!next.ok) throw new Error(`${loginName} 改密后登录失败`);
    return next.principal;
  };

  db.handle.prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES('T01','教师甲','SIMULATED')").run();
  return {
    db,
    service: new SchoolBaseImportService(db, auth, () => '2026-11-02T06:00:00.000Z'),
    admin: admin.principal,
    staff: mk('staff01', ['S'], null),
    teacher: mk('tea01', ['T'], 'T01'),
  };
}

describe('班级与科目导入', () => {
  it('课务导入后班级与科目可读，来源为 IMPORTED_UNVERIFIED 并留审计', () => {
    const h = harness();
    const cls = h.service.importClasses(h.staff, [
      { name: '一1', grade: '一年级' },
      { name: '一2', grade: '一年级' },
    ]);
    expect(cls.count).toBe(2);
    expect(h.db.countClasses()).toBe(2);

    const sub = h.service.importSubjects(h.staff, [{ name: '语文' }, { name: '数学' }]);
    expect(sub.count).toBe(2);
    expect(h.db.countSubjects()).toBe(2);

    const row = h.db.handle
      .prepare("SELECT display_name, grade, data_origin FROM school_class WHERE id = 'C-一1'")
      .get() as { display_name: string; grade: string; data_origin: string };
    expect(row.grade).toBe('一年级');
    expect(row.data_origin).toBe('IMPORTED_UNVERIFIED');

    const audit = h.db.auditLog.related({ objectIds: ['2 条'], limit: 10 }).filter((r) => r.action === 'IMPORT_CLASSES');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.afterState).toBe('IMPORTED_UNVERIFIED');
  });

  it('只有课务能导入：教师与管理员都被拒', () => {
    const h = harness();
    expect(() => h.service.importClasses(h.teacher, [{ name: '一1', grade: '一年级' }])).toThrow(PolicyDeniedError);
    expect(() => h.service.importClasses(h.admin, [{ name: '一1', grade: '一年级' }])).toThrow(PolicyDeniedError);
  });

  it('同批重名整批拒绝，一条都不写', () => {
    const h = harness();
    expect(() =>
      h.service.importClasses(h.staff, [
        { name: '一1', grade: '一年级' },
        { name: '一1', grade: '一年级' },
      ]),
    ).toThrow(/班级名称重复/);
    expect(h.db.countClasses()).toBe(0);
  });

  it('缺年级拒绝，且不留下半批数据', () => {
    const h = harness();
    expect(() =>
      h.service.importClasses(h.staff, [
        { name: '一1', grade: '一年级' },
        { name: '一2', grade: '  ' },
      ]),
    ).toThrow(/缺年级/);
    expect(h.db.countClasses()).toBe(0);
  });

  it('库中已有班级时拒绝覆盖', () => {
    const h = harness();
    h.service.importClasses(h.staff, [{ name: '一1', grade: '一年级' }]);
    expect(() => h.service.importClasses(h.staff, [{ name: '一2', grade: '一年级' }])).toThrow(
      /库中已有班级/,
    );
  });

  it('库中已有科目时拒绝覆盖', () => {
    const h = harness();
    h.service.importSubjects(h.staff, [{ name: '语文' }]);
    expect(() => h.service.importSubjects(h.staff, [{ name: '数学' }])).toThrow(/库中已有科目/);
  });

  it('空名单拒绝', () => {
    const h = harness();
    expect(() => h.service.importClasses(h.staff, [])).toThrow(BaseImportError);
    expect(() => h.service.importSubjects(h.staff, [])).toThrow(BaseImportError);
  });
});
