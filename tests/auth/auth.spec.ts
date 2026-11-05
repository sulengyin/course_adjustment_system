import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../../src/auth/service.js';
import type { Principal } from '../../src/auth/principal.js';
import { can } from '../../src/auth/policy.js';
import { mintPrincipal } from '../../src/auth/principal.js';
import { checkPasswordStrength, generateInitialPassword } from '../../src/auth/password.js';

const KNOWN = 'Passw0rd!2026x';
const BOOT = 'Boot!Pass2026x';

function seedTeacher(db: CourseDatabase, id: string, name: string): void {
  db.handle
    .prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES(?,?, 'SIMULATED')")
    .run(id, name);
}

interface Harness {
  db: CourseDatabase;
  auth: AuthService;
  clock: { at: string };
  admin: Principal;
}

function harness(): Harness {
  const db = new CourseDatabase(':memory:');
  const clock = { at: '2026-11-01T08:00:00.000Z' };
  const auth = new AuthService(db, { now: () => clock.at, idleMinutes: 30 });
  const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '管理员', password: BOOT });
  const login = auth.login('admin', BOOT, 'A');
  if (!login.ok) throw new Error('bootstrap login failed');
  auth.changePassword(login.principal, BOOT, KNOWN);
  const again = auth.login('admin', KNOWN, 'A');
  if (!again.ok) throw new Error('relogin failed');
  void boot;
  return { db, auth, clock, admin: again.principal };
}

/** 走真实开户流程：一次性口令登录 → 改密 → 重新登录。 */
function addUser(
  h: Harness,
  input: { loginName: string; roles: Array<'T' | 'S' | 'A'>; teacherId?: string },
): Principal {
  const { initialPassword } = h.auth.createUser(h.admin, {
    loginName: input.loginName,
    displayName: input.loginName,
    teacherId: input.teacherId ?? null,
    roles: input.roles,
  });
  const first = h.auth.login(input.loginName, initialPassword);
  if (!first.ok) throw new Error(`first login failed: ${first.code}`);
  h.auth.changePassword(first.principal, initialPassword, KNOWN);
  const next = h.auth.login(input.loginName, KNOWN, input.roles[0]);
  if (!next.ok) throw new Error(`relogin failed: ${next.code}`);
  return next.principal;
}

describe('账号与开户', () => {
  it('只能在空库初始化一次管理员', () => {
    const h = harness();
    expect(() => h.auth.bootstrapAdmin({ loginName: 'admin2', displayName: 'x', password: KNOWN })).toThrow(
      /已存在账号/,
    );
  });

  it('演示种子可以指定共用初始口令，但本人首登仍须改密', () => {
    const h = harness();
    const created = h.auth.createUser(h.admin, {
      loginName: 'demo-seed',
      displayName: '演示账号',
      roles: ['S'],
      password: 'Shared!Seed2026',
    });
    expect(created.initialPassword).toBe('Shared!Seed2026');
    const login = h.auth.login('demo-seed', 'Shared!Seed2026');
    expect(login.ok).toBe(true);
    if (login.ok) expect(login.principal.mustChangePassword).toBe(true);
  });

  it('指定的初始口令同样要过强度检查', () => {
    const h = harness();
    expect(() =>
      h.auth.createUser(h.admin, {
        loginName: 'weak-seed',
        displayName: 'x',
        roles: ['S'],
        password: '123456',
      }),
    ).toThrow(/口令不符合最低要求/);
  });

  it('不允许把未定职责授予任何人（R/J/C）', () => {
    const h = harness();
    for (const role of ['R', 'J', 'C']) {
      expect(() =>
        h.auth.createUser(h.admin, {
          loginName: `u-${role.toLowerCase()}`,
          displayName: role,
          roles: [role],
        }),
      ).toThrow(/尚未由校方指定/);
    }
  });

  it('教师账号必须关联教师档案', () => {
    const h = harness();
    expect(() =>
      h.auth.createUser(h.admin, { loginName: 'tea-x', displayName: 'x', roles: ['T'] }),
    ).toThrow(/必须关联教师档案/);
  });

  it('账号格式与重复账号被拒绝', () => {
    const h = harness();
    expect(() => h.auth.createUser(h.admin, { loginName: 'A B', displayName: 'x', roles: ['S'] })).toThrow(
      /账号需为/,
    );
    h.auth.createUser(h.admin, { loginName: 'dup', displayName: 'x', roles: ['S'] });
    expect(() => h.auth.createUser(h.admin, { loginName: 'dup', displayName: 'y', roles: ['S'] })).toThrow(
      /账号已存在/,
    );
  });
});

describe('登录与会话', () => {
  it('错误口令与不存在账号返回同一错误码，且都留审计', () => {
    const h = harness();
    expect(h.auth.login('admin', 'wrong-password-value', 'A')).toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
    expect(h.auth.login('nobody', 'wrong-password-value')).toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
    const rows = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'LOGIN_FAILED'")
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('会话表只存 token 的哈希，不存明文', () => {
    const h = harness();
    const token = 'a-token-that-must-not-be-stored';
    const login = h.auth.login('admin', KNOWN, 'A');
    if (!login.ok) throw new Error('login failed');
    const row = h.db.handle
      .prepare('SELECT token_hash FROM session WHERE id = ?')
      .get(login.principal.sessionId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(login.token);
    expect(row.token_hash).not.toBe(token);
    expect(h.auth.authenticate(login.token)?.userId).toBe(h.admin.userId);
  });

  it('一人多角色不指定身份 → AMBIGUOUS_ROLE；指定未授予身份 → ROLE_NOT_GRANTED', () => {
    const h = harness();
    seedTeacher(h.db, 'T-1', '甲');
    const { initialPassword } = h.auth.createUser(h.admin, {
      loginName: 'multi',
      displayName: '多角色',
      teacherId: 'T-1',
      roles: ['T', 'S'],
    });
    const first = h.auth.login('multi', initialPassword);
    if (!first.ok) throw new Error('login failed');
    h.auth.changePassword(first.principal, initialPassword, KNOWN);

    const ambiguous = h.auth.login('multi', KNOWN);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.code).toBe('AMBIGUOUS_ROLE');
      expect(ambiguous.roles).toEqual(['S', 'T']);
    }
    const wrong = h.auth.login('multi', KNOWN, 'A');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('ROLE_NOT_GRANTED');
  });

  it('切换身份会作废旧会话', () => {
    const h = harness();
    seedTeacher(h.db, 'T-2', '乙');
    const { initialPassword } = h.auth.createUser(h.admin, {
      loginName: 'switch',
      displayName: '切换',
      teacherId: 'T-2',
      roles: ['T', 'S'],
    });
    const first = h.auth.login('switch', initialPassword);
    if (!first.ok) throw new Error('login failed');
    h.auth.changePassword(first.principal, initialPassword, KNOWN);
    const asTeacher = h.auth.login('switch', KNOWN, 'T');
    if (!asTeacher.ok) throw new Error('login failed');

    const switched = h.auth.switchRole(asTeacher.principal, 'S');
    expect(switched.principal.actingRole).toBe('S');
    expect(h.auth.authenticate(asTeacher.token)).toBeNull();
    expect(h.auth.authenticate(switched.token)?.actingRole).toBe('S');
  });

  it('空闲超时后会话失效', () => {
    const h = harness();
    const login = h.auth.login('admin', KNOWN, 'A');
    if (!login.ok) throw new Error('login failed');
    h.clock.at = '2026-11-01T08:29:00.000Z';
    expect(h.auth.authenticate(login.token)).not.toBeNull();
    h.clock.at = '2026-11-01T09:00:00.000Z';
    expect(h.auth.authenticate(login.token)).toBeNull();
  });

  it('停用账号立即吊销其全部会话', () => {
    const h = harness();
    const victim = addUser(h, { loginName: 'victim', roles: ['S'] });
    const login = h.auth.login('victim', KNOWN, 'S');
    if (!login.ok) throw new Error('login failed');

    h.auth.disableUser(h.admin, victim.userId, '离职');
    expect(h.auth.authenticate(login.token)).toBeNull();
    const again = h.auth.login('victim', KNOWN, 'S');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('ACCOUNT_DISABLED');
  });

  it('重置口令后旧会话失效且强制改密', () => {
    const h = harness();
    const target = addUser(h, { loginName: 'resetme', roles: ['S'] });
    const login = h.auth.login('resetme', KNOWN, 'S');
    if (!login.ok) throw new Error('login failed');

    const { initialPassword } = h.auth.resetPassword(h.admin, target.userId, '本人到办公室申请');
    expect(h.auth.authenticate(login.token)).toBeNull();
    const next = h.auth.login('resetme', initialPassword);
    if (!next.ok) throw new Error('login failed');
    expect(next.principal.mustChangePassword).toBe(true);
  });

  it('只有管理员能重置他人口令', () => {
    const h = harness();
    const target = addUser(h, { loginName: 'resetme2', roles: ['S'] });
    const asStaff = addUser(h, { loginName: 'staffonly', roles: ['S'] });
    expect(() => h.auth.resetPassword(asStaff, target.userId, '试试')).toThrow(PolicyDeniedError);
  });

  it('不能重置当前登录账号自己的口令', () => {
    const h = harness();
    expect(() => h.auth.resetPassword(h.admin, h.admin.userId, '忘了')).toThrow(/不能重置当前登录账号/);
  });

  it('重置理由进审计，可事后追问为何重置', () => {
    const h = harness();
    const target = addUser(h, { loginName: 'resetme3', roles: ['S'] });
    h.auth.resetPassword(h.admin, target.userId, '本人到办公室申请并核验证件');
    const rows = h.db.auditLog.related({ objectIds: [target.userId], limit: 10 });
    const row = rows.find((r) => r.action === 'RESET_PASSWORD');
    expect(row).toBeDefined();
    expect(row?.reason).toBe('本人到办公室申请并核验证件');
    expect(row?.afterState).toBe('MUST_CHANGE');
  });
});

describe('口令', () => {
  it('首登未改密时，除改密外的操作一律拒绝', () => {
    const h = harness();
    const { initialPassword } = h.auth.createUser(h.admin, {
      loginName: 'fresh',
      displayName: '新人',
      roles: ['S'],
    });
    const first = h.auth.login('fresh', initialPassword);
    if (!first.ok) throw new Error('login failed');
    expect(() => h.auth.requireAction(first.principal, 'IMPORT_TIMETABLE')).toThrow(/首次登录必须先修改口令/);
  });

  it('弱口令与复用旧口令被拒绝', () => {
    const h = harness();
    const { initialPassword } = h.auth.createUser(h.admin, {
      loginName: 'weak',
      displayName: '弱',
      roles: ['S'],
    });
    const first = h.auth.login('weak', initialPassword);
    if (!first.ok) throw new Error('login failed');
    expect(() => h.auth.changePassword(first.principal, initialPassword, 'short1!')).toThrow(/不符合最低要求/);
    expect(() => h.auth.changePassword(first.principal, initialPassword, `${initialPassword}`)).toThrow(
      /不符合最低要求/,
    );
    expect(() => h.auth.changePassword(first.principal, initialPassword, 'alllowercaseletters')).toThrow(
      /不符合最低要求/,
    );
  });

  it('改密后所有会话作废，必须重新登录', () => {
    const h = harness();
    const { initialPassword } = h.auth.createUser(h.admin, {
      loginName: 'rotate',
      displayName: '改密',
      roles: ['S'],
    });
    const first = h.auth.login('rotate', initialPassword);
    if (!first.ok) throw new Error('login failed');
    h.auth.changePassword(first.principal, initialPassword, KNOWN);
    expect(h.auth.authenticate(first.token)).toBeNull();
  });
});

describe('权限矩阵：未定职责一律拒绝', () => {
  it('课务管理人员不能发布课表，返回 ROLE_NOT_ASSIGNED 并留审计', () => {
    const h = harness();
    const s = addUser(h, { loginName: 'clerk', roles: ['S'] });
    let caught: unknown = null;
    try {
      h.auth.requireAction(s, 'PUBLISH_TIMETABLE');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyDeniedError);
    expect((caught as PolicyDeniedError).code).toBe('ROLE_NOT_ASSIGNED');
    const row = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'AUTHORIZATION_DENIED'")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('管理员不能确认课务、不能开启 L2、不能导入', () => {
    const h = harness();
    expect(() => h.auth.requireAction(h.admin, 'DECIDE_OWN_CONFIRMATION')).toThrow(/无权执行/);
    expect(() => h.auth.requireAction(h.admin, 'IMPORT_TIMETABLE')).toThrow(/无权执行/);
    expect(() => h.auth.requireAction(h.admin, 'ENABLE_L2_POLICY')).toThrow(/无权执行/);
  });

  it('确认本人课务不因角色而蕴含：教师可以，管理员不行', () => {
    const h = harness();
    seedTeacher(h.db, 'T-3', '丙');
    const t = addUser(h, { loginName: 'teacher3', roles: ['T'], teacherId: 'T-3' });
    expect(() => h.auth.requireAction(t, 'DECIDE_OWN_CONFIRMATION')).not.toThrow();
    expect(() => h.auth.requireAction(h.admin, 'DECIDE_OWN_CONFIRMATION')).toThrow();
  });
});

describe('初始口令生成', () => {
  it('生成的口令必须按构造满足强度基线（不能靠概率）', () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateInitialPassword();
      expect(password).toHaveLength(12);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
      expect(checkPasswordStrength({ next: password, previous: null })).toBeNull();
    }
  });

  it('不含易混淆字符（0/O/1/I）', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateInitialPassword()).not.toMatch(/[0O1I]/);
    }
  });
});

describe('一人多角色与身份切换', () => {
  it('追加第二个角色后，登录必须显式选身份，不能默认挑一个', () => {
    const h = harness();
    h.auth.grantRole(h.admin, h.admin.userId, 'S');

    const ambiguous = h.auth.login('admin', KNOWN);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.code).toBe('AMBIGUOUS_ROLE');

    const asAdmin = h.auth.login('admin', KNOWN, 'A');
    expect(asAdmin.ok).toBe(true);
  });

  it('切换身份作废旧会话、签发新会话，并留下 SWITCH_ROLE 审计', () => {
    const h = harness();
    h.auth.grantRole(h.admin, h.admin.userId, 'S');
    const asAdmin = h.auth.login('admin', KNOWN, 'A');
    if (!asAdmin.ok) throw new Error('login failed');

    const switched = h.auth.switchRole(asAdmin.principal, 'S');

    expect(switched.principal.actingRole).toBe('S');
    expect(switched.principal.roles).toEqual(['A', 'S']);
    expect(h.auth.authenticate(asAdmin.token)).toBeNull();
    expect(h.auth.authenticate(switched.token)?.actingRole).toBe('S');

    const rows = h.db.handle
      .prepare("SELECT actor, object_id, before_state, after_state FROM audit_event WHERE action = 'SWITCH_ROLE'")
      .all() as Array<{ actor: string; object_id: string; before_state: string; after_state: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(h.admin.userId);
    expect(rows[0]?.object_id).toBe(h.admin.userId);
    expect(rows[0]?.before_state).toBe('A');
    expect(rows[0]?.after_state).toBe('S');
  });

  it('不能切换到未授予自己的角色', () => {
    const h = harness();
    const staff = addUser(h, { loginName: 'staffx', roles: ['S'] });
    expect(() => h.auth.switchRole(staff, 'A')).toThrow(/未授予该角色/);
    expect(() => h.auth.switchRole(staff, 'T')).toThrow(/未授予该角色/);
  });

  it('追加角色不改判权限：A+S 的 A 身份依然不能导入', () => {
    const h = harness();
    h.auth.grantRole(h.admin, h.admin.userId, 'S');
    const asAdmin = h.auth.login('admin', KNOWN, 'A');
    const asStaff = h.auth.login('admin', KNOWN, 'S');
    if (!asAdmin.ok || !asStaff.ok) throw new Error('login failed');

    expect(() => h.auth.requireAction(asAdmin.principal, 'IMPORT_TIMETABLE')).toThrow(/无权执行/);
    expect(() => h.auth.requireAction(asStaff.principal, 'IMPORT_TIMETABLE')).not.toThrow();
    expect(() => h.auth.requireAction(asStaff.principal, 'MANAGE_ACCOUNTS')).toThrow(/无权执行/);
  });
});

describe('账号级能力授权（不是加角色）', () => {
  function userIdOf(h: Harness, loginName: string): string {
    const row = h.db.handle.prepare('SELECT id FROM app_user WHERE login_name = ?').get(loginName) as
      | { id: string }
      | undefined;
    if (!row) throw new Error(`账号不存在：${loginName}`);
    return row.id;
  }

  it('默认没有代发起能力；授予后要重新登录才生效', () => {
    const h = harness();
    seedTeacher(h.db, 'T1', '甲');
    const first = addUser(h, { loginName: 't001', roles: ['T'], teacherId: 'T1' });
    expect(can(first, 'CREATE_CHANGE_ON_BEHALF').allowed).toBe(false);

    h.auth.grantCapability(h.admin, userIdOf(h, 't001'), 'CREATE_CHANGE_ON_BEHALF', '校务会 2026-11 决议');
    // 旧会话里没有这份授权，必须重新登录——避免"授了但旧页面已经在用"
    expect(can(first, 'CREATE_CHANGE_ON_BEHALF').allowed).toBe(false);

    const again = h.auth.login('t001', KNOWN, 'T');
    if (!again.ok) throw new Error(`relogin failed: ${again.code}`);
    expect(can(again.principal, 'CREATE_CHANGE_ON_BEHALF').allowed).toBe(true);
    // 角色没有变过
    expect(again.principal.roles).toEqual(['T']);
  });

  it('个人授权不能把"校方尚未指定责任人"变成可用', () => {
    // PUBLISH_TIMETABLE 对 S 是 TBD_BLOCKED（发布岗位未证实）。
    // 即便把这条能力写进 grants，也必须仍是 ROLE_NOT_ASSIGNED：
    // 制度未定不是权限不够，不能用个人授权绕过去。
    const s = mintPrincipal({
      userId: 'U-s01',
      teacherId: null,
      displayName: '课务',
      roles: ['S'],
      actingRole: 'S',
      grants: ['PUBLISH_TIMETABLE'],
      sessionId: 'S-s01',
      mustChangePassword: false,
    });
    expect(can(s, 'PUBLISH_TIMETABLE').code).toBe('ROLE_NOT_ASSIGNED');
  });

  it('必须写依据，管理员不能授给自己', () => {
    const h = harness();
    seedTeacher(h.db, 'T1', '甲');
    addUser(h, { loginName: 't001', roles: ['T'], teacherId: 'T1' });
    const target = userIdOf(h, 't001');

    expect(() => h.auth.grantCapability(h.admin, target, 'CREATE_CHANGE_ON_BEHALF', '   ')).toThrow(/依据/);
    expect(() => h.auth.grantCapability(h.admin, h.admin.userId, 'CREATE_CHANGE_ON_BEHALF', '自己批自己')).toThrow(
      /给自己/,
    );
    expect(() => h.auth.grantCapability(h.admin, target, 'NOT_A_REAL_ACTION', 'x')).toThrow(/未知能力/);
  });

  it('撤销后立即作废该账号的所有会话', () => {
    const h = harness();
    seedTeacher(h.db, 'T1', '甲');
    addUser(h, { loginName: 't001', roles: ['T'], teacherId: 'T1' });
    const target = userIdOf(h, 't001');
    h.auth.grantCapability(h.admin, target, 'CREATE_CHANGE_ON_BEHALF', '校务会 2026-11 决议');

    const again = h.auth.login('t001', KNOWN, 'T');
    if (!again.ok) throw new Error('relogin failed');

    h.auth.revokeCapability(h.admin, target, 'CREATE_CHANGE_ON_BEHALF');
    expect(h.auth.authenticate(again.token)).toBeNull();
  });
});
