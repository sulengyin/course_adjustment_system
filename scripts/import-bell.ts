/**
 * 导入真实学期与作息（第 1..N 节课的起止时间）。
 *
 * 必填环境变量：
 *   CA_DB_PATH              SQLite 文件路径（必须是已设定为 PRODUCTION 的库）
 *   CA_ACTOR_LOGIN          执行人账号（须具 IMPORT_TIMETABLE 权限，即课务管理人员）
 *   CA_ACTOR_PASSWORD       执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_TERM_LABEL           学期名称，如「2026—2027学年第一学期」
 *   CA_TERM_START_MONDAY    学期第一周的周一，YYYY-MM-DD，必须是周一
 *   CA_TERM_END_DATE        学期最后一天（含），YYYY-MM-DD
 *   CA_BELL_CSV             作息 CSV（列：period,starts_at,ends_at）
 * 选填：
 *   CA_TERM_FIRST_WEEK      odd | even；不填 = 学校未声明单双周
 *
 * 作息 CSV 只放课节。大课间、眼保健操、午餐午休、课后服务时段都不是课节，
 * 塞进 bell 会被课表当成一节课，故不接收。
 */

import { readFileSync } from 'node:fs';
import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import { AuthService, PolicyDeniedError } from '../src/auth/service.js';
import { TermImportError, TermImportService } from '../src/service/term-import-service.js';
import { parseCsv } from '../src/import/csv.js';
import type { BellEntry, WeekParity } from '../src/domain/model.js';

const HEADERS = ['period', 'starts_at', 'ends_at'] as const;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const label = env('CA_TERM_LABEL');
  const startMonday = env('CA_TERM_START_MONDAY');
  const endDate = env('CA_TERM_END_DATE');
  const bellCsv = env('CA_BELL_CSV');

  const missing = [
    ['CA_DB_PATH', dbPath],
    ['CA_ACTOR_LOGIN', actorLogin],
    ['CA_ACTOR_PASSWORD', actorPassword],
    ['CA_TERM_LABEL', label],
    ['CA_TERM_START_MONDAY', startMonday],
    ['CA_TERM_END_DATE', endDate],
    ['CA_BELL_CSV', bellCsv],
  ]
    .filter(([, v]) => v === '')
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`缺少必填环境变量：${missing.join(' / ')}`);
    process.exit(2);
  }

  const parityRaw = env('CA_TERM_FIRST_WEEK').toLowerCase();
  let firstWeekParity: WeekParity | null = null;
  if (parityRaw !== '') {
    if (parityRaw !== 'odd' && parityRaw !== 'even') {
      console.error('CA_TERM_FIRST_WEEK 只能是 odd / even；不确定就留空（表示学校未声明）');
      process.exit(2);
    }
    firstWeekParity = parityRaw === 'odd' ? 'ODD' : 'EVEN';
  }

  let text: string;
  try {
    text = readFileSync(bellCsv, 'utf8');
  } catch {
    console.error(`读不到作息文件：${bellCsv}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    console.error(`作息文件解析失败 [${parsed.code}]：${parsed.message}`);
    process.exitCode = 1;
    return;
  }
  const headers = parsed.table.headers.map((h) => h.trim());
  const absent = HEADERS.filter((h) => !headers.includes(h));
  if (absent.length > 0) {
    console.error(`作息缺少必需的列：${absent.join('、')}（当前表头：${headers.join('、') || '空'}）`);
    process.exitCode = 1;
    return;
  }
  const col = (name: string): number => headers.indexOf(name);

  const bells: BellEntry[] = parsed.table.rows.map((row) => {
    const rawPeriod = (row[col('period')] ?? '').trim();
    const startsAt = (row[col('starts_at')] ?? '').trim();
    const endsAt = (row[col('ends_at')] ?? '').trim();
    return {
      period: Number(rawPeriod),
      startsAt: startsAt === '' ? null : startsAt,
      endsAt: endsAt === '' ? null : endsAt,
    };
  });
  if (bells.length === 0) {
    console.error('作息文件里没有数据行');
    process.exitCode = 1;
    return;
  }

  const db = new CourseDatabase(dbPath);
  try {
    db.requireMode('PRODUCTION');
    const auth = new AuthService(db);
    const login = auth.login(actorLogin, actorPassword);
    if (!login.ok) {
      console.error(`执行人登录失败 [${login.code}]：无法确认操作人身份，已中止`);
      process.exitCode = 1;
      return;
    }
    if (login.principal.mustChangePassword) {
      console.error('执行人尚未修改初始口令，请先登录改密后再导入作息');
      process.exitCode = 1;
      return;
    }

    const result = new TermImportService(db, auth).import(login.principal, {
      label,
      startMonday,
      endDate,
      firstWeekParity,
      bells,
    });

    console.log('=== 学期与作息已导入 ===');
    console.log(`环境      ${MODE_LABEL.PRODUCTION}（PRODUCTION）`);
    console.log(`学期      ${label}`);
    console.log(`区间      ${startMonday} — ${endDate}（第一周单双周：${firstWeekParity ?? '未声明'}）`);
    console.log(`课节      ${result.periods} 节`);
    for (const b of bells) {
      console.log(`  第 ${b.period} 节   ${b.startsAt}–${b.endsAt}`);
    }
    console.log(`数据来源  IMPORTED_UNVERIFIED（真实作息，未经校方逐项核对，不得当作官方课表时间）`);
    console.log('注意：大课间、眼保健操、午餐午休、课后服务时段不属于课节，未写入作息。');
  } catch (error) {
    if (error instanceof TermImportError) {
      console.error(`导入被拒绝 [${error.code}]：${error.message}`);
    } else if (error instanceof PolicyDeniedError) {
      console.error(`导入被拒绝 [${error.code}]：${error.message}（作息导入属课务管理职责）`);
    } else {
      console.error(`导入失败：${(error as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
