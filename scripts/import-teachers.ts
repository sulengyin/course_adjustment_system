/**
 * 导入教师名单：读 CSV → 整批预检 → 建立教师档案 → 打印编号/姓名对照表。
 *
 * 必填环境变量（缺一项即退出，不猜默认值）：
 *   CA_DB_PATH          SQLite 文件路径
 *   CA_ACTOR_LOGIN      执行人账号（必须具 IMPORT_ROSTER 权限，即课务管理人员）
 *   CA_ACTOR_PASSWORD   执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_ROSTER_CSV       名单文件路径（UTF-8）
 * 选填：
 *   CA_OUT_FILE         把对照表另写一份到该文件（权限 0600）
 *
 * 两种名单格式都收：
 *   1. 带表头：第一行为表头，需含「姓名」，可选「教师编号」
 *   2. 无表头：每行一个姓名（编号由系统生成）
 *
 * 预检不通过时一条都不写。编号一旦写入就会被课表与账号引用，
 * 系统生成的编号只是占位，校方给出正式工号后须走显式迁移。
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';
import { TeacherRosterService, type RosterRow } from '../src/service/teacher-roster-service.js';
import { parseCsv } from '../src/import/csv.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const csvPath = env('CA_ROSTER_CSV');

  if (!dbPath || !actorLogin || !actorPassword || !csvPath) {
    console.error('缺少必填环境变量：CA_DB_PATH / CA_ACTOR_LOGIN / CA_ACTOR_PASSWORD / CA_ROSTER_CSV');
    process.exit(2);
  }

  let text: string;
  try {
    text = readFileSync(csvPath, 'utf8');
  } catch {
    console.error(`读不到名单文件：${csvPath}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    console.error(`名单解析失败 [${parsed.code}]：${parsed.message}`);
    process.exitCode = 1;
    return;
  }

  const headers = parsed.table.headers.map((h) => h.trim());
  const rows: RosterRow[] = [];

  if (headers.includes('姓名')) {
    const nameCol = headers.indexOf('姓名');
    const idCol = headers.indexOf('教师编号');
    for (const row of parsed.table.rows) {
      const teacherId = idCol >= 0 ? (row[idCol] ?? '').trim() : '';
      rows.push({
        displayName: (row[nameCol] ?? '').trim(),
        teacherId: teacherId === '' ? null : teacherId,
      });
    }
  } else {
    // 无表头：每行一个姓名。第一行已被解析器当表头，要一并收进来。
    for (const row of [parsed.table.headers, ...parsed.table.rows]) {
      const name = (row[0] ?? '').trim();
      if (name === '') continue;
      rows.push({ displayName: name, teacherId: null });
    }
    console.log('按「每行一个姓名」解析（未发现「姓名」表头），教师编号由系统生成。');
  }

  if (rows.length === 0) {
    console.error('名单里没有数据行');
    process.exitCode = 1;
    return;
  }

  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');

  const db = new CourseDatabase(dbPath);
  try {
    const auth = new AuthService(db);
    const login = auth.login(actorLogin, actorPassword);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再执行名单导入');
      process.exitCode = 1;
      return;
    }

    const result = new TeacherRosterService(db, auth).import(login.principal, rows, {
      fileName: basename(csvPath),
      sha256,
    });

    if (result.rejected.length > 0) {
      console.error(`整批拒绝：以下 ${result.rejected.length} 行有问题，一个教师档案都没有建。`);
      for (const r of result.rejected) {
        console.error(`  第 ${r.line} 行　${r.name || '(空)'}　[${r.code}] ${r.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const generated = result.imported.filter((t) => t.generated).length;
    const lines: string[] = [];
    lines.push(`=== 教师名单导入结果：已建 ${result.imported.length} 份教师档案 ===`);
    lines.push('');
    lines.push('教师编号'.padEnd(10) + '姓名'.padEnd(10) + '编号来源');
    for (const t of result.imported) {
      lines.push(String(t.teacherId).padEnd(10) + String(t.displayName).padEnd(10) + (t.generated ? '系统生成（待校方工号）' : '名单提供'));
    }
    lines.push('');
    lines.push('说明：');
    lines.push(`  · 数据来源为 IMPORTED_UNVERIFIED：名单未经校方核对，不得据此认定官方课表。`);
    if (generated > 0) {
      lines.push(`  · 其中 ${generated} 个编号由系统生成，只是占位。校方给出正式工号后须走显式迁移，不可就地改写。`);
    }
    lines.push('  · 本表含教师姓名，属个人信息，请妥善保管；不要放进代码仓库。');

    const out = lines.join('\n');
    console.log(out);

    const outFile = env('CA_OUT_FILE');
    if (outFile !== '') {
      writeFileSync(outFile, `${out}\n`, { mode: 0o600 });
      chmodSync(outFile, 0o600);
      console.log(`对照表已写入：${outFile}（权限 0600）`);
    }
  } catch (error) {
    console.error(`名单导入失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
