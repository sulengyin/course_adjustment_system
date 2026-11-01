import { mintPrincipal } from '../src/auth/principal.js';
import { ImportPipeline } from '../src/import/pipeline.js';
import { TimetableService } from '../src/service/timetable-service.js';
import { CourseDatabase } from '../src/store/database.js';
import { DEMO_SNAPSHOT } from '../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;
const FROM = '2026-08-31';
const TO = '2026-12-31';

const CLEAN = { ...DEMO_SNAPSHOT, templates: [], exceptions: [] };

const CSV = [
  '教师,班级,科目,星期,节次,单双周',
  '示例教师甲,虚构一年一班,语文,周一,1,',
  '示例教师乙,虚构一年一班,数学,周一,2,',
  '示例教师丙,虚构一年二班,英语,周二,1,单周',
  '示例教师丁,虚构一年二班,体育,周二,1,双周',
].join('\n');

const CLERK = mintPrincipal({
  userId: 'U-REGISTRAR',
  teacherId: null,
  displayName: '课务管理人员',
  roles: ['S'],
  actingRole: 'S',
  sessionId: 'S-DEMO',
  mustChangePassword: false,
});

const db = new CourseDatabase(':memory:');
const service = new TimetableService(db);
const pipeline = new ImportPipeline(db);
service.load(CLEAN);

const buffer = Buffer.from(CSV, 'utf8');
const mapping = pipeline.previewMapping('课表.csv', buffer);
if ('error' in mapping || mapping.mapping === null) {
  console.log('映射识别失败', mapping);
  process.exit(1);
}

console.log('=== P3 导入演示（全部虚构）===');
console.log(`识别到的列：${JSON.stringify(mapping.detected)}`);
console.log('');

const uploaded = pipeline.upload({
  batchId: 'B-DEMO-1',
  termId: TERM,
  fileName: '课表.csv',
  buffer,
  principal: CLERK,
  uploadedAt: '2026-08-20T09:00:00Z',
  mapping: mapping.mapping,
});
console.log('--- 上传 ---');
console.log(JSON.stringify(uploaded, null, 2));
console.log('');

console.log('--- 发布：未配置可发布角色 ---');
const blocked = pipeline.publish('B-DEMO-1', {
  principal: CLERK,
  authorizedRoles: [],
  basisDocumentId: 'DEMO-DOC-1',
  mode: 'APPEND',
  at: '2026-08-21T09:00:00Z',
});
console.log(`${blocked.ok ? '成功' : blocked.code}：${blocked.ok ? '' : blocked.message}`);
console.log('');

console.log('--- 发布：校方登记了书面依据，配置 S 可发布 ---');
const published = pipeline.publish('B-DEMO-1', {
  principal: CLERK,
  authorizedRoles: ['S'],
  basisDocumentId: 'DEMO-DOC-1',
  mode: 'APPEND',
  at: '2026-08-21T09:00:00Z',
});
console.log(JSON.stringify(published, null, 2));
console.log('');

service.build(TERM, FROM, TO);
console.log('--- 发布后的周一课表 ---');
const rows = db
  .queryAll(TERM, FROM, TO)
  .filter((r) => r.date === '2026-08-31');
for (const r of rows) {
  console.log(`${r.date} 第${r.period}节 ${r.startsAt ?? '--'}-${r.endsAt ?? '--'} ${r.className} ${r.subjectName} ${r.teacherName} [${r.dataOrigin}]`);
}
console.log('');

console.log('--- 重复上传同一文件 ---');
const again = pipeline.upload({
  batchId: 'B-DEMO-2',
  termId: TERM,
  fileName: '课表.csv',
  buffer,
  principal: CLERK,
  uploadedAt: '2026-08-22T09:00:00Z',
  mapping: mapping.mapping,
});
const republished = pipeline.publish('B-DEMO-2', {
  principal: CLERK,
  authorizedRoles: ['S'],
  basisDocumentId: 'DEMO-DOC-1',
  mode: 'APPEND',
  at: '2026-08-22T09:00:00Z',
});
console.log(`上传：${again.status}`);
console.log(`发布：wrote=${republished.ok ? String(republished.wrote) : republished.code}，差异 ${JSON.stringify(republished.ok ? republished.diff : {})}`);
console.log('');

console.log('--- 撤销第一批次 ---');
const before = db.countTemplates(TERM);
const revoked = pipeline.revoke('B-DEMO-1', {
  at: '2026-09-01T00:00:00Z',
  reason: '误传',
  principal: CLERK,
});
console.log(`撤销结果：${JSON.stringify(revoked)}`);
console.log(`模板总行数：撤销前 ${before}，撤销后 ${db.countTemplates(TERM)}（墓碑不删行）`);
console.log(`仍在生效的模板：${db.activeTemplates(TERM).length}`);

db.close();
