/**
 * 导入真实课表：CSV → 字段映射 → 校验 → 差异 → 发布。
 *
 * 必填环境变量：
 *   CA_DB_PATH          SQLite 文件路径
 *   CA_ACTOR_LOGIN      执行人账号（须具 IMPORT_TIMETABLE，即课务管理人员）
 *   CA_ACTOR_PASSWORD   执行人口令，仅用于本次登录；不落盘、不入日志
 *   CA_TIMETABLE_CSV    课表文件（UTF-8 CSV，列见 docs/04）
 *   CA_BASIS            发布依据编号/说明，写入审计，不得为空
 * 选填：
 *   CA_TERM_ID          学期 ID；库里只有一个学期时可省略
 *   CA_MODE             APPEND（默认）| REPLACE
 *   CA_ACK              为 1 时确认覆盖模式将停用现有排课
 *
 * 校验不通过时整批拒绝，模板表一条不动。发布后课次按学期日期展开。
 */

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';
import { ImportPipeline } from '../src/import/pipeline.js';
import { TimetableService } from '../src/service/timetable-service.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const actorLogin = env('CA_ACTOR_LOGIN');
  const actorPassword = env('CA_ACTOR_PASSWORD');
  const csvPath = env('CA_TIMETABLE_CSV');
  const basis = env('CA_BASIS');
  const mode = (env('CA_MODE') || 'APPEND').toUpperCase();
  const ack = env('CA_ACK') === '1';

  if (!dbPath || !actorLogin || !actorPassword || !csvPath || !basis) {
    console.error('缺少必填环境变量：CA_DB_PATH / CA_ACTOR_LOGIN / CA_ACTOR_PASSWORD / CA_TIMETABLE_CSV / CA_BASIS');
    process.exit(2);
  }
  if (mode !== 'APPEND' && mode !== 'REPLACE') {
    console.error(`CA_MODE 只能是 APPEND 或 REPLACE：${mode}`);
    process.exit(2);
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(csvPath);
  } catch {
    console.error(`读不到课表文件：${csvPath}`);
    process.exitCode = 1;
    return;
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');

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

    let termId = env('CA_TERM_ID');
    if (termId === '') {
      const terms = db.listTerms();
      if (terms.length !== 1) {
        console.error(`库中有 ${terms.length} 个学期，必须用 CA_TERM_ID 指定`);
        process.exitCode = 1;
        return;
      }
      termId = terms[0]!.id;
    }

    const pipeline = new ImportPipeline(db);
    const proposal = pipeline.previewMapping(basename(csvPath), buffer);
    if ('error' in proposal) {
      console.error(`文件无法识别：${proposal.error}`);
      process.exitCode = 1;
      return;
    }
    if (proposal.mapping === null) {
      console.error(`列名无法自动映射，缺列：${JSON.stringify(proposal)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`识别到的列：${JSON.stringify(proposal.detected)}`);

    const batchId = `B-${randomUUID()}`;
    const uploaded = pipeline.upload({
      batchId,
      termId,
      fileName: basename(csvPath),
      buffer,
      principal: login.principal,
      uploadedAt: new Date().toISOString(),
      mapping: proposal.mapping,
    });

    if (uploaded.status === 'REJECTED') {
      console.error(`整批拒绝 [${uploaded.code}]：${uploaded.message}`);
      for (const issue of uploaded.issues.slice(0, 40)) {
        console.error(`  第 ${issue.line} 行　[${issue.code}] ${issue.message}`);
      }
      if (uploaded.issues.length > 40) console.error(`  …… 另有 ${uploaded.issues.length - 40} 条`);
      process.exitCode = 1;
      return;
    }
    if (uploaded.status !== 'IMPORTED_NOT_PUBLISHED') {
      console.error(`上传未通过：${JSON.stringify(uploaded).slice(0, 400)}`);
      process.exitCode = 1;
      return;
    }

    console.log(`校验通过：${uploaded.rowCount} 行；批次 ${batchId}`);
    console.log(`差异：新增 ${uploaded.diff.added} / 删除 ${uploaded.diff.removed} / 不变 ${uploaded.diff.unchanged}`);

    const published = pipeline.publish(batchId, {
      principal: login.principal,
      authorizedRoles: ['S'],
      basisDocumentId: basis,
      mode: mode as 'APPEND' | 'REPLACE',
      acknowledged: ack,
      at: new Date().toISOString(),
    });

    if (!published.ok) {
      console.error(`发布未通过 [${published.code}]：${published.message}`);
      process.exitCode = 1;
      return;
    }

    // 发布只写模板；课次要按学期日期展开后才可查询（服务端查询直接读 occurrence）。
    const term = db.getTerm(termId);
    if (!term) {
      console.error(`学期 ${termId} 不存在`);
      process.exitCode = 1;
      return;
    }
    const timetable = new TimetableService(db);
    const built = timetable.build(termId, term.term.startMonday, term.term.endDate);

    const stats = db.occurrenceStats(termId);
    console.log('');
    console.log('=== 课表导入结果 ===');
    console.log(`  批次：${batchId}`);
    console.log(`  文件：${basename(csvPath)}　sha256=${sha256.slice(0, 16)}…`);
    console.log(`  发布：${published.status}　写入模板=${published.wrote}`);
    console.log(`  展开：${term.term.startMonday} ~ ${term.term.endDate}　课次=${built.occurrenceCount}`);
    if (built.unresolved.length > 0) {
      const byCode = new Map<string, number>();
      for (const u of built.unresolved) {
        const key = typeof u === 'object' && u !== null && 'code' in u ? String((u as { code: unknown }).code) : 'UNKNOWN';
        byCode.set(key, (byCode.get(key) ?? 0) + 1);
      }
      console.log(`  未解析：${JSON.stringify([...byCode])}`);
    }
    console.log(`  课次：${JSON.stringify(stats)}`);
    console.log(`  依据：${basis}`);
  } catch (error) {
    console.error(`课表导入失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
