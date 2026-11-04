/**
 * 登录、会话、开户、改密。
 *
 * 明确不做的事：
 *  - 不采集手机号、不发短信、不接钉钉/微信等外部身份源（第一版纯内网）。
 *  - 不提供"管理员代确认"这类入口（INV-08）。
 *  - 不允许把未定职责的角色授予任何人（R/J 不可授予，C 由接单产生）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CourseDatabase } from '../store/database.js';
import { AuthStore, type UserRecord } from './store.js';
import {
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  generateInitialPassword,
  hashPassword,
  verifyPassword,
} from './password.js';
import { ALL_ACTIONS, type Action, can } from './policy.js';
import { type Principal, type Role, NON_GRANTABLE_ROLES, isRole, mintPrincipal } from './principal.js';

/** 会话空闲超时：技术基线，可由部署方调整；不是学校制度。 */
export const DEFAULT_IDLE_MINUTES = 30;

export interface AuthServiceOptions {
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly idleMinutes?: number;
}

export type AuthFailureCode =
  | 'BAD_INPUT'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'NO_ROLE'
  | 'AMBIGUOUS_ROLE'
  | 'ROLE_NOT_GRANTED'
  | 'LOGIN_NAME_TAKEN'
  | 'USER_NOT_FOUND'
  | 'ROLE_NOT_GRANTABLE'
  | 'CANNOT_DISABLE_SELF'
  | 'CANNOT_RESET_SELF'
  | 'WEAK_PASSWORD'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'POLICY_DENIED';

export class AuthError extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export class PolicyDeniedError extends Error {
  constructor(
    readonly code: 'ROLE_NOT_ASSIGNED' | 'FORBIDDEN',
    readonly action: Action,
  ) {
    super(code === 'ROLE_NOT_ASSIGNED' ? `该职责待校方确认：${action}` : `无权执行：${action}`);
  }
}

export interface LoginSuccess {
  readonly ok: true;
  readonly token: string;
  readonly expiresAt: string;
  readonly principal: Principal;
}

export interface LoginFailure {
  readonly ok: false;
  readonly code: Exclude<AuthFailureCode, 'POLICY_DENIED'>;
  readonly roles?: readonly Role[];
}

export type LoginResult = LoginSuccess | LoginFailure;

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export class AuthService {
  private readonly store: AuthStore;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly idleMinutes: number;
  /** 不存在的账号也跑一次 scrypt，避免用响应时间枚举账号 */
  private readonly dummyHash: string;

  constructor(
    private readonly db: CourseDatabase,
    options: AuthServiceOptions = {},
  ) {
    this.store = new AuthStore(db.handle);
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.idleMinutes = options.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.dummyHash = hashPassword('dummy-password-for-timing-only');
  }

  /** 首次部署：库中没有任何账号时才可建第一个管理员。 */
  bootstrapAdmin(input: {
    readonly loginName: string;
    readonly displayName: string;
    readonly password?: string;
  }): { readonly userId: string; readonly initialPassword: string } {
    if (this.store.countUsers() > 0) {
      throw new AuthError('POLICY_DENIED', '已存在账号，不能重复初始化管理员');
    }
    const at = this.now();
    const password = input.password ?? generateInitialPassword();
    const problem = checkPasswordStrength({ next: password, previous: null });
    if (problem) throw new AuthError('WEAK_PASSWORD', `口令不符合最低要求：${problem}`);
    const userId = this.newId();
    const user: UserRecord = {
      id: userId,
      loginName: input.loginName,
      displayName: input.displayName,
      teacherId: null,
      status: 'ACTIVE',
      mustChangePassword: true,
      passwordHash: hashPassword(password),
      createdAt: at,
      createdBy: 'SYSTEM',
      passwordChangedAt: null,
      disabledAt: null,
      disabledBy: null,
    };
    this.db.transaction(() => {
      this.store.insertUser(user);
      this.store.grantRole(userId, 'A', at, 'SYSTEM');
      this.db.auditLog.append({
        at,
        actor: 'SYSTEM',
        action: 'BOOTSTRAP_ADMIN',
        objectType: 'USER',
        objectId: userId,
        afterState: 'ACTIVE',
        reason: 'INITIAL_DEPLOYMENT',
      });
    });
    return { userId, initialPassword: password };
  }

  createUser(
    principal: Principal,
    input: {
      readonly loginName: string;
      readonly displayName: string;
      readonly teacherId?: string | null;
      readonly roles: readonly string[];
    },
  ): { readonly userId: string; readonly initialPassword: string } {
    this.requireAction(principal, 'MANAGE_ACCOUNTS');
    const loginName = input.loginName.trim().toLowerCase();
    if (!LOGIN_RE.test(loginName)) {
      throw new AuthError('BAD_INPUT', '账号需为 3–32 位小写字母、数字、点、下划线或连字符');
    }
    const roles: Role[] = [];
    for (const raw of input.roles) {
      if (!isRole(raw)) throw new AuthError('BAD_INPUT', `未知角色：${raw}`);
      if (NON_GRANTABLE_ROLES.includes(raw)) {
        // 授予 R/J 等于替学校指定记录者或裁决者；C 由接单产生。
        throw new AuthError('ROLE_NOT_GRANTABLE', `该职责尚未由校方指定承接人：${raw}`);
      }
      if (!roles.includes(raw)) roles.push(raw);
    }
    if (roles.length === 0) throw new AuthError('BAD_INPUT', '至少需要一个角色');
    if (roles.includes('T') && !input.teacherId) {
      throw new AuthError('BAD_INPUT', '教师账号必须关联教师档案');
    }
    if (this.store.findUserByLogin(loginName)) {
      throw new AuthError('LOGIN_NAME_TAKEN', '账号已存在');
    }

    const at = this.now();
    const userId = this.newId();
    const initialPassword = generateInitialPassword();
    this.db.transaction(() => {
      this.store.insertUser({
        id: userId,
        loginName,
        displayName: input.displayName,
        teacherId: input.teacherId ?? null,
        status: 'ACTIVE',
        mustChangePassword: true,
        passwordHash: hashPassword(initialPassword),
        createdAt: at,
        createdBy: principal.userId,
        passwordChangedAt: null,
        disabledAt: null,
        disabledBy: null,
      });
      for (const role of roles) this.store.grantRole(userId, role, at, principal.userId);
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'CREATE_USER',
        objectType: 'USER',
        objectId: userId,
        afterState: 'ACTIVE',
        reason: `roles=${roles.join(',')}`,
      });
    });
    return { userId, initialPassword };
  }

  grantRole(principal: Principal, userId: string, role: string): void {
    this.requireAction(principal, 'MANAGE_ACCOUNTS');
    if (!isRole(role)) throw new AuthError('BAD_INPUT', `未知角色：${role}`);
    if (NON_GRANTABLE_ROLES.includes(role)) {
      throw new AuthError('ROLE_NOT_GRANTABLE', `该职责尚未由校方指定承接人：${role}`);
    }
    const user = this.store.findUserById(userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    if (role === 'T' && !user.teacherId) {
      throw new AuthError('BAD_INPUT', '教师账号必须关联教师档案');
    }
    const at = this.now();
    this.db.transaction(() => {
      this.store.grantRole(userId, role, at, principal.userId);
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'GRANT_ROLE',
        objectType: 'USER',
        objectId: userId,
        afterState: role,
      });
    });
  }

  /**
   * 账号级能力授权：单点、可撤销、必须填依据。
   *
   * 这不是"加一个角色"：不改 actingRole，也不影响其它能力。
   * 不能覆盖 TBD_BLOCKED——那表示"校方尚未指定责任人"，不是权限不够。
   */
  grantCapability(principal: Principal, userId: string, action: string, basis: string): void {
    this.requireAction(principal, 'MANAGE_ACCOUNTS');
    if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
      throw new AuthError('BAD_INPUT', `未知能力：${action}`);
    }
    if (basis.trim() === '') throw new AuthError('BAD_INPUT', '授予能力必须登记依据（文件编号或批准人）');
    if (userId === principal.userId) {
      throw new AuthError('BAD_INPUT', '不得给自己授予能力：管理员不因技术权限获得业务权');
    }
    const user = this.store.findUserById(userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    if (user.status === 'DISABLED') throw new AuthError('BAD_INPUT', '账号已停用，先恢复启用再授权');

    const at = this.now();
    this.db.transaction(() => {
      this.store.grantCapability({ userId, action, basis: basis.trim(), by: principal.userId, at });
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'GRANT_CAPABILITY',
        objectType: 'USER',
        objectId: userId,
        afterState: action,
        reason: basis.trim(),
      });
    });
  }

  /** 撤销账号级能力：立即作废该账号全部会话，避免旧会话里还带着已撤的授权。 */
  revokeCapability(principal: Principal, userId: string, action: string): void {
    this.requireAction(principal, 'MANAGE_ACCOUNTS');
    const at = this.now();
    this.db.transaction(() => {
      this.store.revokeCapability(userId, action, at, principal.userId);
      this.store.revokeAllSessions(userId, at, 'CAPABILITY_REVOKED');
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'REVOKE_CAPABILITY',
        objectType: 'USER',
        objectId: userId,
        beforeState: action,
      });
    });
  }

  disableUser(principal: Principal, userId: string, reason: string): void {    this.requireAction(principal, 'MANAGE_ACCOUNTS');
    if (principal.userId === userId) throw new AuthError('CANNOT_DISABLE_SELF', '不能停用当前登录账号');
    const user = this.store.findUserById(userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    const at = this.now();
    this.db.transaction(() => {
      this.store.disableUser(userId, at, principal.userId);
      this.store.revokeAllSessions(userId, at, 'ACCOUNT_DISABLED');
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'DISABLE_USER',
        objectType: 'USER',
        objectId: userId,
        beforeState: user.status,
        afterState: 'DISABLED',
        reason,
      });
    });
  }

  /**
   * 他人忘记口令时，由管理员重置为一次性口令；旧会话立即失效，本人首登必须改密。
   *
   * reason 必填：重置等于让一个账号的使用权重新流转一次，审计里必须留下"为什么"。
   * 不接受重置自己的口令——那会让本次操作的会话当场失效，且绕开改密需要旧口令的校验。
   */
  resetPassword(
    principal: Principal,
    userId: string,
    reason: string,
  ): { readonly initialPassword: string } {
    this.requireAction(principal, 'RESET_PASSWORD');
    if (principal.userId === userId) {
      throw new AuthError('CANNOT_RESET_SELF', '不能重置当前登录账号的口令；要改自己的口令请用改密功能');
    }
    const user = this.store.findUserById(userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    const at = this.now();
    const initialPassword = generateInitialPassword();
    this.db.transaction(() => {
      this.store.updatePassword(userId, hashPassword(initialPassword), at, true);
      this.store.revokeAllSessions(userId, at, 'PASSWORD_RESET');
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'RESET_PASSWORD',
        objectType: 'USER',
        objectId: userId,
        afterState: 'MUST_CHANGE',
        reason,
      });
    });
    return { initialPassword };
  }

  login(loginNameRaw: string, password: string, actingRole?: string): LoginResult {
    const loginName = loginNameRaw.trim().toLowerCase();
    if (!loginName || !password) return { ok: false, code: 'BAD_INPUT' };
    const at = this.now();
    const user = this.store.findUserByLogin(loginName);

    if (!user) {
      verifyPassword(password, this.dummyHash);
      this.recordLoginFailure(at, loginName, null, 'INVALID_CREDENTIALS');
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    if (!verifyPassword(password, user.passwordHash)) {
      this.recordLoginFailure(at, loginName, user.id, 'INVALID_CREDENTIALS');
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    if (user.status === 'DISABLED') {
      this.recordLoginFailure(at, loginName, user.id, 'ACCOUNT_DISABLED');
      return { ok: false, code: 'ACCOUNT_DISABLED' };
    }

    const roles = this.store.rolesOf(user.id);
    if (roles.length === 0) {
      this.recordLoginFailure(at, loginName, user.id, 'NO_ROLE');
      return { ok: false, code: 'NO_ROLE' };
    }

    let effective: Role;
    if (user.mustChangePassword) {
      // 首登只能改密；此阶段选哪个角色都不产生业务效果，改密后会话全部作废并要求重新登录。
      effective = roles[0] as Role;
    } else if (actingRole !== undefined) {
      if (!isRole(actingRole) || !roles.includes(actingRole)) {
        return { ok: false, code: 'ROLE_NOT_GRANTED' };
      }
      effective = actingRole;
    } else if (roles.length > 1) {
      return { ok: false, code: 'AMBIGUOUS_ROLE', roles };
    } else {
      effective = roles[0] as Role;
    }

    const session = this.issue(user, roles, effective, at);
    this.db.auditLog.append({
      at,
      actor: user.id,
      action: 'LOGIN_SUCCEEDED',
      objectType: 'SESSION',
      objectId: session.sessionId,
      afterState: effective,
    });
    return { ok: true, token: session.token, expiresAt: session.expiresAt, principal: session.principal };
  }

  /**
   * 用会话 token 换 Principal。任何一项不满足都返回 null（不区分原因，避免成为探测口）。
   * 每次成功调用刷新空闲计时。
   */
  authenticate(token: string | null | undefined): Principal | null {
    if (!token) return null;
    const at = this.now();
    const session = this.store.findSessionByTokenHash(sha256(token));
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= at) return null;

    const user = this.store.findUserById(session.userId);
    if (!user) return null;
    if (user.status === 'DISABLED') {
      this.store.revokeSession(session.id, at, 'ACCOUNT_DISABLED');
      return null;
    }
    const roles = this.store.rolesOf(user.id);
    if (!roles.includes(session.actingRole)) {
      this.store.revokeSession(session.id, at, 'ROLE_REVOKED');
      return null;
    }
    this.store.touchSession(session.id, at, addMinutes(at, this.idleMinutes));
    return mintPrincipal({
      userId: user.id,
      teacherId: user.teacherId,
      displayName: user.displayName,
      roles,
      actingRole: session.actingRole,
      grants: this.store.capabilitiesOf(user.id),
      sessionId: session.id,
      mustChangePassword: user.mustChangePassword,
    });
  }

  logout(principal: Principal): void {
    const at = this.now();
    this.store.revokeSession(principal.sessionId, at, 'LOGOUT');
    this.db.auditLog.append({
      at,
      actor: principal.userId,
      action: 'LOGOUT',
      objectType: 'SESSION',
      objectId: principal.sessionId,
    });
  }

  /** 显式切换身份：旧会话作废，签发新会话，两件事都留痕。 */
  switchRole(principal: Principal, role: string): { readonly token: string; readonly principal: Principal } {
    if (!isRole(role) || !principal.roles.includes(role)) {
      throw new AuthError('ROLE_NOT_GRANTED', '未授予该角色');
    }
    const user = this.store.findUserById(principal.userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    const at = this.now();
    const issued = this.db.transaction(() => {
      this.store.revokeSession(principal.sessionId, at, 'ROLE_SWITCH');
      const next = this.issue(user, principal.roles, role, at);
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'SWITCH_ROLE',
        objectType: 'USER',
        objectId: principal.userId,
        beforeState: principal.actingRole,
        afterState: role,
      });
      return next;
    });
    return { token: issued.token, principal: issued.principal };
  }

  changePassword(principal: Principal, oldPassword: string, newPassword: string): void {
    const user = this.store.findUserById(principal.userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', '账号不存在');
    const at = this.now();
    if (!verifyPassword(oldPassword, user.passwordHash)) {
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'PASSWORD_CHANGE_FAILED',
        objectType: 'USER',
        objectId: principal.userId,
        reason: 'INVALID_CREDENTIALS',
      });
      throw new AuthError('INVALID_CREDENTIALS', '当前口令不正确');
    }
    const problem = checkPasswordStrength({ next: newPassword, previous: oldPassword });
    if (problem) {
      throw new AuthError('WEAK_PASSWORD', `口令不符合最低要求：${problem}`, {
        minLength: MIN_PASSWORD_LENGTH,
      });
    }
    this.db.transaction(() => {
      this.store.updatePassword(principal.userId, hashPassword(newPassword), at, false);
      // 改密后所有会话作废，必须重新登录并按需重选身份。
      this.store.revokeAllSessions(principal.userId, at, 'PASSWORD_CHANGED');
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'PASSWORD_CHANGED',
        objectType: 'USER',
        objectId: principal.userId,
      });
    });
  }

  /** 业务入口的统一闸门：先看身份是否已过首登，再看权限表。 */
  requireAction(principal: Principal, action: Action): void {
    if (principal.mustChangePassword) {
      throw new AuthError('PASSWORD_CHANGE_REQUIRED', '首次登录必须先修改口令');
    }
    const decision = can(principal, action);
    if (!decision.allowed) {
      this.db.auditLog.append({
        at: this.now(),
        actor: principal.userId,
        action: 'AUTHORIZATION_DENIED',
        objectType: 'ACTION',
        objectId: action,
        afterState: decision.code,
      });
      throw new PolicyDeniedError(decision.code === 'ROLE_NOT_ASSIGNED' ? 'ROLE_NOT_ASSIGNED' : 'FORBIDDEN', action);
    }
  }

  listUsers(): Array<{
    readonly id: string;
    readonly loginName: string;
    readonly displayName: string;
    readonly teacherId: string | null;
    readonly role: string;
    readonly status: string;
    readonly mustChangePassword: boolean;
  }> {
    return this.store.listUsers().map((u) => ({
      id: u.id,
      loginName: u.loginName,
      displayName: u.displayName,
      teacherId: u.teacherId,
      role: this.store.rolesOf(u.id).join(','),
      status: u.status,
      mustChangePassword: u.mustChangePassword,
    }));
  }

  private issue(
    user: UserRecord,
    roles: readonly Role[],
    actingRole: Role,
    at: string,
  ): { token: string; expiresAt: string; sessionId: string; principal: Principal } {
    const token = randomBytes(32).toString('base64url');
    const sessionId = this.newId();
    const expiresAt = addMinutes(at, this.idleMinutes);
    this.store.insertSession({
      id: sessionId,
      userId: user.id,
      tokenHash: sha256(token),
      actingRole,
      createdAt: at,
      lastSeenAt: at,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
    });
    return {
      token,
      expiresAt,
      sessionId,
      principal: mintPrincipal({
        userId: user.id,
        teacherId: user.teacherId,
        displayName: user.displayName,
        roles,
        actingRole,
        grants: this.store.capabilitiesOf(user.id),
        sessionId,
        mustChangePassword: user.mustChangePassword,
      }),
    };
  }

  private recordLoginFailure(at: string, loginName: string, userId: string | null, code: string): void {
    this.db.auditLog.append({
      at,
      actor: userId ?? 'ANONYMOUS',
      action: 'LOGIN_FAILED',
      objectType: 'USER',
      // 账号可能不存在；记录尝试值用于发现撞库，不记录口令。
      objectId: userId ?? loginName,
      reason: code,
    });
  }
}
