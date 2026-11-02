/**
 * 导入班级与科目：读 CSV → 整批预检 → 一次写两类基础资料。
 *
 * 必填环境变量：
 *   CA_DB_PATH          SQLite 文件路径
 *   CA_ACTOR_LOGIN      执行人账号（须具 IMPORT_ROSTER，即课务管理人员）
 *   CA_ACTOR_PASSWORD   执行人口令，仅用于本次登录；不落盘、不入日志
 * 二选一（至少一项，可同时给）：
 *   CA_CLASSES_CSV      班级文件，表头「班级,年级」
 *   CA_SUBJECTS_CSV     科目文件，表头「科目」，或无表头每行一个
 *
 * 预检不通过时一条都不写；库里已有班级或科目时拒绝导入。
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';
import { SchoolBaseImportService, type ClassInput, type SubjectInput } from '../src/service/school-base-import-service.js';
import { parseCsv } from '../src/import/csv.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function readTable(path: string): { headers: readonly string[]; rows: readonly (readonly string[])[] } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`读不到文件：${path}`);
    return null;
  }
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    console.error(`解析失败 [${parsed.code}]：${parsed.message}（${path}）`);
    return null;
  }
  return { headers: parsed.table.headers.map((h) => h.trim()), rows: parsed.table.rows };
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const classesPath = env('CA_CLASSES_CSV');
  const subjectsPath = env('CA_SUBJECTS_CSV');

  if (!dbPath || !actorLogin || !actorPassword) {
    console.error('缺少必填环境变量：CA_DB_PATH / CA_ACTOR_LOGIN / CA_ACTOR_PASSWORD');
    process.exit(2);
  }
  if (!classesPath && !subjectsPath) {
    console.error('至少要给一个：CA_CLASSES_CSV 或 CA_SUBJECTS_CSV');
    process.exit(2);
  }

  let classes: ClassInput[] = [];
  if (classesPath) {
    const table = readTable(classesPath);
    if (!table) {
      process.exitCode = 1;
      return;
    }
    const nameCol = table.headers.indexOf('班级');
    const gradeCol = table.headers.indexOf('年级');
    if (nameCol < 0 || gradeCol < 0) {
      console.error('班级文件必须含表头「班级」与「年级」');
      process.exitCode = 1;
      return;
    }
    classes = table.rows.map((r) => ({ name: (r[nameCol] ?? '').trim(), grade: (r[gradeCol] ?? '').trim() }));
    console.log(`班级文件：${basename(classesPath)}，${classes.length} 行`);
  }

  let subjects: SubjectInput[] = [];
  if (subjectsPath) {
    const table = readTable(subjectsPath);
    if (!table) {
      process.exitCode = 1;
      return;
    }
    const col = table.headers.includes('科目') ? table.headers.indexOf('科目') : -1;
    if (col >= 0) {
      subjects = table.rows.map((r) => ({ name: (r[col] ?? '').trim() }));
    } else {
      // 无表头：第一行也是数据
      subjects = [table.headers[0] ?? '', ...table.rows.map((r) => r[0] ?? '')]
        .map((n) => n.trim())
        .filter((n) => n !== '')
        .map((name) => ({ name }));
      console.log('按「每行一个科目」解析（未发现「科目」表头）');
    }
    console.log(`科目文件：${basename(subjectsPath)}，${subjects.length} 行`);
  }

  const db = new CourseDatabase(dbPath);
  try {
    const auth = new AuthService(db);
    const login = auth.login(actorLogin, actorPassword, env('CA_ACTOR_ROLE') || undefined);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再执行导入');
      process.exitCode = 1;
      return;
    }

    db.requireMode('PRODUCTION');

    const service = new SchoolBaseImportService(db, auth);
    const report: string[] = [];

    if (classes.length > 0) {
      const r = service.importClasses(login.principal, classes);
      report.push(`班级：写入 ${r.count} 条（${r.dataOrigin}）`);
    }
    if (subjects.length > 0) {
      const r = service.importSubjects(login.principal, subjects);
      report.push(`科目：写入 ${r.count} 条（${r.dataOrigin}）`);
    }

    console.log('');
    console.log('=== 基础资料导入结果 ===');
    for (const line of report) console.log('  · ' + line);
    console.log('说明：数据来源为 IMPORTED_UNVERIFIED，未经校方逐条核对前不得据此认定官方课表。');
  } catch (error) {
    console.error(`导入失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
