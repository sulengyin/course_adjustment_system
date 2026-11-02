/**
 * 给已有账号追加一个角色（一人多职责时用，不是"造超级账号"）。
 *
 * 必填环境变量（缺一项即退出，不猜默认值）：
 *   CA_DB_PATH            SQLite 文件路径（必须已设定环境）
 *   CA_ACTOR_LOGIN        执行人账号（必须具 MANAGE_ACCOUNTS 权限，即管理员 A）
 *   CA_ACTOR_PASSWORD     执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_TARGET_LOGIN       被授权账号名
 *   CA_ROLE               要追加的角色：T / S / A（C/R/J 不可授予）
 * 选填：
 *   CA_REASON             授权理由，写入审计
 *
 * 注意：授权不等于合并。账号拿到 A+S 之后，登录时必须显式选择以哪个身份操作，
 * 审计里也按身份分别记录；A 身份依然不能导入，S 身份依然不能开户。
 */

import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import { AuthError, AuthService } from '../src/auth/service.js';
import { AuthStore } from '../src/auth/store.js';
import { ALL_ROLES, NON_GRANTABLE_ROLES, ROLE_LABEL, type Role } from '../src/auth/principal.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const targetLogin = env('CA_TARGET_LOGIN').toLowerCase();
  const roleRaw = env('CA_ROLE').toUpperCase();
  const reason = env('CA_REASON');

  const required: Array<[string, string]> = [
    ['CA_DB_PATH', dbPath],
    ['CA_ACTOR_LOGIN', actorLogin],
    ['CA_ACTOR_PASSWORD', actorPassword],
    ['CA_TARGET_LOGIN', targetLogin],
    ['CA_ROLE', roleRaw],
  ];
  const missing = required.filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    console.error(`缺少必填环境变量：${missing.join(' / ')}`);
    process.exit(2);
  }

  if (!(ALL_ROLES as readonly string[]).includes(roleRaw)) {
    console.error(`未知角色：${roleRaw}（只能是 ${ALL_ROLES.join(' / ')}）`);
    process.exit(2);
  }
  const role = roleRaw as Role;
  if (NON_GRANTABLE_ROLES.includes(role)) {
    console.error(`角色 ${role}（${ROLE_LABEL[role]}）尚未由校方指定承接人，不得授予`);
    process.exitCode = 1;
    return;
  }

  const db = new CourseDatabase(dbPath);
  try {
    const mode = db.deploymentMode();
    if (mode === null) {
      console.error('该库尚未设定环境，请先执行：npm run set-mode');
      process.exitCode = 1;
      return;
    }

    const auth = new AuthService(db);
    const login = auth.login(actorLogin, actorPassword, env('CA_ACTOR_ROLE') || undefined);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再授权');
      process.exitCode = 1;
      return;
    }

    const store = new AuthStore(db.handle);
    const target = store.findUserByLogin(targetLogin);
    if (!target) {
      console.error(`账号不存在：${targetLogin}`);
      process.exitCode = 1;
      return;
    }
    if (target.status === 'DISABLED') {
      console.error(`账号已停用：${targetLogin}。停用账号不再需要职责，先恢复启用再授权`);
      process.exitCode = 1;
      return;
    }

    const before = store.rolesOf(target.id);
    if (before.includes(role)) {
      console.error(`账号 ${targetLogin} 已具备角色 ${role}（${ROLE_LABEL[role]}），无需重复授予`);
      process.exitCode = 1;
      return;
    }

    auth.grantRole(login.principal, target.id, role);

    console.log('=== 角色已追加 ===');
    console.log(`环境      ${MODE_LABEL[mode] ?? mode}`);
    console.log(`账号      ${target.loginName}（${target.displayName}）`);
    console.log(`新增角色  ${role} ${ROLE_LABEL[role]}`);
    console.log(`角色变化  ${before.join('+') || '(无)'} → ${[...before, role].join('+')}`);
    console.log(`理由      ${reason === '' ? '（未填写）' : reason}`);
    console.log('');
    console.log('说明：');
    console.log('  · 授权 ≠ 合并权限。该账号下次登录需显式选择身份，审计按身份分别记录。');
    console.log('  · 已签发的会话不会自动带上新角色，需重新登录或切换身份后生效。');
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(`授权被拒绝 [${error.code}]：${error.message}`);
    } else {
      console.error(`授权失败：${(error as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
