/**
 * 账号/角色/会话的存储层。只做读写，不做判定。
 * 所有行逐字段映射（P3 曾因 `as` 断言把 snake_case 当驼峰导致假通过）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Role } from './principal.js';

export interface UserRecord {
  readonly id: string;
  readonly loginName: string;
  readonly displayName: string;
  readonly teacherId: string | null;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly mustChangePassword: boolean;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly passwordChangedAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledBy: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly actingRole: Role;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

interface UserRow {
  id: string;
  login_name: string;
  display_name: string;
  teacher_id: string | null;
  status: string;
  must_change_password: number;
  password_hash: string;
  created_at: string;
  created_by: string;
  password_changed_at: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  acting_role: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function mapUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    loginName: r.login_name,
    displayName: r.display_name,
    teacherId: r.teacher_id,
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    mustChangePassword: r.must_change_password === 1,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    createdBy: r.created_by,
    passwordChangedAt: r.password_changed_at,
    disabledAt: r.disabled_at,
    disabledBy: r.disabled_by,
  };
}

function mapSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    actingRole: r.acting_role as Role,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  };
}

const USER_COLUMNS = `id, login_name, display_name, teacher_id, status, must_change_password, password_hash,
                      created_at, created_by, password_changed_at, disabled_at, disabled_by`;
const SESSION_COLUMNS = `id, user_id, token_hash, acting_role, created_at, last_seen_at, expires_at, revoked_at, revoked_reason`;

export class AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number };
    return row.n;
  }

  insertUser(u: UserRecord): void {
    this.db
      .prepare(`INSERT INTO app_user(${USER_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        u.id,
        u.loginName,
        u.displayName,
        u.teacherId,
        u.status,
        u.mustChangePassword ? 1 : 0,
        u.passwordHash,
        u.createdAt,
        u.createdBy,
        u.passwordChangedAt,
        u.disabledAt,
        u.disabledBy,
      );
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM app_user WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  findUserByLogin(loginName: string): UserRecord | null {
    const row = this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM app_user WHERE login_name = ?`)
      .get(loginName) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  listUsers(): UserRecord[] {
    const rows = this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM app_user ORDER BY created_at, id`)
      .all() as unknown as UserRow[];
    return rows.map(mapUser);
  }

  rolesOf(userId: string): Role[] {
    const rows = this.db
      .prepare('SELECT role FROM user_role WHERE user_id = ? AND revoked_at IS NULL ORDER BY role')
      .all(userId) as unknown as Array<{ role: Role }>;
    return rows.map((r) => r.role);
  }

  grantRole(userId: string, role: Role, at: string, by: string): void {
    this.db
      .prepare(
        `INSERT INTO user_role(user_id, role, granted_at, granted_by) VALUES(?,?,?,?)
         ON CONFLICT(user_id, role) DO UPDATE SET granted_at = excluded.granted_at,
           granted_by = excluded.granted_by, revoked_at = NULL`,
      )
      .run(userId, role, at, by);
  }

  /** 账号级能力（不含已撤销）。只用于 can() 补 DENY，不参与角色判定。 */
  capabilitiesOf(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT action FROM capability_grant WHERE user_id = ? AND revoked_at IS NULL ORDER BY action')
      .all(userId) as unknown as Array<{ action: string }>;
    return rows.map((r) => r.action);
  }

  grantCapability(input: {
    readonly userId: string;
    readonly action: string;
    readonly basis: string;
    readonly by: string;
    readonly at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO capability_grant(user_id, action, basis, granted_by, granted_at) VALUES(?,?,?,?,?)
         ON CONFLICT(user_id, action) DO UPDATE SET basis = excluded.basis,
           granted_by = excluded.granted_by, granted_at = excluded.granted_at,
           revoked_at = NULL, revoked_by = NULL`,
      )
      .run(input.userId, input.action, input.basis, input.by, input.at);
  }

  revokeCapability(userId: string, action: string, at: string, by: string): void {
    this.db
      .prepare('UPDATE capability_grant SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND action = ?')
      .run(at, by, userId, action);
  }

  updatePassword(userId: string, passwordHash: string, at: string, mustChange: boolean): void {
    this.db
      .prepare('UPDATE app_user SET password_hash = ?, password_changed_at = ?, must_change_password = ? WHERE id = ?')
      .run(passwordHash, at, mustChange ? 1 : 0, userId);
  }

  disableUser(userId: string, at: string, by: string): void {
    this.db
      .prepare("UPDATE app_user SET status = 'DISABLED', disabled_at = ?, disabled_by = ? WHERE id = ?")
      .run(at, by, userId);
  }

  insertSession(s: SessionRecord): void {
    this.db
      .prepare(`INSERT INTO session(${SESSION_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(
        s.id,
        s.userId,
        s.tokenHash,
        s.actingRole,
        s.createdAt,
        s.lastSeenAt,
        s.expiresAt,
        s.revokedAt,
        s.revokedReason,
      );
  }

  findSessionByTokenHash(tokenHash: string): SessionRecord | null {
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE token_hash = ?`)
      .get(tokenHash) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): void {
    this.db
      .prepare('UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(lastSeenAt, expiresAt, sessionId);
  }

  revokeSession(sessionId: string, at: string, reason: string): void {
    this.db
      .prepare('UPDATE session SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, reason, sessionId);
  }

  revokeAllSessions(userId: string, at: string, reason: string): number {
    const result = this.db
      .prepare('UPDATE session SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(at, reason, userId);
    return Number(result.changes);
  }

  countActiveSessions(userId: string, at: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(userId, at) as { n: number };
    return row.n;
  }
}
