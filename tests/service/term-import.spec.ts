/**
 * 真实学期与作息导入的边界：只允许课务、学期不可覆盖、节次与时间必须自洽。
 */

import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../../src/auth/service.js';
import { TermImportError, TermImportService } from '../../src/service/term-import-service.js';
import type { Principal } from '../../src/auth/principal.js';
import type { BellEntry } from '../../src/domain/model.js';

const ADMIN_PASS = 'Admin!Pass2026x';
const STAFF_PASS = 'Staff!Pass2026x';

const BELLS: readonly BellEntry[] = [
  { period: 1, startsAt: '08:20', endsAt: '09:00' },
  { period: 2, startsAt: '09:30', endsAt: '10:10' },
  { period: 3, startsAt: '10:25', endsAt: '11:05' },
];

function input(overrides: Partial<Parameters<TermImportService['import']>[1]> = {}) {
  return {
    label: '2026—2027学年第一学期',
    startMonday: '2026-08-31',
    endDate: '2027-01-22',
    firstWeekParity: null,
    bells: BELLS,
    ...overrides,
  };
}

interface Harness {
  db: CourseDatabase;
  service: TermImportService;
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
    auth.changePassword(f.principal, created.initialPassword, roles.includes('S') ? STAFF_PASS : ADMIN_PASS);
    const next = auth.login(loginName, roles.includes('S') ? STAFF_PASS : ADMIN_PASS, roles[0]);
    if (!next.ok) throw new Error(`${loginName} 改密后登录失败`);
    return next.principal;
  };

  db.handle.prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES('T01','教师甲','SIMULATED')").run();
  return {
    db,
    service: new TermImportService(db, auth, () => '2026-11-02T06:00:00.000Z'),
    admin: admin.principal,
    staff: mk('staff01', ['S'], null),
    teacher: mk('tea01', ['T'], 'T01'),
  };
}

describe('学期与作息导入', () => {
  it('课务导入后学期与作息可读，来源为 IMPORTED_UNVERIFIED', () => {
    const h = harness();
    const result = h.service.import(h.staff, input());
    expect(result.termId).toBe('TERM-2026-08-31');

    const term = h.db.getTerm('TERM-2026-08-31');
    expect(term?.term.startMonday).toBe('2026-08-31');
    expect(term?.term.endDate).toBe('2027-01-22');
    expect(term?.term.firstWeekParity).toBeNull();
    expect(term?.term.dataOrigin).toBe('IMPORTED_UNVERIFIED');
    expect(h.db.getBell('TERM-2026-08-31').map((b) => [b.period, b.startsAt, b.endsAt])).toEqual([
      [1, '08:20', '09:00'],
      [2, '09:30', '10:10'],
      [3, '10:25', '11:05'],
    ]);

    const audit = h.db.auditLog
      .related({ objectIds: ['TERM-2026-08-31'], limit: 5 })
      .find((r) => r.action === 'IMPORT_TERM');
    expect(audit?.afterState).toBe('IMPORTED_UNVERIFIED');
  });

  it('只有课务管理人员能导入：教师与管理员都被拒', () => {
    const h = harness();
    expect(() => h.service.import(h.teacher, input())).toThrow(PolicyDeniedError);
    expect(() => h.service.import(h.admin, input())).toThrow(PolicyDeniedError);
  });

  it('起始日不是周一直接拒绝', () => {
    const h = harness();
    expect(() => h.service.import(h.staff, input({ startMonday: '2026-09-01' }))).toThrow(
      /起始日必须是周一/,
    );
  });

  it('节次必须从 1 连续', () => {
    const h = harness();
    const bells: readonly BellEntry[] = [
      { period: 1, startsAt: '08:20', endsAt: '09:00' },
      { period: 3, startsAt: '10:25', endsAt: '11:05' },
    ];
    expect(() => h.service.import(h.staff, input({ bells }))).toThrow(TermImportError);
    expect(() => h.service.import(h.staff, input({ bells }))).toThrow(/必须从 1 连续编号/);
  });

  it('结束时间必须晚于开始时间', () => {
    const h = harness();
    const bells = [{ period: 1, startsAt: '09:00', endsAt: '08:20' }];
    expect(() => h.service.import(h.staff, input({ bells }))).toThrow(/必须晚于开始时间/);
  });

  it('已有学期时拒绝覆盖', () => {
    const h = harness();
    h.service.import(h.staff, input());
    expect(() => h.service.import(h.staff, input({ startMonday: '2027-02-22', endDate: '2027-07-01' }))).toThrow(
      /库中已有学期/,
    );
    expect(h.db.countTerms()).toBe(1);
  });
});
