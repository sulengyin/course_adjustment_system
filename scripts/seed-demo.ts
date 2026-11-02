/**
 * 生成"仅用于演示与测试"的库：虚构校历 + 虚构账号。
 *
 * 三条硬约束：
 *  1. 只写 SIMULATED 数据，不碰真实学校的任何文件。
 *  2. 库里已有数据时拒绝执行，避免把正式数据清空。
 *  3. 账号一律 must_change_password=1，首次登录必须改密——演示也不例外。
 */

import { CourseDatabase, MODE_LABEL } from '../src/store/database.js';
import { DEFECTS, DEMO_SNAPSHOT } from '../src/store/fixtures.js';
import { TimetableService } from '../src/service/timetable-service.js';
import { AuthService } from '../src/auth/service.js';
import type { LoginResult } from '../src/auth/service.js';

const dbPath = process.env.CA_DB_PATH?.trim() ?? '';
const password = process.env.CA_SEED_PASSWORD?.trim() || 'Demo!2026pass';

function assertLogin(result: LoginResult): Extract<LoginResult, { ok: true }> {
  if (!result.ok) throw new Error(`登录失败：${result.code}`);
  return result;
}

function main(): void {
  if (dbPath === '') {
    console.error('缺少必填环境变量 CA_DB_PATH');
    process.exit(2);
  }

  const db = new CourseDatabase(dbPath);
  try {
    // 环境闸门必须在"库是否为空"之前：一个空的正式库同样不许灌虚构数据。
    const mode = db.deploymentMode();
    if (mode === null) {
      db.setDeploymentMode('DEMO');
      console.log('本库尚未设定环境，已标记为演示 / 联调环境（DEMO）：此后不得导入真实名单与真实课表。');
    } else if (mode !== 'DEMO') {
      console.error(
        `拒绝执行：当前库是${MODE_LABEL[mode]}（${mode}），不能载入虚构演示数据。` +
          '演示请另建一个库。',
      );
      process.exit(3);
    }

    const existingTerms = db.listTerms().length;
    const existingUsers = db.countAccounts();
    if (existingTerms > 0 || existingUsers > 0) {
      console.error(
        `数据库已有数据（学期 ${existingTerms} 个、账号 ${existingUsers} 个），拒绝覆盖。` +
          '如需重建，请换一个空的 CA_DB_PATH。',
      );
      process.exit(3);
    }

    const timetable = new TimetableService(db);
    timetable.load(DEMO_SNAPSHOT);
    const build = timetable.build(
      DEMO_SNAPSHOT.term.id,
      DEMO_SNAPSHOT.term.startMonday,
      DEMO_SNAPSHOT.term.endDate,
    );

    const auth = new AuthService(db);
    // 先用一次性口令建号，立刻改成部署方指定的口令；这样打印出来的就是可用口令。
    const boot = auth.bootstrapAdmin({ loginName: 'admin', displayName: '系统管理员' });
    const first = assertLogin(auth.login('admin', boot.initialPassword, 'A'));
    auth.changePassword(first.principal, boot.initialPassword, password);
    const admin = assertLogin(auth.login('admin', password, 'A'));

    const created: Array<{ loginName: string; displayName: string; roles: string; password: string }> = [];

    const addUser = (loginName: string, displayName: string, teacherId: string | null, roles: string[]): void => {
      const result = auth.createUser(admin.principal, { loginName, displayName, teacherId, roles });
      created.push({ loginName, displayName, roles: roles.join('+'), password: result.initialPassword });
    };

    addUser('teacher01', '示例教师甲', 'T01', ['T']);
    addUser('teacher02', '示例教师乙', 'T02', ['T']);
    addUser('teacher03', '示例教师丙', 'T03', ['T']);
    addUser('staff', '课务管理人员', null, ['S']);

    const stats = db.occurrenceStats(DEMO_SNAPSHOT.term.id);

    console.log('=== 演示数据已写入（全部虚构） ===');
    console.log(`数据库：${dbPath}`);
    console.log(`学期：${DEMO_SNAPSHOT.term.label}　课次：${build.occurrenceCount}（SIMULATED ${stats.simulated}）`);
    console.log('');
    console.log('账号：');
    console.log(`  admin      系统管理员（A）　口令 ${password}（初始化时已设置）`);
    for (const user of created) {
      console.log(`  ${user.loginName.padEnd(10)} ${user.displayName}（${user.roles}）　初始口令 ${user.password}`);
    }
    console.log('');
    console.log('已知缺陷（样本故意保留）：');
    for (const defect of DEFECTS) console.log(`  · ${defect}`);
  } finally {
    db.close();
  }
}

main();
