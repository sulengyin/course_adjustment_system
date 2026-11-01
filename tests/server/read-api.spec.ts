/**
 * 只读接口与静态页面的边界。
 *
 * 关注点不是"能返回数据"，而是：
 *  - 理由字段只对发起人可见（权限矩阵：查看他人私人理由无授权角色）
 *  - 列表只返回与我有关的条目，管理员也不能顺手全看
 *  - 静态资源只认白名单，路径穿越与目录列举在结构上不存在
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/service.js';
import { ChangeService } from '../../src/service/change-service.js';
import { EmergencyService } from '../../src/service/emergency-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';
import { startServer, stopServer, type StartedServer } from '../../src/server/start.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

let db: CourseDatabase;
let auth: AuthService;
let started: StartedServer;
let base: string;
let t01 = '';
let t02 = '';
let t03 = '';
let staff = '';
let admin = '';
let caseId = '';

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function raw(path: string, token?: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function createAccount(
  adminPrincipal: ReturnType<AuthService['login']>,
  loginName: string,
  displayName: string,
  teacherId: string | null,
  roles: string[],
): void {
  if (!adminPrincipal.ok) throw new Error('admin login failed');
  const created = auth.createUser(adminPrincipal.principal, {
    loginName,
    displayName,
    teacherId,
    roles,
  });
  const first = auth.login(loginName, created.initialPassword);
  if (!first.ok) throw new Error(`login failed: ${loginName}`);
  auth.changePassword(first.principal, created.initialPassword, 'Init!2026pass');
}

async function tokenOf(loginName: string, role?: string): Promise<string> {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: { loginName, password: 'Init!2026pass', actingRole: role },
  });
  if (r.status !== 200) throw new Error(`登录失败 ${loginName}: ${JSON.stringify(r.body)}`);
  return String(r.body.token);
}

beforeAll(async () => {
  db = new CourseDatabase(':memory:');
  const timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(TERM, FROM, TO);
  auth = new AuthService(db);
  const changes = new ChangeService(db);
  const emergency = new EmergencyService(db);

  auth.bootstrapAdmin({ loginName: 'admin', displayName: '管理员', password: 'Boot!2026pass' });
  const booted = auth.login('admin', 'Boot!2026pass', 'A');
  if (!booted.ok) throw new Error('bootstrap failed');
  auth.changePassword(booted.principal, 'Boot!2026pass', 'Init!2026pass');
  // 改密后旧 principal 仍带 mustChangePassword，必须重新登录再开户。
  const adminLogin = auth.login('admin', 'Init!2026pass', 'A');
  if (!adminLogin.ok) throw new Error('admin relogin failed');

  createAccount(adminLogin, 'teacher01', '示例教师甲', 'T01', ['T']);
  createAccount(adminLogin, 'teacher02', '示例教师乙', 'T02', ['T']);
  createAccount(adminLogin, 'teacher03', '示例教师丙', 'T03', ['T']);
  createAccount(adminLogin, 'staff', '课务员', null, ['S']);

  started = await startServer(
    { bindAddress: '127.0.0.1', port: 0, tls: null, requireTls: false },
    { db, auth, changes, timetable, emergency },
  );
  base = `http://127.0.0.1:${started.port}`;

  t01 = await tokenOf('teacher01');
  t02 = await tokenOf('teacher02');
  t03 = await tokenOf('teacher03');
  staff = await tokenOf('staff');
  admin = await tokenOf('admin');

  const occ = db
    .queryByTeacher(TERM, 'T01', FROM, TO)
    .find((row) => !row.cancelled);
  if (!occ) throw new Error('虚构样本缺少 T01 课次');

  const submitted = await call('/api/changes', {
    method: 'POST',
    token: t01,
    body: {
      termId: TERM,
      items: [
        {
          occurrenceId: occ.occurrenceId,
          kind: 'REASSIGN',
          toTeacherId: 'T02',
          toDate: null,
          toPeriod: null,
        },
      ],
      reason: '虚构理由：家中有事，需要与同事调换',
      idempotencyKey: 'READ-API-1',
    },
  });
  caseId = String(submitted.body.caseId ?? '');
  expect(submitted.status).toBe(200);
  expect(caseId).not.toBe('');
});

afterAll(async () => {
  if (started) await stopServer(started);
  db.close();
});

describe('静态页面', () => {
  it('根路径返回页面，并带禁止内联脚本与外部连接的 CSP', async () => {
    const r = await raw('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.text).toContain('<div id="app"');
  });

  it('脚本与样式按正确类型返回', async () => {
    const js = await raw('/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    const css = await raw('/styles.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('路径穿越拿不到仓库文件', async () => {
    for (const path of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json', '/web/../package.json']) {
      const r = await raw(path);
      expect(r.status === 200).toBe(false);
      expect(r.text).not.toContain('course-adjustment-system');
    }
  });

  it('未知静态路径不会退化成目录列举', async () => {
    const r = await raw('/web/');
    expect(r.status).not.toBe(200);
  });
});

describe('身份与能力视图', () => {
  it('未登录不能读取任何业务数据', async () => {
    for (const path of ['/api/meta', '/api/changes/mine', '/api/status', '/api/audit/mine']) {
      expect((await call(path)).status).toBe(401);
    }
  });

  it('/api/meta 返回学期与逐项能力判定', async () => {
    const r = await call('/api/meta', { token: t01 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const terms = r.body.terms as Array<Record<string, unknown>>;
    expect(terms[0]?.id).toBe(TERM);
    expect(terms[0]?.dataOrigin).toBe('SIMULATED');
    const caps = r.body.capabilities as Array<Record<string, unknown>>;
    const create = caps.find((c) => c.action === 'CREATE_OWN_CHANGE');
    expect(create?.verdict).toBe('ALLOWED');
    const publish = caps.find((c) => c.action === 'PUBLISH_TIMETABLE');
    expect(publish?.verdict).toBe('FORBIDDEN');
  });

  it('管理员在能力表中同样看到"确认本人课务：无此权限"，不因技术权限提权', async () => {
    const r = await call('/api/meta', { token: admin });
    const caps = r.body.capabilities as Array<Record<string, unknown>>;
    expect(caps.find((c) => c.action === 'DECIDE_OWN_CONFIRMATION')?.verdict).toBe('FORBIDDEN');
    expect(caps.find((c) => c.action === 'VIEW_SCHOOL_AUDIT')?.verdict).toBe('ALLOWED');
    // 结案确认：S/J 待校方确认，管理员连"待确认"都不是，直接无此权限
    expect(caps.find((c) => c.action === 'CONFIRM_CLOSURE')?.verdict).toBe('FORBIDDEN');
    const staffCaps = await call('/api/meta', { token: staff });
    const staffList = staffCaps.body.capabilities as Array<Record<string, unknown>>;
    expect(staffList.find((c) => c.action === 'CONFIRM_CLOSURE')?.verdict).toBe('ROLE_NOT_ASSIGNED');
  });

  it('/api/refs 只给姓名，不含账号或联系方式', async () => {
    const r = await call('/api/refs', { token: t01 });
    expect(r.status).toBe(200);
    const teachers = r.body.teachers as Array<Record<string, unknown>>;
    expect(teachers.length).toBeGreaterThan(0);
    expect(Object.keys(teachers[0] ?? {}).sort()).toEqual(['id', 'name']);
  });
});

describe('方案列表与详情', () => {
  it('列表只返回"我发起的"与"等我确认的"，不混入他人方案', async () => {
    const mine = await call('/api/changes/mine', { token: t01 });
    const submitted = mine.body.submitted as Array<Record<string, unknown>>;
    expect(submitted.some((c) => c.caseId === caseId)).toBe(true);

    const other = await call('/api/changes/mine', { token: t03 });
    const otherSubmitted = other.body.submitted as Array<Record<string, unknown>>;
    expect(otherSubmitted.some((c) => c.caseId === caseId)).toBe(false);
    expect((other.body.awaiting as unknown[]).length).toBe(0);
  });

  it('待我确认的条目出现在确认人列表里', async () => {
    const mine = await call('/api/changes/mine', { token: t02 });
    const awaiting = mine.body.awaiting as Array<Record<string, unknown>>;
    expect(awaiting.some((c) => c.caseId === caseId && c.awaitingMe === true)).toBe(true);
  });

  it('理由只对发起人返回；确认人与管理员都只看到排课事实', async () => {
    const asOwner = await call(`/api/changes/${caseId}`, { token: t01 });
    expect(asOwner.status).toBe(200);
    expect(String((asOwner.body.case as Record<string, unknown>).reason)).toContain('虚构理由');

    for (const token of [t02, staff, admin]) {
      const r = await call(`/api/changes/${caseId}`, { token });
      expect(r.status).toBe(200);
      expect((r.body.case as Record<string, unknown>).reason).toBeNull();
    }
  });

  it('无关教师读不到方案', async () => {
    const r = await call(`/api/changes/${caseId}`, { token: t03 });
    expect(r.status).toBe(403);
  });

  it('不存在的方案返回 404，而不是空对象', async () => {
    const r = await call('/api/changes/no-such-case', { token: t01 });
    expect(r.status).toBe(404);
  });

  it('畸形百分号编码按输入错误处理（400），不升级成 500', async () => {
    const res = await fetch(`${base}/api/changes/%E0%A4%A`, {
      headers: { authorization: `Bearer ${t01}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('BAD_INPUT');
  });
});

describe('应急与审计视图', () => {
  it('求助列表只含本人，管理员没有教师身份时被拒', async () => {
    const mine = await call('/api/emergency/mine', { token: t01 });
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.body.requests)).toBe(true);

    const asAdmin = await call('/api/emergency/mine', { token: admin });
    expect(asAdmin.status).toBe(403);
  });

  it('本人审计只含与自己相关的对象', async () => {
    const r = await call('/api/audit/mine', { token: t01 });
    expect(r.status).toBe(200);
    const events = r.body.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    // 只允许两类：我作为操作者（教师 ID 或账号 ID），或对象是我参与过的单据
    const me = await call('/api/me', { token: t01 });
    const userId = String((me.body.principal as Record<string, unknown>).userId);
    const allowed = new Set(['T01', userId, caseId]);
    expect(events.every((e) => allowed.has(String(e.actor)) || allowed.has(String(e.objectId)))).toBe(true);
    expect(events.map((e) => e.objectId)).toContain(caseId);
  });

  it('全校审计与系统状态：教师 403，课务员与管理员 200', async () => {
    expect((await call('/api/audit/recent', { token: t01 })).status).toBe(403);
    expect((await call('/api/status', { token: t01 })).status).toBe(403);
    for (const token of [staff, admin]) {
      expect((await call('/api/audit/recent', { token })).status).toBe(200);
      const r = await call('/api/status', { token });
      expect(r.status).toBe(200);
      const audit = r.body.audit as Record<string, unknown>;
      expect(audit.ok).toBe(true);
      const origins = r.body.origins as Record<string, number>;
      expect(origins.official).toBe(0);
      expect(origins.simulated).toBeGreaterThan(0);
    }
  });
});
