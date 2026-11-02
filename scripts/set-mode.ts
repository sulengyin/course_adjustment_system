/**
 * 设定一个库的环境：演示 / 联调（DEMO）或正式业务（PRODUCTION）。
 *
 * 必填环境变量：
 *   CA_DB_PATH   SQLite 文件路径
 *   CA_MODE      demo | production
 * 选填：
 *   CA_PURGE_SIMULATED=1   切到正式环境时，清除库里全部虚构数据（SIMULATED）
 *
 * 三条规则：
 *  1. 环境一经设定不可更改。想换环境只能另建库——否则此前数据的归属要全部重新解释。
 *  2. 演示库不得含真实数据：库里已有 IMPORTED_UNVERIFIED / OFFICIAL 记录时，拒绝标为 DEMO。
 *  3. 正式库不得含虚构数据：库里仍有 SIMULATED 记录时，必须显式给出 CA_PURGE_SIMULATED=1 才继续；
 *     且仅当库里没有任何已生效业务事实（调课方案、生效记录、求助、导入批次）时才允许清除。
 *
 * 停用绑定虚构教师的账号，而不是删除账号：审计里留着"这个账号存在过"的事实更可靠。
 */

import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import type { DeploymentMode } from '../src/domain/model.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** 已生效的业务事实：有这些就不能清库，否则等于抹掉真实发生过的事 */
const FACT_TABLES = ['change_case', 'effective_change', 'assignment_state', 'emergency_request', 'import_batch'] as const;

interface PurgeReport {
  disabledAccounts: number;
  teachers: number;
  classes: number;
  subjects: number;
  terms: number;
  templates: number;
  occurrences: number;
  bell: number;
  exceptions: number;
}

function purgeSimulated(db: CourseDatabase): PurgeReport {
  const h = db.handle;
  const occupied = FACT_TABLES.filter(
    (t) => (h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n > 0,
  );
  if (occupied.length > 0) {
    throw new Error(
      `库里已有已生效的业务事实（${occupied.join('、')}），不允许清除虚构数据。` +
        '请改用新建库的方式建立正式环境，以免抹掉真实记录。',
    );
  }

  const report: PurgeReport = {
    disabledAccounts: 0,
    teachers: 0,
    classes: 0,
    subjects: 0,
    terms: 0,
    templates: 0,
    occurrences: 0,
    bell: 0,
    exceptions: 0,
  };

  db.transaction(() => {
    const at = new Date().toISOString();
    // 绑定虚构教师的账号先解绑并停用：外键仍指向教师时删不掉，且留着会变成孤儿账号。
    const simulated = h
      .prepare("SELECT id FROM teacher WHERE data_origin = 'SIMULATED'")
      .all() as Array<{ id: string }>;
    const disable = h.prepare(
      `UPDATE app_user SET teacher_id = NULL, status = 'DISABLED', disabled_at = ?, disabled_by = 'SYSTEM'
       WHERE teacher_id = ? AND status = 'ACTIVE'`,
    );
    for (const t of simulated) report.disabledAccounts += Number(disable.run(at, t.id).changes);

    const del = (table: string): number =>
      Number(h.prepare(`DELETE FROM ${table} WHERE data_origin = 'SIMULATED'`).run().changes);

    report.occurrences = del('occurrence');
    report.templates = del('teaching_template');
    report.exceptions = del('calendar_exception');
    report.bell = del('bell');
    report.terms = del('term');
    report.subjects = del('subject');
    report.classes = del('school_class');
    report.teachers = del('teacher');

    db.auditLog.append({
      at,
      actor: 'SYSTEM',
      action: 'PURGE_SIMULATED',
      objectType: 'DATABASE',
      objectId: 'deployment_mode',
      beforeState: 'DEMO_UNSET',
      afterState: JSON.stringify(report),
      reason: 'PROMOTE_TO_PRODUCTION',
    });
  });

  return report;
}

function countNonSimulated(db: CourseDatabase): number {
  const h = db.handle;
  const tables = ['teacher', 'school_class', 'subject', 'term'];
  let n = 0;
  for (const t of tables) {
    n += (h.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE data_origin <> 'SIMULATED'`).get() as { n: number }).n;
  }
  return n;
}

function countSimulated(db: CourseDatabase): number {
  const h = db.handle;
  const tables = ['teacher', 'school_class', 'subject', 'term', 'occurrence'];
  let n = 0;
  for (const t of tables) {
    n += (h.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE data_origin = 'SIMULATED'`).get() as { n: number }).n;
  }
  return n;
}

function main(): void {
  const dbPath = env('CA_DB_PATH');
  const modeRaw = env('CA_MODE').toLowerCase();
  if (!dbPath || modeRaw === '') {
    console.error('缺少必填环境变量：CA_DB_PATH / CA_MODE（demo 或 production）');
    process.exit(2);
  }
  if (modeRaw !== 'demo' && modeRaw !== 'production') {
    console.error(`CA_MODE 只能是 demo 或 production，收到：${modeRaw}`);
    process.exit(2);
  }
  const mode: DeploymentMode = modeRaw === 'demo' ? 'DEMO' : 'PRODUCTION';

  const db = new CourseDatabase(dbPath);
  try {
    const current = db.deploymentMode();
    if (current !== null) {
      console.error(`该库已设定为${MODE_LABEL[current]}（${current}），不可更改。需要另一种环境请新建库。`);
      process.exitCode = 1;
      return;
    }

    if (mode === 'PRODUCTION') {
      const simulated = countSimulated(db);
      if (simulated > 0) {
        if (env('CA_PURGE_SIMULATED') !== '1') {
          console.error(
            `库里仍有 ${simulated} 条虚构数据（SIMULATED），不能直接标为正式环境。\n` +
              '若确认这些都是演示残留、可以清除，请加：CA_PURGE_SIMULATED=1\n' +
              '若其中混着你需要的真实数据，请改用新建库的方式，不要就地清除。',
          );
          process.exitCode = 1;
          return;
        }
        const report = purgeSimulated(db);
        console.log('已清除虚构数据：');
        console.log(`  教师 ${report.teachers}　班级 ${report.classes}　科目 ${report.subjects}　学期 ${report.terms}`);
        console.log(`  课表模板 ${report.templates}　课次 ${report.occurrences}　铃声 ${report.bell}　例外 ${report.exceptions}`);
        console.log(`  因绑定虚构教师而停用的账号：${report.disabledAccounts} 个（账号保留，仅停用解绑）`);
      }
    } else {
      const real = countNonSimulated(db);
      if (real > 0) {
        console.error(
          `库里已有 ${real} 条真实数据（非 SIMULATED），不能标为演示环境——` +
            '演示库里的数据会被当成可以随便试的东西，真实数据不得留在那里。',
        );
        process.exitCode = 1;
        return;
      }
    }

    db.setDeploymentMode(mode);
    console.log(
      mode === 'DEMO'
        ? '已标记为演示 / 联调环境（DEMO）：只可载入虚构数据，导入真实名单与真实课表会被拒绝。'
        : '已标记为正式业务环境（PRODUCTION）：只可导入真实数据，载入虚构演示数据会被拒绝。',
    );
    console.log('此后该库的环境不可更改；如需另一种环境，请新建库。');
  } catch (error) {
    console.error(`设定环境失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
