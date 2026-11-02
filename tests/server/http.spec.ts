import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/service.js';
import { ChangeService } from '../../src/service/change-service.js';
import { EmergencyService } from '../../src/service/emergency-service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';
import { startServer, stopServer, type StartedServer } from '../../src/server/start.js';
import { ServerConfigError, validateServerConfig } from '../../src/server/config.js';
import { createLogger } from '../../src/log/logger.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';
const BOOT = 'Boot!Pass2026x';
const TEACHER_PW = 'Teacher!2026x';

let db: CourseDatabase;
let auth: AuthService;
let changes: ChangeService;
let emergency: EmergencyService;
let timetable: TimetableService;
let started: StartedServer;
let base: string;
const logLines: string[] = [];

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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function loginThroughHttp(loginName: string, password: string, actingRole?: string): Promise<string> {
  const r = await call('/api/auth/login', { method: 'POST', body: { loginName, password, actingRole } });
  if (r.status !== 200) throw new Error(`登录失败：${JSON.stringify(r.body)}`);
  return String(r.body.token);
}

beforeAll(async () => {
  db = new CourseDatabase(':memory:');
  timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(TERM, FROM, TO);
  auth = new AuthService(db, { now: () => new Date().toISOString() });
  changes = new ChangeService(db);
  emergency = new EmergencyService(db);

  const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '管理员', password: BOOT });
  void boot;
  const first = auth.login('admin', BOOT, 'A');
  if (!first.ok) throw new Error('bootstrap login failed');
  auth.changePassword(first.principal, BOOT, 'Admin!Pass2026x');
  const admin = auth.login('admin', 'Admin!Pass2026x', 'A');
  if (!admin.ok) throw new Error('admin relogin failed');

  const teacherId = DEMO_SNAPSHOT.teachers[0]?.id as string;
  const created = auth.createUser(admin.principal, {
    loginName: 'teacher01',
    displayName: '示例教师',
    teacherId,
    roles: ['T'],
  });
  const t = auth.login('teacher01', created.initialPassword);
  if (!t.ok) throw new Error('teacher login failed');
  auth.changePassword(t.principal, created.initialPassword, TEACHER_PW);

  started = await startServer(
    { bindAddress: '127.0.0.1', port: 0, tls: null, requireTls: false },
    {
      db,
      auth,
      changes,
      timetable,
      emergency,
      logger: createLogger({ sink: (line) => logLines.push(line), now: () => '2026-11-01T00:00:00.000Z' }),
    },
  );
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  if (started) await stopServer(started);
  db.close();
});

describe('网络边界配置', () => {
  it('拒绝通配地址', () => {
    for (const address of ['0.0.0.0', '::', '::0']) {
      expect(() => validateServerConfig({ bindAddress: address, port: 8080, tls: null, requireTls: false })).toThrow(
        ServerConfigError,
      );
    }
  });

  it('拒绝公网地址与主机名', () => {
    expect(() => validateServerConfig({ bindAddress: '8.8.8.8', port: 8080, tls: null, requireTls: false })).toThrow(
      /只允许绑定回环或私有地址/,
    );
    expect(() =>
      validateServerConfig({ bindAddress: 'intranet.example.edu', port: 8080, tls: null, requireTls: false }),
    ).toThrow(/必须是 IP 字面量/);
  });

  it('允许私有网段与回环', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.20', '::1', 'fd00::1']) {
      expect(() =>
        validateServerConfig({ bindAddress: address, port: 8080, tls: null, requireTls: false }),
      ).not.toThrow();
    }
  });

  it('要求 TLS 但无证书时拒绝启动，不降级为明文', () => {
    expect(() =>
      validateServerConfig({ bindAddress: '127.0.0.1', port: 8080, tls: null, requireTls: true }),
    ).toThrow(/拒绝以明文启动/);
  });

  it('启动后实际绑定地址与配置一致', async () => {
    expect(started.address).toBe('127.0.0.1');
    expect(started.tls).toBe(false);
  });
});

describe('HTTP 身份边界', () => {
  it('访问日志只含白名单字段：无口令、无手机号', async () => {
    await call('/api/auth/login', {
      method: 'POST',
      body: { loginName: 'teacher01', password: TEACHER_PW },
    });
    await call('/api/auth/login', {
      method: 'POST',
      body: { loginName: '13800138000', password: '13800138000' },
    });
    const joined = logLines.join('\n');
    expect(joined).toContain('HTTP_REQUEST');
    expect(joined).not.toContain(TEACHER_PW);
    expect(joined).not.toContain('13800138000');
    expect(joined).not.toContain('password');
  });

  it('健康检查不校验身份，但会报告审计链状态', async () => {
    const r = await call('/api/healthz');
    expect(r.status).toBe(200);
    expect((r.body.audit as { ok: boolean }).ok).toBe(true);
  });

  it('无 token 一律 401', async () => {
    const r = await call('/api/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('首登未改密时只能访问 /api/me，其余接口被拒', async () => {
    const teacherId = DEMO_SNAPSHOT.teachers[1]?.id as string;
    const admin = auth.login('admin', 'Admin!Pass2026x', 'A');
    if (!admin.ok) throw new Error('admin login failed');
    const created = auth.createUser(admin.principal, {
      loginName: 'fresh01',
      displayName: '新人',
      teacherId,
      roles: ['T'],
    });
    const token = await loginThroughHttp('fresh01', created.initialPassword);

    const me = await call('/api/me', { token });
    expect(me.status).toBe(200);
    expect((me.body.principal as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    const denied = await call(`/api/timetable/me?termId=${TERM}&from=${FROM}&to=${TO}`, { token });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('登录 → 查本人课表 → 改密后旧 token 失效', async () => {
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    const view = await call(`/api/timetable/me?termId=${TERM}&from=${FROM}&to=${TO}`, { token });
    expect(view.status).toBe(200);
    expect((view.body.view as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    const changed = await call('/api/me/password', {
      method: 'POST',
      token,
      body: { oldPassword: TEACHER_PW, newPassword: 'Teacher!2027y' },
    });
    expect(changed.status).toBe(200);
    const after = await call('/api/me', { token });
    expect(after.status).toBe(401);

    // 改回来，避免影响后续用例
    const next = await loginThroughHttp('teacher01', 'Teacher!2027y', 'T');
    await call('/api/me/password', {
      method: 'POST',
      token: next,
      body: { oldPassword: 'Teacher!2027y', newPassword: TEACHER_PW },
    });
  });

  it('请求体里的 teacherId 不被采信，操作人始终是登录者', async () => {
    const teacherId = DEMO_SNAPSHOT.teachers[0]?.id as string;
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    const all = changes.activeAssignments(TERM).filter((a) => !a.cancelled);
    const busy = (t: string, d: string, p: number): boolean => all.some((x) => x.teacherId === t && x.date === d && x.period === p);
    const teachers = [...new Set(all.map((a) => a.teacherId))];
    let mine = all.find((a) => a.teacherId === teacherId);
    let other = teachers.find((t) => t !== teacherId);
    for (const candidate of all.filter((a) => a.teacherId === teacherId)) {
      const free = teachers.find((t) => t !== teacherId && !busy(t, candidate.date, candidate.period));
      if (free) {
        mine = candidate;
        other = free;
        break;
      }
    }
    if (!mine || !other) throw new Error('样本不足');

    const r = await call('/api/changes', {
      method: 'POST',
      token,
      body: {
        termId: TERM,
        // 伪造字段：服务端不读
        teacherId: other,
        submittedBy: other,
        items: [
          {
            occurrenceId: mine.occurrenceId,
            kind: 'REASSIGN',
            toTeacherId: other,
            toDate: null,
            toPeriod: null,
          },
        ],
        reason: null,
        idempotencyKey: 'HTTP-IDEM-1',
      },
    });
    expect(r.status).toBe(200);
    const caseId = String(r.body.caseId);
    const record = changes.getCase(caseId);
    expect(record?.submittedBy).toBe(teacherId);
  });

  it('畸形变更条目返回 400，不落到服务层炸成 500', async () => {
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    const before = changes.activeAssignments(TERM).length;
    const malformed: unknown[] = [
      'not-an-array',
      [null],
      [{ occurrenceId: '', kind: 'REASSIGN' }],
      [{ occurrenceId: 'X', kind: 'DELETE' }],
      [{ occurrenceId: 'X', kind: 'MOVE', toPeriod: '3' }],
      [{ occurrenceId: 'X', kind: 'REASSIGN', toTeacherId: 42 }],
    ];
    for (const items of malformed) {
      const r = await call('/api/changes', {
        method: 'POST',
        token,
        body: { termId: TERM, items, reason: null, idempotencyKey: 'BAD-SHAPE' },
      });
      expect(r.status, JSON.stringify(items)).toBe(400);
      expect(r.body.code).toBe('BAD_INPUT');
    }
    expect(changes.activeAssignments(TERM).length).toBe(before);
  });

  it('写接口缺少幂等键返回 400', async () => {
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    const r = await call('/api/changes', {
      method: 'POST',
      token,
      body: { termId: TERM, items: [{ occurrenceId: 'X', kind: 'CANCEL' }], reason: null },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_INPUT');
  });

  it('确认决定只接受 ACCEPT / DECLINE，其他取值一律 400', async () => {
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    for (const decision of ['accept', 'MAYBE', '', null, 1, true]) {
      const r = await call('/api/changes/any-case/decisions', {
        method: 'POST',
        token,
        body: { decision },
      });
      expect(r.status, String(decision)).toBe(400);
      expect(r.body.code).toBe('BAD_INPUT');
    }
  });

  it('求助只针对本人课次，且只能本人查看', async () => {
    const teacherId = DEMO_SNAPSHOT.teachers[0]?.id as string;
    const own = changes.activeAssignments(TERM).find((a) => a.teacherId === teacherId && !a.cancelled);
    if (!own) throw new Error('样本不足');
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');

    const created = await call('/api/emergency/requests', {
      method: 'POST',
      token,
      body: {
        termId: TERM,
        occurrenceId: own.occurrenceId,
        note: '临时无法到校，需要有人照看',
        idempotencyKey: 'HTTP-ER-1',
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.code).toBe('REQUESTED');
    const id = String(created.body.requestId);

    const view = await call(`/api/emergency/requests/${id}`, { token });
    expect(view.status).toBe(200);
    expect(view.body.notified).toBe(false);
    const request = view.body.request as Record<string, unknown>;
    expect(request.ownerTeacherId).toBeNull();
    expect(request.teachingVerification).toBe('PENDING');

    const adminToken = await loginThroughHttp('admin', 'Admin!Pass2026x', 'A');
    const denied = await call(`/api/emergency/requests/${id}`, { token: adminToken });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
  });

  it('求助接口：缺说明与缺幂等键 400，为他人课次 403', async () => {
    const teacherId = DEMO_SNAPSHOT.teachers[0]?.id as string;
    const own = changes.activeAssignments(TERM).find((a) => a.teacherId === teacherId && !a.cancelled);
    const foreign = changes.activeAssignments(TERM).find((a) => a.teacherId !== teacherId && !a.cancelled);
    if (!own || !foreign) throw new Error('样本不足');
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');

    const noNote = await call('/api/emergency/requests', {
      method: 'POST',
      token,
      body: { termId: TERM, occurrenceId: own.occurrenceId, note: '  ', idempotencyKey: 'HTTP-ER-2' },
    });
    expect(noNote.status).toBe(400);
    expect(noNote.body.code).toBe('BAD_INPUT');

    const noKey = await call('/api/emergency/requests', {
      method: 'POST',
      token,
      body: { termId: TERM, occurrenceId: own.occurrenceId, note: '需要帮助' },
    });
    expect(noKey.status).toBe(400);

    const other = await call('/api/emergency/requests', {
      method: 'POST',
      token,
      body: { termId: TERM, occurrenceId: foreign.occurrenceId, note: '需要帮助', idempotencyKey: 'HTTP-ER-3' },
    });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('FORBIDDEN');
  });

  it('只涉及他人课务的方案被拒绝', async () => {
    const teacherId = DEMO_SNAPSHOT.teachers[0]?.id as string;
    const token = await loginThroughHttp('teacher01', TEACHER_PW, 'T');
    const foreign = changes.activeAssignments(TERM).find((a) => a.teacherId !== teacherId && !a.cancelled);
    if (!foreign) throw new Error('样本不足');
    const third = [...new Set(changes.activeAssignments(TERM).map((a) => a.teacherId))].find(
      (t) => t !== foreign.teacherId,
    );

    const r = await call('/api/changes', {
      method: 'POST',
      token,
      body: {
        termId: TERM,
        items: [
          {
            occurrenceId: foreign.occurrenceId,
            kind: 'REASSIGN',
            toTeacherId: third,
            toDate: null,
            toPeriod: null,
          },
        ],
        reason: null,
        idempotencyKey: 'HTTP-IDEM-2',
      },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });
});

describe('身份切换接口', () => {
  it('切到课务身份后新令牌生效、旧令牌作废，权限按新身份重算', async () => {
    const asAdmin = auth.login('admin', 'Admin!Pass2026x', 'A');
    if (!asAdmin.ok) throw new Error('admin login failed');
    auth.grantRole(asAdmin.principal, asAdmin.principal.userId, 'S');

    const token = await loginThroughHttp('admin', 'Admin!Pass2026x', 'A');
    const switched = await call('/api/auth/switch-role', {
      method: 'POST',
      token,
      body: { actingRole: 'S' },
    });
    expect(switched.status).toBe(200);
    const newToken = String(switched.body.token);
    expect(newToken).not.toBe(token);

    const me = await call('/api/me', { token: newToken });
    expect((me.body.principal as { actingRole: string }).actingRole).toBe('S');

    const stale = await call('/api/me', { token });
    expect(stale.status).toBe(401);

    const meta = await call('/api/meta', { token: newToken });
    const caps = meta.body.capabilities as Array<{ action: string; verdict: string }>;
    expect(caps.find((c) => c.action === 'IMPORT_TIMETABLE')?.verdict).toBe('ALLOWED');
    expect(caps.find((c) => c.action === 'MANAGE_ACCOUNTS')?.verdict).toBe('FORBIDDEN');
  });

  it('切换到未授予自己的角色返回 403', async () => {
    const token = await loginThroughHttp('admin', 'Admin!Pass2026x', 'A');
    const r = await call('/api/auth/switch-role', {
      method: 'POST',
      token,
      body: { actingRole: 'T' },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ROLE_NOT_GRANTED');
  });
});
