/**
 * 管理员重置他人登录口令：系统不采集手机号，忘记口令没有自助找回途径，
 * 只能由具 RESET_PASSWORD 权限的管理员重置为一次性口令，再当面交给本人。
 *
 * 必填环境变量（缺一项即退出，不猜默认值）：
 *   CA_DB_PATH            SQLite 文件路径
 *   CA_ADMIN_LOGIN        执行人账号（必须具 RESET_PASSWORD 权限）
 *   CA_ADMIN_PASSWORD     执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_TARGET_LOGIN       被重置的账号名
 *   CA_REASON             重置理由，写入审计（例如：本人到办公室申请并核验证件）
 * 选填：
 *   CA_OUT_FILE           把结果另写一份到该文件（权限 0600）
 *
 * 执行后：目标账号的旧会话全部失效，本人下次登录必须改密；管理员不知道其最终口令。
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import { AuthError, AuthService } from '../src/auth/service.js';
import { AuthStore } from '../src/auth/store.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const adminLogin = env('CA_ADMIN_LOGIN');
  const adminPassword = env('CA_ADMIN_PASSWORD');
  const targetLogin = env('CA_TARGET_LOGIN').toLowerCase();
  const reason = env('CA_REASON');

  const required: Array<[string, string]> = [
    ['CA_DB_PATH', dbPath],
    ['CA_ADMIN_LOGIN', adminLogin],
    ['CA_ADMIN_PASSWORD', adminPassword],
    ['CA_TARGET_LOGIN', targetLogin],
    ['CA_REASON', reason],
  ];
  const missing = required.filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    console.error(`缺少必填环境变量：${missing.join(' / ')}`);
    process.exit(2);
  }

  const db = new CourseDatabase(dbPath);
  try {
    const mode = db.deploymentMode();
    if (mode === null) {
      console.error('该库尚未设定环境，请先执行：npm run set-mode（重置口令必须落在明确的环境里）');
      process.exitCode = 1;
      return;
    }

    const auth = new AuthService(db);
    const login = auth.login(adminLogin, adminPassword, env('CA_ACTOR_ROLE') || undefined);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再执行重置');
      process.exitCode = 1;
      return;
    }

    const target = new AuthStore(db.handle).findUserByLogin(targetLogin);
    if (!target) {
      console.error(`账号不存在：${targetLogin}`);
      process.exitCode = 1;
      return;
    }
    if (target.status === 'DISABLED') {
      console.error(`账号 ${targetLogin} 已是停用状态；重置口令后仍不能登录，请先确认是否该恢复启用。`);
      process.exitCode = 1;
      return;
    }

    let initialPassword: string;
    try {
      initialPassword = auth.resetPassword(login.principal, target.id, reason).initialPassword;
    } catch (error) {
      if (error instanceof AuthError) {
        console.error(`重置失败 [${error.code}]：${error.message}`);
      } else {
        throw error;
      }
      process.exitCode = 1;
      return;
    }

    const lines: string[] = [];
    lines.push('=== 口令重置结果 ===');
    lines.push('');
    lines.push(`环境      ${MODE_LABEL[mode]}（${mode}）`);
    lines.push(`账号      ${target.loginName}`);
    lines.push(`姓名      ${target.displayName}`);
    lines.push(`新口令    ${initialPassword}`);
    lines.push(`理由      ${reason}`);
    lines.push('');
    lines.push('说明：');
    lines.push('  · 该账号原有会话已全部失效；本人用新口令登录后必须立即改成自己的口令。');
    lines.push('  · 新口令是系统生成的随机一次性口令，管理员看不到本人后续改的口令。');
    lines.push('  · 请当面交给本人并确认收讫，随后删除本地副本。');

    const out = lines.join('\n');
    console.log(out);

    const outFile = env('CA_OUT_FILE');
    if (outFile !== '') {
      writeFileSync(outFile, `${out}\n`, { mode: 0o600 });
      chmodSync(outFile, 0o600);
      console.log(`结果已写入：${outFile}（权限 0600）`);
    }
  } catch (error) {
    console.error(`重置口令失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
