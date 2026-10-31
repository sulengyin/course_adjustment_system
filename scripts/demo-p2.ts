import { TimetableService } from '../src/service/timetable-service.js';
import { CourseDatabase } from '../src/store/database.js';
import { DEFECTS, DEMO_SNAPSHOT } from '../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

const db = new CourseDatabase(':memory:');
const service = new TimetableService(db);
service.load(DEMO_SNAPSHOT);

const build = service.build(TERM, FROM, TO);

console.log('=== 模拟数据演示（全部虚构） ===');
console.log(`学期：${DEMO_SNAPSHOT.term.label} ${FROM} ~ ${TO}`);
console.log(`生成课次：${build.occurrenceCount}`);
console.log('');

console.log('--- 示例教师甲 第一、二周课表 ---');
const view = service.teacherView(TERM, 'T01', FROM, TO);
const rows = view.rows.filter((r) => r.date <= '2026-09-13');
if (rows.length === 0) console.log('（无课次）');
for (const r of rows) {
  const time = r.startsAt === null ? '时间未配置' : `${r.startsAt}-${r.endsAt ?? '结束时间未配置'}`;
  console.log(
    `${r.date} 第${r.period}节 ${time.padEnd(18)} ${r.className} ${r.subjectName} [${r.certainty}]`,
  );
}
console.log('');

console.log('--- 结构性冲突（硬冲突）---');
if (build.conflicts.hard.length === 0) console.log('（无）');
for (const c of build.conflicts.hard) {
  console.log(`${c.date} 第${c.period}节 ${c.kind === 'TEACHER' ? '教师' : '班级'}冲突：${c.occurrenceIds.join(' / ')}`);
}
console.log(`待核验冲突（时间不确定，不判硬冲突）：${build.conflicts.unresolved.length} 组`);
console.log('');

console.log('--- 无法判定的日期（不当作"没课"）---');
for (const d of build.unknownDays) console.log(`${d.date} → ${d.reason}`);
console.log('');

console.log('--- 无法生成的课次 ---');
const byReason = new Map<string, number>();
for (const u of build.unresolved) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
for (const [reason, n] of byReason) console.log(`${reason}：${n} 节`);
console.log('');

console.log('--- 数据集已知缺陷 ---');
for (const d of DEFECTS) console.log(`· ${d}`);

db.close();
