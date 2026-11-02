/**
 * 批量开通账号：读花名册 CSV → 整批预检 → 逐个建号 → 打印初始口令清单。
 *
 * 必填环境变量（缺一项即退出，不猜默认值）：
 *   CA_DB_PATH            SQLite 文件路径
 *   CA_ADMIN_LOGIN        执行人账号（必须具 MANAGE_ACCOUNTS 权限）
 *   CA_ADMIN_PASSWORD     执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_USERS_CSV          花名册 CSV 路径（UTF-8）
 * 选填：
 *   CA_OUT_FILE           把清单另写一份到该文件（权限 0600）
 *
 * 预检不通过时一个账号都不建；已建的不会回滚（审计链不可回滚），
 * 若中途失败会明确告知"本行之前已建 N 个账号"。
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';
import { BulkUserService, type BulkUserRow } from '../src/service/bulk-user-service.js';
import { parseCsv } from '../src/import/csv.js';

const REQUIRED_HEADERS = ['账号', '姓名', '教师编号', '角色'] as const;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const adminLogin = env('CA_ADMIN_LOGIN');
  const adminPassword = env('CA_ADMIN_PASSWORD');
  const csvPath = env('CA_USERS_CSV');

  if (!dbPath || !adminLogin || !adminPassword || !csvPath) {
    console.error('缺少必填环境变量：CA_DB_PATH / CA_ADMIN_LOGIN / CA_ADMIN_PASSWORD / CA_USERS_CSV');
    process.exit(2);
  }

  let text: string;
  try {
    text = readFileSync(csvPath, 'utf8');
  } catch {
    console.error(`读不到花名册：${csvPath}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    console.error(`花名册解析失败 [${parsed.code}]：${parsed.message}`);
    process.exitCode = 1;
    return;
  }

  const headers = parsed.table.headers.map((h) => h.trim());
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    console.error(`花名册缺少必需的列：${missing.join('、')}（当前表头：${headers.join('、') || '空'}）`);
    process.exitCode = 1;
    return;
  }
  const col = (name: string): number => headers.indexOf(name);

  const rows: BulkUserRow[] = [];
  for (const row of parsed.table.rows) {
    const teacherId = (row[col('教师编号')] ?? '').trim();
    const rolesRaw = (row[col('角色')] ?? '').trim();
    rows.push({
      loginName: (row[col('账号')] ?? '').trim(),
      displayName: (row[col('姓名')] ?? '').trim(),
      teacherId: teacherId === '' ? null : teacherId,
      // 多个角色用 + 连接，例如 T+S（教师兼课务）。不猜测其它分隔符。
      roles: rolesRaw === '' ? [] : rolesRaw.split('+').map((r) => r.trim()).filter((r) => r !== ''),
    });
  }
  if (rows.length === 0) {
    console.error('花名册里没有数据行');
    process.exitCode = 1;
    return;
  }

  const db = new CourseDatabase(dbPath);
  try {
    const auth = new AuthService(db);
    const login = auth.login(adminLogin, adminPassword, env('CA_ACTOR_ROLE') || undefined);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再执行批量开通');
      process.exitCode = 1;
      return;
    }

    // 花名册是真实人员信息，不得在演示库里建这些账号
    db.requireMode('PRODUCTION');

    const result = new BulkUserService(db, auth).import(login.principal, rows);

    if (result.rejected.length > 0) {
      console.error(`整批拒绝：以下 ${result.rejected.length} 行有问题，一个账号都没有建。`);
      for (const r of result.rejected) {
        console.error(`  第 ${r.line} 行　${r.loginName || '(空)'}　[${r.code}] ${r.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const lines: string[] = [];
    lines.push(`=== 批量开通结果：已建 ${result.created.length} 个账号 ===`);
    lines.push('');
    lines.push('账号'.padEnd(14) + '姓名'.padEnd(12) + '初始口令');
    for (const c of result.created) {
      lines.push(String(c.loginName).padEnd(14) + String(c.displayName).padEnd(12) + c.initialPassword);
    }
    lines.push('');
    lines.push('说明：');
    lines.push('  · 初始口令由系统生成，各不相同；首次登录必须修改，未改密前不能使用任何功能。');
    lines.push('  · 系统不采集手机号，无法自助找回；忘记口令只能由管理员重置。');
    lines.push('  · 本清单含明文口令，请逐一分发给本人后立即删除本地副本。');

    const out = lines.join('\n');
    console.log(out);

    const outFile = env('CA_OUT_FILE');
    if (outFile !== '') {
      writeFileSync(outFile, `${out}\n`, { mode: 0o600 });
      chmodSync(outFile, 0o600);
      console.log(`清单已写入：${outFile}（权限 0600）`);
    }
  } catch (error) {
    console.error(`批量开通失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
