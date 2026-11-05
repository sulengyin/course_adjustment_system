/**
 * 界面端到端自检：真实进程 + 真实 HTTP + 虚构数据。
 *
 * 覆盖的是"点开页面能不能走完一条业务链"，而不是接口单元：
 *   登录 → 强制改密 → 我的课表 → 发起调课 → 对方确认 → 本人确认 → 生效 →
 *   对方课表出现该课次 → 求助 → 后续动作被拒 → 系统状态与审计链。
 *
 * 用法：npm run smoke:ui
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PASSWORD = { admin: 'Admin!2026smoke', teacher01: 'Teacher!2026x', teacher02: 'Teacher!2026y' };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE_FAIL: ${message}`);
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function runSeed(dbPath: string): Map<string, string> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-demo.ts'], {
    cwd: ROOT,
    env: { ...process.env, CA_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`种子数据写入失败（exit ${result.status}）：\n${result.stdout}\n${result.stderr}`);
  }
  const passwords = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s{2}(\w+)\s+.*?(?:初始)?口令\s+([^\s（]+)/.exec(line);
    if (match) passwords.set(match[1] as string, match[2] as string);
  }
  if (!passwords.has('admin') || !passwords.has('teacher01') || !passwords.has('teacher02')) {
    throw new Error(`无法从种子输出中解析初始口令：\n${result.stdout}`);
  }
  return passwords;
}

interface Reply {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

function makeClient(base: string) {
  return async function call(
    path: string,
    init: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  };
}

async function waitForReady(base: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务未在预期时间内启动：\n${log()}`);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'ca-ui-'));
  const dbPath = join(work, 'demo.sqlite');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const call = makeClient(base);

  const passwords = runSeed(dbPath);
  console.log(`种子数据：${dbPath}`);

  let output = '';
  const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/serve.ts'], {
    cwd: ROOT,
    env: { ...process.env, CA_BIND_ADDRESS: '127.0.0.1', CA_PORT: String(port), CA_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  server.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const cleanup = (): void => {
    server.kill('SIGTERM');
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  };

  try {
    await waitForReady(base, () => output);

    /* 1. 页面本身 */
    const page = await call('/');
    check(page.status === 200, `首页返回 ${page.status}`);
    check(String(page.data.raw ?? '').includes('id="app"'), '首页缺少挂载点');
    check((page.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), '缺少 CSP');
    check((page.headers.get('x-content-type-options') ?? '') === 'nosniff', '缺少 nosniff');
    const script = await call('/app.js');
    check(script.status === 200, '脚本未正确返回');
    console.log('页面与静态资源：OK');

    /* 2. 登录 + 强制改密 */
    async function login(loginName: string, initial: string, next: string): Promise<string> {
      const first = await call('/api/auth/login', { method: 'POST', body: { loginName, password: initial } });
      check(first.status === 200, `${loginName} 首次登录失败：${JSON.stringify(first.data)}`);
      check((first.data.principal as Record<string, unknown> | undefined)?.mustChangePassword === true, `${loginName} 未要求首次改密`);
      const token = String(first.data.token);
      const changed = await call('/api/me/password', {
        method: 'POST',
        token,
        body: { oldPassword: initial, newPassword: next },
      });
      check(changed.status === 200, `${loginName} 改密失败：${JSON.stringify(changed.data)}`);
      const again = await call('/api/auth/login', { method: 'POST', body: { loginName, password: next } });
      check(again.status === 200, `${loginName} 改密后登录失败`);
      return String(again.data.token);
    }

    const adminToken = await login('admin', passwords.get('admin') as string, PASSWORD.admin);
    const t01 = await login('teacher01', passwords.get('teacher01') as string, PASSWORD.teacher01);
    const t02 = await login('teacher02', passwords.get('teacher02') as string, PASSWORD.teacher02);
    console.log('登录与强制改密：OK');

    /* 3. 我的课表 */
    const meta = await call('/api/meta', { token: t01 });
    const term = (meta.data.terms as Array<Record<string, unknown>>)[0];
    if (!term) throw new Error('SMOKE_FAIL: 没有学期数据');
    const termId = String(term.id);
    const from = String(term.startMonday);
    const weekTo = addDays(from, 6);

    const view = await call(
      `/api/timetable/me?termId=${encodeURIComponent(termId)}&from=${from}&to=${weekTo}`,
      { token: t01 },
    );
    check(view.status === 200 && view.data.ok === true, `课表读取失败：${JSON.stringify(view.data)}`);
    const rows = (view.data.view as Record<string, unknown>).rows as Array<Record<string, unknown>>;
    check(rows.length > 0, '首周没有课次，无法继续');

    // 目标教师在该时段必须空闲，否则方案会因"描述不完整"被标记冲突。
    const t02Before = await call(
      `/api/timetable/teacher/T02?termId=${encodeURIComponent(termId)}&from=${from}&to=${weekTo}`,
      { token: t01 },
    );
    const busy = new Set(
      (((t02Before.data.view as Record<string, unknown>)?.rows as Array<Record<string, unknown>>) ?? []).map(
        (r) => `${String(r.date)}|${String(r.period)}`,
      ),
    );
    const target = rows.find((r) => r.cancelled === false && !busy.has(`${String(r.date)}|${String(r.period)}`));
    if (!target) throw new Error('SMOKE_FAIL: 找不到"接收方无课"的课次，无法构造调课场景');
    console.log(`我的课表：OK（首周 ${rows.length} 节，选取 ${String(target.date)} 第${String(target.period)}节）`);

    /* 4. 发起调课 → 对方确认 → 本人确认 → 生效 */
    const created = await call('/api/changes', {
      method: 'POST',
      token: t01,
      body: {
        termId,
        items: [
          {
            occurrenceId: target.occurrenceId,
            kind: 'REASSIGN',
            toTeacherId: 'T02',
            toDate: null,
            toPeriod: null,
          },
        ],
        reason: '冒烟脚本：虚构原因',
        idempotencyKey: `SMOKE-${Date.now()}`,
      },
    });
    check(created.status === 200 && created.data.ok === true, `提交调课失败：${JSON.stringify(created.data)}`);
    const caseId = String(created.data.caseId);
    const required = (created.data.required as string[]) ?? [];
    check(required.includes('T01') && required.includes('T02'), `必要确认者不正确：${required.join(',')}`);

    const mine02 = await call('/api/changes/mine', { token: t02 });
    const awaiting = (mine02.data.awaiting as Array<Record<string, unknown>>) ?? [];
    check(awaiting.some((c) => c.caseId === caseId), '对方没有看到待确认方案');

    for (const [token, who] of [
      [t02, 'T02'],
      [t01, 'T01'],
    ] as const) {
      const decided = await call(`/api/changes/${caseId}/decisions`, {
        method: 'POST',
        token,
        body: { decision: 'ACCEPT' },
      });
      check(decided.status === 200, `${who} 确认失败：${JSON.stringify(decided.data)}`);
    }

    const detail = await call(`/api/changes/${caseId}`, { token: t01 });
    const caseView = detail.data.case as Record<string, unknown> | undefined;
    check(caseView?.status === 'EFFECTIVE', `方案未生效：${String(caseView?.status)}`);

    const t02View = await call(`/api/timetable/me?termId=${encodeURIComponent(termId)}&from=${String(target.date)}&to=${String(target.date)}`, { token: t02 });
    const t02Rows = ((t02View.data.view as Record<string, unknown>)?.rows as Array<Record<string, unknown>>) ?? [];
    check(
      t02Rows.some((r) => r.occurrenceId === target.occurrenceId),
      '调课生效后，对方课表没有出现该课次',
    );
    console.log('调课闭环（提交→确认→生效→课表叠加）：OK');

    /* 5. 求助与"后续动作一律拒绝" */
    // 刚被改派的课次已不属于 T01，求助必须换一节仍在本人名下的课次。
    const emergencyOcc = rows.find((r) => r.occurrenceId !== target.occurrenceId && r.cancelled === false);
    if (!emergencyOcc) throw new Error('SMOKE_FAIL: 找不到可用于求助的本人课次');
    const helped = await call('/api/emergency/requests', {
      method: 'POST',
      token: t01,
      body: {
        termId,
        occurrenceId: emergencyOcc.occurrenceId,
        note: '冒烟脚本：虚构情况说明',
        idempotencyKey: `SMOKE-EM-${Date.now()}`,
      },
    });
    check(helped.status === 200 && helped.data.ok === true, `求助失败：${JSON.stringify(helped.data)}`);
    const requestId = String(helped.data.requestId);

    const claim = await call(`/api/emergency/requests/${requestId}/claim`, { method: 'POST', token: t01 });
    check(claim.status === 403, `教师接单未被拒绝：${claim.status}`);
    check(claim.data.code === 'FORBIDDEN', `接单拒绝码异常：${String(claim.data.code)}`);

    const mineEm = await call('/api/emergency/mine', { token: t01 });
    check(((mineEm.data.requests as unknown[]) ?? []).length === 1, '求助列表数量异常');

    const adminEm = await call('/api/emergency/mine', { token: adminToken });
    check(adminEm.status === 403, '管理员不应看到他人求助列表');
    console.log('应急求助（登记成功、后续动作拒绝）：OK');

    /* 6. 系统状态与审计链 */
    const status = await call('/api/status', { token: adminToken });
    check(status.status === 200, `系统状态不可读：${status.status}`);
    check((status.data.audit as Record<string, unknown>).ok === true, '审计链校验失败');
    check((status.data.origins as Record<string, number>).official === 0, '模拟数据被标成了正式数据');
    check(Number((status.data.counts as Record<string, unknown>).effectiveChanges ?? 0) >= 1, '生效记录未计入');

    const teacherStatus = await call('/api/status', { token: t01 });
    check(teacherStatus.status === 403, '教师不应看到全校状态');
    console.log('系统状态与审计链：OK');

    /* 7. 越权与穿越 */
    const outsider = await call(`/api/changes/${caseId}`, { token: await loginSilently() });
    check(outsider.status === 403, `无关教师读到了方案：${outsider.status}`);

    async function loginSilently(): Promise<string> {
      const t03 = await call('/api/auth/login', { method: 'POST', body: { loginName: 'teacher03', password: passwords.get('teacher03') } });
      check(t03.status === 200, 'teacher03 登录失败');
      const token = String(t03.data.token);
      const changed = await call('/api/me/password', {
        method: 'POST',
        token,
        body: { oldPassword: passwords.get('teacher03'), newPassword: 'Teacher!2026z' },
      });
      check(changed.status === 200, 'teacher03 改密失败');
      const again = await call('/api/auth/login', { method: 'POST', body: { loginName: 'teacher03', password: 'Teacher!2026z' } });
      return String(again.data.token);
    }

    const traversal = await fetch(`${base}/..%2Fpackage.json`);
    check(traversal.status !== 200, '路径穿越返回了 200');
    const traversalBody = await traversal.text();
    check(!traversalBody.includes('course-adjustment-spec'), '路径穿越读到了 package.json');
    console.log('越权与路径穿越：OK');

    console.log('SMOKE_UI_OK');
  } catch (error) {
    console.error((error as Error).message);
    console.error('--- 服务日志（末尾） ---');
    console.error(output.slice(-2000));
    process.exitCode = 1;
  } finally {
    cleanup();
    await new Promise((r) => setTimeout(r, 200));
  }
}

void main();
