/**
 * 给某个账号单独授予一条能力（不改变角色）。
 *
 * 目前只有一条用途：让指定的人可以"代其他老师发起调课"。
 * 这不是"造超级账号"——角色表不变，登录后仍以原身份操作，
 * 只是 can() 在角色为 DENY 时多看一眼这份个人授权。
 *
 * 必填环境变量（缺一项即退出，不猜默认值）：
 *   CA_DB_PATH            SQLite 文件路径
 *   CA_ACTOR_LOGIN        执行人账号（必须具 MANAGE_ACCOUNTS，即管理员 A）
 *   CA_ACTOR_PASSWORD     执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_TARGET_LOGIN       被授权账号
 *   CA_BASIS              依据（文件编号 / 会议纪要 / 批准人 + 日期）——必须写
 * 选填：
 *   CA_ACTION             能力名，默认 CREATE_CHANGE_ON_BEHALF
 *   CA_ACTOR_ROLE         执行人身份（一人多角色时必须显式指定）
 *   CA_REVOKE=1           撤销该能力，而不是授予
 *
 * 例：
 *   CA_DB_PATH=/data/.../school.sqlite \
 *   CA_ACTOR_LOGIN=admin CA_ACTOR_PASSWORD='***' CA_ACTOR_ROLE=A \
 *   CA_TARGET_LOGIN=t038 CA_BASIS='校务会2026-11-03纪要第2条' \
 *   npx tsx scripts/grant-capability.ts
 */

import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import { AuthError, AuthService } from '../src/auth/service.js';
import { AuthStore } from '../src/auth/store.js';
import { ACTION_LABEL, ALL_ACTIONS, type Action } from '../src/auth/policy.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const targetLogin = env('CA_TARGET_LOGIN').toLowerCase();
  const basis = env('CA_BASIS');
  const actionRaw = env('CA_ACTION') || 'CREATE_CHANGE_ON_BEHALF';
  const revoke = env('CA_REVOKE') === '1';

  const required: Array<[string, string]> = [
    ['CA_DB_PATH', dbPath],
    ['CA_ACTOR_LOGIN', actorLogin],
    ['CA_ACTOR_PASSWORD', actorPassword],
    ['CA_TARGET_LOGIN', targetLogin],
  ];
  // 撤销不需要重新登记依据；授予必须写清"谁批准的"
  if (!revoke) required.push(['CA_BASIS', basis]);

  const missing = required.filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    console.error(`缺少必填环境变量：${missing.join(' / ')}`);
    process.exit(2);
  }

  if (!(ALL_ACTIONS as readonly string[]).includes(actionRaw)) {
    console.error(`未知能力：${actionRaw}`);
    console.error(`可用：${ALL_ACTIONS.join(' / ')}`);
    process.exit(2);
  }
  const action = actionRaw as Action;

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

    if (revoke) {
      auth.revokeCapability(login.principal, target.id, action);
    } else {
      auth.grantCapability(login.principal, target.id, action, basis);
    }

    const after = store.capabilitiesOf(target.id);
    console.log(revoke ? '=== 能力已撤销 ===' : '=== 能力已授予 ===');
    console.log(`环境      ${MODE_LABEL[mode] ?? mode}`);
    console.log(`账号      ${target.loginName}（${target.displayName}）`);
    console.log(`能力      ${action} ${ACTION_LABEL[action] ?? ''}`);
    console.log(`角色      ${store.rolesOf(target.id).join('+') || '(无)'}（未改变）`);
    console.log(`依据      ${revoke ? '（撤销无需依据）' : basis}`);
    console.log(`现有能力  ${after.length === 0 ? '(无)' : after.join(', ')}`);
    console.log('');
    console.log('说明：');
    console.log('  · 这是账号级授权，不是新角色；角色表与权限矩阵的角色列都没有变。');
    console.log('  · 已签发的会话不会自动生效，需重新登录；撤销会立即作废该账号全部会话。');
    console.log('  · 被代教师仍需本人确认，系统不会代他点同意。');
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
