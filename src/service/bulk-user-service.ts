/**
 * 批量开通账号。
 *
 * 四条约束（按项目既有原则，不是新发明）：
 *  1. 整批预检、整批生效：任何一行有问题就一个都不建。审计链不可回滚，
 *     建到一半留下的半批账号比整批拒绝更难交代。
 *  2. 教师账号必须关联**已存在**的教师档案：createUser 只检查"编号非空"，
 *     不检查档案是否存在，批量场景必须补上这一步，否则会造出孤儿账号。
 *  3. 初始口令一律由系统生成（≥12 位、含两类字符），**不接受外部指定**；
 *     建号后 must_change_password=1，首次登录必须改掉。
 *     统一口令（如 t123456）不在此实现：长度不足会被口令强度拒绝，
 *     即使放行也会被首登强制改密冲掉，且任何人知道即可登录全部账号。
 *  4. 不可授予的角色（C/R/J）一律拒绝：授予等于替学校指定承接人。
 */

import type { CourseDatabase } from '../store/database.js';
import { AuthService, LOGIN_RE } from '../auth/service.js';
import { NON_GRANTABLE_ROLES, isRole, type Principal, type Role } from '../auth/principal.js';

export interface BulkUserRow {
  readonly loginName: string;
  readonly displayName: string;
  readonly teacherId: string | null;
  readonly roles: readonly string[];
}

export type BulkRejectCode =
  | 'BAD_INPUT'
  | 'UNKNOWN_ROLE'
  | 'ROLE_NOT_GRANTABLE'
  | 'LOGIN_NAME_TAKEN'
  | 'DUPLICATE_IN_FILE'
  | 'TEACHER_NOT_FOUND'
  | 'DUPLICATE_TEACHER_IN_FILE'
  | 'TEACHER_ALREADY_BOUND';

export interface BulkRejection {
  /** 花名册里的行号（1 起算，含表头），便于直接改文件。 */
  readonly line: number;
  readonly loginName: string;
  readonly code: BulkRejectCode;
  readonly message: string;
}

export interface CreatedAccount {
  readonly loginName: string;
  readonly displayName: string;
  readonly initialPassword: string;
}

export interface BulkUserResult {
  readonly created: readonly CreatedAccount[];
  readonly rejected: readonly BulkRejection[];
}

export class BulkUserService {
  private readonly db: CourseDatabase;
  private readonly auth: AuthService;

  constructor(db: CourseDatabase, auth: AuthService) {
    this.db = db;
    this.auth = auth;
  }

  import(principal: Principal, rows: readonly BulkUserRow[]): BulkUserResult {
    // 先过权限闸门：无权的人连预检细节都不该拿到。
    this.auth.requireAction(principal, 'MANAGE_ACCOUNTS');

    const rejected: BulkRejection[] = [];
    const seenInFile = new Set<string>();
    const teacherInFile = new Map<string, string>();
    const knownTeachers = new Set(this.db.refs().teachers.map((t) => t.id));
    const users = this.auth.listUsers();
    const takenLogins = new Set(users.map((u) => u.loginName));
    // 一份教师档案只能挂在仍在用的账号上：两个账号共用同一编号，
    // 会让"这节课到底是谁的"在调课与确认时说不清。
    const boundTeachers = new Map<string, string>();
    for (const u of users) {
      if (u.teacherId && u.status === 'ACTIVE') boundTeachers.set(u.teacherId, u.loginName);
    }

    rows.forEach((raw, index) => {
      const line = index + 2; // 第 1 行是表头
      const loginName = raw.loginName.trim().toLowerCase();
      const displayName = raw.displayName.trim();
      const teacherId = (raw.teacherId ?? '').trim();

      if (loginName === '') {
        rejected.push({ line, loginName: '', code: 'BAD_INPUT', message: '账号为空' });
        return;
      }
      if (!LOGIN_RE.test(loginName)) {
        rejected.push({
          line,
          loginName,
          code: 'BAD_INPUT',
          message: '账号需为 3–32 位小写字母、数字、点、下划线或连字符，且以字母或数字开头',
        });
        return;
      }
      if (displayName === '') {
        rejected.push({ line, loginName, code: 'BAD_INPUT', message: '姓名为空' });
        return;
      }
      if (seenInFile.has(loginName)) {
        rejected.push({ line, loginName, code: 'DUPLICATE_IN_FILE', message: '同一份花名册里账号重复' });
        return;
      }
      seenInFile.add(loginName);
      if (takenLogins.has(loginName)) {
        rejected.push({ line, loginName, code: 'LOGIN_NAME_TAKEN', message: '该账号在系统中已存在' });
        return;
      }

      const roles = raw.roles.map((r) => r.trim()).filter((r) => r !== '');
      if (roles.length === 0) {
        rejected.push({ line, loginName, code: 'BAD_INPUT', message: '未填写角色' });
        return;
      }
      const badRole = roles.find((r) => !isRole(r));
      if (badRole !== undefined) {
        rejected.push({ line, loginName, code: 'UNKNOWN_ROLE', message: `未知角色：${badRole}` });
        return;
      }
      const ungrantable = roles.find((r) => NON_GRANTABLE_ROLES.includes(r as Role));
      if (ungrantable !== undefined) {
        rejected.push({
          line,
          loginName,
          code: 'ROLE_NOT_GRANTABLE',
          message: `该职责尚未由校方指定承接人：${ungrantable}`,
        });
        return;
      }

      const isTeacher = roles.includes('T');
      if (teacherId !== '' && teacherInFile.has(teacherId)) {
        rejected.push({
          line,
          loginName,
          code: 'DUPLICATE_TEACHER_IN_FILE',
          message: `教师编号 ${teacherId} 在本花名册里已给账号 ${teacherInFile.get(teacherId)}`,
        });
        return;
      }
      if (teacherId !== '' && boundTeachers.has(teacherId)) {
        rejected.push({
          line,
          loginName,
          code: 'TEACHER_ALREADY_BOUND',
          message: `教师编号 ${teacherId} 已绑定账号 ${boundTeachers.get(teacherId)}`,
        });
        return;
      }
      if (teacherId !== '') teacherInFile.set(teacherId, loginName);
      if (teacherId !== '' && !knownTeachers.has(teacherId)) {
        rejected.push({
          line,
          loginName,
          code: 'TEACHER_NOT_FOUND',
          message: `教师档案里没有编号 ${teacherId}，请先导入教师名单`,
        });
        return;
      }
      if (isTeacher && teacherId === '') {
        rejected.push({ line, loginName, code: 'BAD_INPUT', message: '教师账号必须填教师编号' });
        return;
      }
      if (!isTeacher && teacherId !== '') {
        rejected.push({
          line,
          loginName,
          code: 'BAD_INPUT',
          message: '非教师账号不需要教师编号，请留空（教师兼其他身份时角色应写作 T+S）',
        });
        return;
      }
    });

    if (rejected.length > 0) {
      return { created: [], rejected };
    }

    const created: CreatedAccount[] = [];
    for (const [index, raw] of rows.entries()) {
      const loginName = raw.loginName.trim().toLowerCase();
      const teacherId = (raw.teacherId ?? '').trim();
      try {
        const result = this.auth.createUser(principal, {
          loginName,
          displayName: raw.displayName.trim(),
          teacherId: teacherId === '' ? null : teacherId,
          roles: raw.roles,
        });
        created.push({
          loginName,
          displayName: raw.displayName.trim(),
          initialPassword: result.initialPassword,
        });
      } catch (error) {
        // 预检已过却仍失败：审计链不可回滚，必须如实告知已建了多少个。
        return {
          created,
          rejected: [
            {
              line: index + 2,
              loginName,
              code: 'BAD_INPUT',
              message: `建号失败：${(error as Error).message}（本行之前已建 ${created.length} 个账号，请人工核对）`,
            },
          ],
        };
      }
    }

    return { created, rejected: [] };
  }
}
