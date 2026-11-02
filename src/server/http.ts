/**
 * 最小 HTTP 服务。零运行时依赖（node:http），便于纯内网离线部署。
 *
 * 身份边界（R-25 的修复点）：
 *  - 只从 `Authorization: Bearer <token>` 取会话；请求体里的 teacherId/userId 一律不读。
 *  - 首登未改密时，除 /api/me、/api/me/password、/api/auth/logout 外一律 403。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthService } from '../auth/service.js';
import { AuthError, PolicyDeniedError } from '../auth/service.js';
import type { Principal } from '../auth/principal.js';
import { can } from '../auth/policy.js';
import type { ChangeService } from '../service/change-service.js';
import { CandidateService } from '../service/candidate-service.js';
import {
  ChangePreferenceService,
  inputToPreference,
  parsePreferenceInput,
  recordToPreference,
} from '../service/change-preference-service.js';
import type { PreferenceRecord } from '../store/database.js';
import type { TimetableService } from '../service/timetable-service.js';
import type { EmergencyService, EmergencySummary } from '../service/emergency-service.js';
import { StatusService } from '../service/status-service.js';
import type { ChangeItem, ChangeItemKind } from '../domain/change.js';
import type { CourseDatabase } from '../store/database.js';
import type { Logger } from '../log/logger.js';

export interface AppDeps {
  readonly db: CourseDatabase;
  readonly auth: AuthService;
  readonly changes: ChangeService;
  readonly timetable: TimetableService;
  readonly emergency: EmergencyService;
  readonly status?: StatusService;
  readonly candidates?: CandidateService;
  readonly preferences?: ChangePreferenceService;
  readonly logger?: Logger;
  readonly now?: () => string;
}

/**
 * 界面资源白名单：路径 → 文件。
 * 用白名单而不是 `join(WEB_ROOT, path)`，路径穿越在构造上就不存在，
 * 也不存在"目录列举"这种需要额外关闭的能力。
 */
const STATIC_FILES: Readonly<Record<string, { readonly file: string; readonly type: string }>> = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
});

const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

/**
 * 页面不允许内联脚本/内联样式，也不允许外连任何主机。
 * 这样即使某处误把用户输入拼进了 HTML，也拿不到可执行的注入面。
 */
const STATIC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
});

const MAX_BODY_BYTES = 256 * 1024;

interface Json {
  readonly [key: string]: unknown;
}

function send(res: ServerResponse, status: number, payload: Json | null): void {
  if (payload === null) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{}');
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function fail(res: ServerResponse, status: number, code: string, message?: string): void {
  send(res, status, message ? { ok: false, code, message } : { ok: false, code });
}

/** 静态资源只从白名单取；读不到时明确报错，不返回半截页面。 */
function sendStatic(res: ServerResponse, entry: { file: string; type: string }, headOnly: boolean): void {
  let body: Buffer;
  try {
    body = readFileSync(join(WEB_ROOT, entry.file));
  } catch {
    const text = Buffer.from('WEB_ASSET_MISSING', 'utf8');
    res.writeHead(500, { ...STATIC_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
    return;
  }
  res.writeHead(200, { ...STATIC_HEADERS, 'content-type': entry.type, 'content-length': String(body.length) });
  res.end(headOnly ? undefined : body);
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Json;
  } catch {
    return null;
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** 路径段解码失败（如 %E0%A4%A）属于输入错误，不能让它变成 500。 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const KINDS: readonly ChangeItemKind[] = ['REASSIGN', 'MOVE', 'CANCEL'];

/**
 * 只校验"形状"，不校验"语义"（缺少目标、日期非法等由领域层判定并给出带错误码的结果）。
 * 目的：畸形请求得到 400，而不是在服务层炸成 500 —— 500 既暴露实现细节，也让调用方
 * 误以为"服务端出错，重试可能成功"。
 */
function parseChangeItems(raw: unknown): ChangeItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: ChangeItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const occurrenceId = row.occurrenceId;
    const kind = row.kind;
    if (typeof occurrenceId !== 'string' || occurrenceId === '') return null;
    if (typeof kind !== 'string' || !KINDS.includes(kind as ChangeItemKind)) return null;
    const toTeacherId = row.toTeacherId ?? null;
    const toDate = row.toDate ?? null;
    const toPeriod = row.toPeriod ?? null;
    if (toTeacherId !== null && typeof toTeacherId !== 'string') return null;
    if (toDate !== null && typeof toDate !== 'string') return null;
    if (toPeriod !== null && (typeof toPeriod !== 'number' || !Number.isInteger(toPeriod))) return null;
    items.push({ occurrenceId, kind: kind as ChangeItemKind, toTeacherId, toDate, toPeriod });
  }
  return items;
}

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createHandler(deps: AppDeps): RequestListener {
  const status = deps.status ?? new StatusService(deps.db, deps.now);
  const candidates = deps.candidates ?? new CandidateService(deps.db);
  const preferences = deps.preferences ?? new ChangePreferenceService(deps.db, deps.now ? { now: deps.now } : {});
  return (req, res) => {
    const startedAt = Date.now();
    if (deps.logger) {
      const pathOnly = (req.url ?? '/').split('?')[0] ?? '/';
      res.on('finish', () => {
        deps.logger?.info('HTTP_REQUEST', {
          method: req.method ?? 'GET',
          path: pathOnly,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });
    }
    void handle(deps, req, res).catch((error: unknown) => {
      // 响应已开始写出时无法再改状态码；再调用 writeHead 会抛 ERR_HTTP_HEADERS_SENT
      // 并变成未捕获异常，可能带走整个进程。
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof AuthError) {
        const status = error.code === 'INVALID_CREDENTIALS' || error.code === 'ACCOUNT_DISABLED' ? 401 : 400;
        fail(res, status, error.code, error.message);
        return;
      }
      if (error instanceof PolicyDeniedError) {
        fail(res, 403, error.code);
        return;
      }
      deps.logger?.error('HTTP_INTERNAL_ERROR', { code: 'INTERNAL_ERROR' });
      fail(res, 500, 'INTERNAL_ERROR');
    });
  };

  async function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // 界面资源：不鉴权（登录页本身也要能加载），但只认白名单里的四个路径。
    if ((method === 'GET' || method === 'HEAD') && Object.hasOwn(STATIC_FILES, path)) {
      sendStatic(res, STATIC_FILES[path] as { file: string; type: string }, method === 'HEAD');
      return;
    }
    if (path === '/favicon.ico' && (method === 'GET' || method === 'HEAD')) {
      res.writeHead(204, STATIC_HEADERS);
      res.end();
      return;
    }

    // 环境标识不做鉴权：它要在登录页之前就能显示，且本身不含业务数据。
    if (path === '/api/env' && method === 'GET') {
      send(res, 200, { ok: true, deploymentMode: deps.db.deploymentMode() });
      return;
    }

    if (path === '/api/healthz' && method === 'GET') {
      const chain = deps.db.auditLog.verify();
      send(res, chain.ok ? 200 : 503, {
        ok: chain.ok,
        audit: { ok: chain.ok, length: chain.length, brokenAt: chain.brokenAt },
      });
      return;
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const loginName = typeof body.loginName === 'string' ? body.loginName : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const actingRole = typeof body.actingRole === 'string' ? body.actingRole : undefined;
      const result = deps.auth.login(loginName, password, actingRole);
      if (!result.ok) {
        const status = result.code === 'INVALID_CREDENTIALS' || result.code === 'ACCOUNT_DISABLED' ? 401 : 409;
        send(res, status, { ok: false, code: result.code, roles: result.roles ?? [] });
        return;
      }
      send(res, 200, {
        ok: true,
        token: result.token,
        expiresAt: result.expiresAt,
        principal: publicPrincipal(result.principal),
      });
      return;
    }

    const principal = deps.auth.authenticate(bearer(req));
    if (!principal) return fail(res, 401, 'UNAUTHENTICATED');

    if (path === '/api/auth/logout' && method === 'POST') {
      deps.auth.logout(principal);
      send(res, 200, { ok: true });
      return;
    }

    // 身份切换：一人多角色时换身份不等于换人。旧会话当场作废、签发新会话，
    // 两件事都写审计（SWITCH_ROLE），因此审计里始终能看出"那一刻是以什么身份在操作"。
    if (path === '/api/auth/switch-role' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const actingRole = typeof body.actingRole === 'string' ? body.actingRole : '';
      try {
        const next = deps.auth.switchRole(principal, actingRole);
        send(res, 200, { ok: true, token: next.token, principal: publicPrincipal(next.principal) });
      } catch (error) {
        if (error instanceof AuthError) {
          fail(res, error.code === 'ROLE_NOT_GRANTED' ? 403 : 400, error.code, error.message);
          return;
        }
        throw error;
      }
      return;
    }

    if (path === '/api/me' && method === 'GET') {
      send(res, 200, { ok: true, principal: publicPrincipal(principal) });
      return;
    }

    // 登录页与"首登改密"页都需要它，因此放在 mustChangePassword 闸门之前。
    if (path === '/api/meta' && method === 'GET') {
      send(res, 200, status.meta(principal) as unknown as Json);
      return;
    }

    if (path === '/api/refs' && method === 'GET') {
      const refs = deps.db.refs();
      send(res, 200, {
        ok: true,
        teachers: refs.teachers.map((t) => ({ id: t.id, name: t.name })),
        classes: refs.classes.map((c) => ({ id: c.id, name: c.name })),
        subjects: refs.subjects.map((s) => ({ id: s.id, name: s.name })),
      });
      return;
    }

    if (path === '/api/me/password' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      deps.auth.changePassword(principal, oldPassword, newPassword);
      send(res, 200, { ok: true, reauthRequired: true });
      return;
    }

    // 首登未改密：其余接口全部拒绝
    if (principal.mustChangePassword) return fail(res, 403, 'PASSWORD_CHANGE_REQUIRED');

    if (path === '/api/timetable/me' && method === 'GET') {
      if (!principal.teacherId) return fail(res, 403, 'NOT_A_TEACHER');
      if (!can(principal, 'VIEW_OWN_TIMETABLE').allowed) return fail(res, 403, 'FORBIDDEN');
      const termId = url.searchParams.get('termId');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!termId || !from || !to) return fail(res, 400, 'BAD_INPUT');
      const view = deps.timetable.teacherView(termId, principal.teacherId, from, to);
      send(res, 200, { ok: true, view });
      return;
    }

    const teacherTimetable = /^\/api\/timetable\/teacher\/([^/]+)$/.exec(path);
    if (teacherTimetable && method === 'GET') {
      if (!can(principal, 'VIEW_OTHER_TIMETABLE').allowed) return fail(res, 403, 'FORBIDDEN');
      const termId = url.searchParams.get('termId');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!termId || !from || !to) return fail(res, 400, 'BAD_INPUT');
      const view = deps.timetable.teacherView(termId, decodeURIComponent(teacherTimetable[1] as string), from, to);
      // 他人课表只给排课事实：不含理由、联系方式、请假细节
      send(res, 200, { ok: true, view });
      return;
    }

    // 列表与详情都只返回"我有权看的那部分"，过滤在服务层完成，不依赖前端。
    if (path === '/api/changes/mine' && method === 'GET') {
      const view = deps.changes.listMine(principal);
      send(res, 200, { ok: true, submitted: view.submitted, awaiting: view.awaiting });
      return;
    }

    // 调课对象候选：只读排课事实，不落库；只有该课次的现任授课教师能拿到名单。
    // 必须排在 /api/changes/:id 之前，否则会被方案详情的正则吃掉。
    if (path === '/api/changes/candidates' && method === 'GET') {
      const termId = url.searchParams.get('termId');
      const occurrenceId = url.searchParams.get('occurrenceId');
      if (!termId || !occurrenceId) return fail(res, 400, 'BAD_INPUT');
      // 换时间的方案必须按目标时段评估，否则推荐的是错的时段
      const rawPeriod = url.searchParams.get('toPeriod');
      const toPeriod = rawPeriod === null ? null : Number(rawPeriod);
      if (rawPeriod !== null && (!Number.isInteger(toPeriod) || (toPeriod as number) < 1)) {
        return fail(res, 400, 'BAD_INPUT');
      }
      const suggestion = candidates.suggest(termId, occurrenceId, principal, {
        toDate: url.searchParams.get('toDate'),
        toPeriod,
      });
      const code = suggestion.code;
      const httpStatus =
        code === 'FOUND'
          ? 200
          : code === 'OCCURRENCE_NOT_FOUND'
            ? 404
            : code === 'OCCURRENCE_CANCELLED'
              ? 409
              : 403;
      send(res, httpStatus, suggestion as unknown as Json);
      return;
    }

    /**
     * 候选预览：把界面上临时改过的筛选条件直接算一遍，不落库。
     * 之所以用 POST：筛选条件是一个对象，塞进查询串既长又容易被截断。
     */
    if (path === '/api/changes/candidates/preview' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const termId = typeof body.termId === 'string' ? body.termId : '';
      const occurrenceId = typeof body.occurrenceId === 'string' ? body.occurrenceId : '';
      if (termId === '' || occurrenceId === '') return fail(res, 400, 'BAD_INPUT');
      // 不传 preference 就用调用者生效的那套（个人 > 全校 > 中性）。
      // 传了就按传来的算：形状不对一律 400，不静默补全。
      const input =
        body.preference === undefined
          ? preferences.effectiveInput(principal.teacherId)
          : parsePreferenceInput(body.preference);
      if (input === null) return fail(res, 400, 'BAD_INPUT');
      const toDate = typeof body.toDate === 'string' ? body.toDate : null;
      const rawPeriod = body.toPeriod;
      if (rawPeriod !== undefined && rawPeriod !== null && !Number.isInteger(rawPeriod)) {
        return fail(res, 400, 'BAD_INPUT');
      }
      const suggestion = candidates.suggest(termId, occurrenceId, principal, {
        toDate,
        toPeriod: typeof rawPeriod === 'number' ? rawPeriod : null,
        preference: inputToPreference(input),
      });
      send(res, suggestion.ok ? 200 : 404, suggestion as unknown as Json);
      return;
    }

    /**
     * 调课候选筛选偏好：读自己生效的那套（个人覆盖 > 全校默认 > 中性默认），
     * 并同时给出全校默认，便于界面说明"当前用的是谁的口径"。
     */
    if (path === '/api/preferences/change' && method === 'GET') {
      const effective = preferences.effective(principal.teacherId);
      send(res, 200, {
        ok: true,
        source: effective.source,
        preference: toPreferenceJson(effective.preference),
        school: effective.school === null ? null : toRecordJson(effective.school),
        mine: effective.mine === null ? null : toRecordJson(effective.mine),
        canEditSchool: can(principal, 'CHANGE_L1_CONFIG').allowed,
      });
      return;
    }

    // 教师改自己的偏好：身份即授权，不需要角色；无教师身份者没有"自己的偏好"可改。
    if (path === '/api/preferences/change' && method === 'PUT') {
      if (!principal.teacherId) return fail(res, 403, 'NOT_A_TEACHER');
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const input = parsePreferenceInput(body);
      if (input === null) return fail(res, 400, 'BAD_INPUT');
      const saved = preferences.saveTeacher(principal.teacherId, input);
      send(res, 200, { ok: true, saved: toRecordJson(saved) });
      return;
    }

    // 全校默认属 L1 参数：只有课务管理人员可改（CHANGE_L1_CONFIG），管理员也不代管。
    if (path === '/api/preferences/change/school' && method === 'PUT') {
      if (!can(principal, 'CHANGE_L1_CONFIG').allowed) return fail(res, 403, 'FORBIDDEN');
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const input = parsePreferenceInput(body);
      if (input === null) return fail(res, 400, 'BAD_INPUT');
      const saved = preferences.saveSchool(input, principal.userId);
      send(res, 200, { ok: true, saved: toRecordJson(saved) });
      return;
    }

    const caseDetail = /^\/api\/changes\/([^/]+)$/.exec(path);
    if (caseDetail && method === 'GET') {
      const caseId = decodeSegment(caseDetail[1] as string);
      if (caseId === null) return fail(res, 400, 'BAD_INPUT');
      const detail = deps.changes.detail(principal, caseId);
      if (detail.code === 'CASE_NOT_FOUND') return fail(res, 404, 'CASE_NOT_FOUND');
      if (detail.code === 'FORBIDDEN') return fail(res, 403, 'FORBIDDEN');
      send(res, 200, {
        ok: true,
        case: detail.case,
        events: deps.changes.audit(detail.case?.caseId ?? ''),
      });
      return;
    }

    if (path === '/api/emergency/mine' && method === 'GET') {
      const mine = deps.emergency.listMine(principal);
      send(res, mine.ok ? 200 : 403, { ok: mine.ok, code: mine.code, requests: mine.requests });
      return;
    }

    if (path === '/api/audit/mine' && method === 'GET') {
      send(res, 200, { ok: true, events: status.auditForSelf(principal) });
      return;
    }

    if (path === '/api/status' && method === 'GET') {
      const view = status.school(principal);
      if (view === null) return fail(res, 403, 'FORBIDDEN');
      send(res, 200, view as unknown as Json);
      return;
    }

    if (path === '/api/audit/recent' && method === 'GET') {
      const raw = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.trunc(raw), 200)) : 50;
      const events = status.schoolAudit(principal, limit);
      if (events === null) return fail(res, 403, 'FORBIDDEN');
      send(res, 200, { ok: true, events });
      return;
    }

    if (path === '/api/changes' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const items = parseChangeItems(body.items ?? []);
      if (items === null) return fail(res, 400, 'BAD_INPUT');
      // 写操作必须带幂等键：缺失时无法区分"重试"与"新请求"，重试会重复建单。
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
      if (idempotencyKey === '') return fail(res, 400, 'BAD_INPUT');
      const summary = deps.changes.submitNew({
        termId: String(body.termId ?? ''),
        principal,
        items,
        reason: typeof body.reason === 'string' ? body.reason : null,
        idempotencyKey,
      });
      send(res, summary.ok ? 200 : 409, summary as unknown as Json);
      return;
    }

    const decision = /^\/api\/changes\/([^/]+)\/decisions$/.exec(path);
    if (decision && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      // 未知取值一律拒绝：默认为"同意"会让一次拼写错误变成一次不可撤销的接受。
      if (body.decision !== 'ACCEPT' && body.decision !== 'DECLINE') return fail(res, 400, 'BAD_INPUT');
      const caseId = decodeSegment(decision[1] as string);
      if (caseId === null) return fail(res, 400, 'BAD_INPUT');
      const summary = deps.changes.decide(caseId, principal, body.decision);
      send(res, summary.ok ? 200 : 409, summary as unknown as Json);
      return;
    }

    const withdraw = /^\/api\/changes\/([^/]+)\/withdraw$/.exec(path);
    if (withdraw && method === 'POST') {
      const caseId = decodeSegment(withdraw[1] as string);
      if (caseId === null) return fail(res, 400, 'BAD_INPUT');
      const summary = deps.changes.withdraw(caseId, principal);
      send(res, summary.ok ? 200 : 409, summary as unknown as Json);
      return;
    }

    if (path === '/api/emergency/requests' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, 'BAD_INPUT');
      const result = deps.emergency.requestHelp({
        principal,
        termId: typeof body.termId === 'string' ? body.termId : '',
        occurrenceId: typeof body.occurrenceId === 'string' ? body.occurrenceId : '',
        note: typeof body.note === 'string' ? body.note : '',
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '',
      });
      send(res, emergencyStatus(result), result as unknown as Json);
      return;
    }

    const emergencyRequest = /^\/api\/emergency\/requests\/([^/]+)$/.exec(path);
    if (emergencyRequest && method === 'GET') {
      const requestId = decodeSegment(emergencyRequest[1] as string);
      if (requestId === null) return fail(res, 400, 'BAD_INPUT');
      const result = deps.emergency.getForRequester(principal, requestId);
      send(res, emergencyStatus(result), result as unknown as Json);
      return;
    }

    const emergencyActions: Readonly<Record<string, (id: string) => EmergencySummary>> = {
      notify: (id) => deps.emergency.markNotified(principal, id),
      'oral-accept': (id) => deps.emergency.recordOralAcceptance(principal, id),
      claim: (id) => deps.emergency.claim(principal, id),
      transfer: (id) => deps.emergency.transfer(principal, id),
      closure: (id) => deps.emergency.submitClosure(principal, id),
      'closure-confirm': (id) => deps.emergency.confirmClosure(principal, id),
      execution: (id) => deps.emergency.recordExecutionFact(principal, id),
      overdue: (id) => deps.emergency.overdue(principal, id),
    };

    /**
     * 后续动作（接单/口头登记/结案/执行事实/逾期/升级）在门禁未关闭前一律显式拒绝。
     * 之所以仍然提供路由：让"会被拒绝"可被前端与测试直接观察到，
     * 而不是因为 404 被误读成"接口还没写"。
     */
    const emergencyAction =
      /^\/api\/emergency\/requests\/([^/]+)\/(notify|oral-accept|claim|transfer|closure|closure-confirm|execution|overdue|escalate)$/.exec(
        path,
      );
    if (emergencyAction && method === 'POST') {
      const id = decodeSegment(emergencyAction[1] as string);
      if (id === null) return fail(res, 400, 'BAD_INPUT');
      const action = emergencyAction[2] as string;
      let result: EmergencySummary;
      if (action === 'escalate') {
        const body = await readJson(req);
        if (!body || typeof body.primaryDeclined !== 'boolean') return fail(res, 400, 'BAD_INPUT');
        result = deps.emergency.escalate(principal, id, body.primaryDeclined);
      } else {
        result = emergencyActions[action]?.(id) ?? ({ ok: false, code: 'BAD_INPUT' } as EmergencySummary);
      }
      send(res, emergencyStatus(result), result as unknown as Json);
      return;
    }

    fail(res, 404, 'NOT_FOUND');
  }
}

function emergencyStatus(result: EmergencySummary): number {
  switch (result.code) {
    case 'REQUESTED':
    case 'FOUND':
    case 'DUPLICATE_REPLAY':
    case 'NO_ESCALATION':
      return 200;
    case 'BAD_INPUT':
      return 400;
    case 'FORBIDDEN':
    case 'NOT_OWNER':
    case 'ROLE_NOT_ASSIGNED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_OCCURRENCE':
    case 'NO_COORDINATION_OWNER':
    case 'NOT_CONFIGURED':
      return 409;
    default:
      return 400;
  }
}

export function createApp(deps: AppDeps): Server {
  return createServer(createHandler(deps));
}

/** 偏好按嵌套结构返回：界面按 consider/exclude/hint 分组展示，避免自己再拼字段。 */
function toPreferenceJson(p: ReturnType<typeof recordToPreference>): Json {
  return {
    consider: { ...p.consider },
    exclude: { ...p.exclude },
    hint: { ...p.hint },
  };
}

function toRecordJson(r: PreferenceRecord): Json {
  return {
    scope: r.scope,
    teacherId: r.teacherId,
    considerSameClass: r.considerSameClass,
    considerSameGrade: r.considerSameGrade,
    considerSameSubject: r.considerSameSubject,
    considerLightLoad: r.considerLightLoad,
    excludeBusyAtSlot: r.excludeBusyAtSlot,
    excludeConsecutive: r.excludeConsecutive,
    consecutiveLimit: r.consecutiveLimit,
    excludeDayTotal: r.excludeDayTotal,
    dayTotalLimit: r.dayTotalLimit,
    hintClassSubjectDay: r.hintClassSubjectDay,
    classSubjectDayLimit: r.classSubjectDayLimit,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

function publicPrincipal(p: Principal): Json {
  return {
    userId: p.userId,
    teacherId: p.teacherId,
    displayName: p.displayName,
    roles: p.roles,
    actingRole: p.actingRole,
    mustChangePassword: p.mustChangePassword,
  };
}
