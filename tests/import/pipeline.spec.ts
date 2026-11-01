import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPrincipal } from '../../src/auth/principal.js';
import { ImportPipeline } from '../../src/import/pipeline.js';
import type { Mapping } from '../../src/import/types.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_BELL, DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

const TERM = DEMO_SNAPSHOT.term.id;

/** 干净学校：有教师/班级/科目，没有排课、没有模拟课表 */
const CLEAN = {
  ...DEMO_SNAPSHOT,
  templates: [],
  exceptions: [],
  bell: DEMO_BELL,
};

const CSV_ROWS = [
  '教师,班级,科目,星期,节次,单双周',
  '示例教师甲,虚构一年一班,语文,周一,1,',
  '示例教师乙,虚构一年一班,数学,周一,2,',
  '示例教师丙,虚构一年二班,英语,周二,1,单周',
  '示例教师丁,虚构一年二班,体育,周二,1,双周',
];

function buf(lines: readonly string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf8');
}

let db: CourseDatabase;
let pipeline: ImportPipeline;
let service: TimetableService;

function mappingOf(content: Buffer): Mapping {
  const p = pipeline.previewMapping('课表.csv', content);
  if ('error' in p || p.mapping === null) throw new Error('映射识别失败');
  return p.mapping;
}

const CLERK = mintPrincipal({
  userId: 'U-REGISTRAR',
  teacherId: null,
  displayName: '课务管理人员',
  roles: ['S'],
  actingRole: 'S',
  sessionId: 'S-CLERK',
  mustChangePassword: false,
});

function stage(batchId: string, lines: readonly string[] = CSV_ROWS): string {
  const content = buf(lines);
  const r = pipeline.upload({
    batchId,
    termId: TERM,
    fileName: '课表.csv',
    buffer: content,
    principal: CLERK,
    uploadedAt: '2026-08-20T09:00:00Z',
    mapping: mappingOf(content),
  });
  if (r.status !== 'IMPORTED_NOT_PUBLISHED') throw new Error(`导入失败：${JSON.stringify(r)}`);
  return batchId;
}

function publish(batchId: string, extra: Partial<Parameters<ImportPipeline['publish']>[1]> = {}) {
  return pipeline.publish(batchId, {
    principal: CLERK,
    authorizedRoles: ['S'],
    basisDocumentId: 'DOC-TEST-001',
    mode: 'APPEND',
    at: '2026-08-21T09:00:00Z',
    ...extra,
  });
}

beforeEach(() => {
  db = new CourseDatabase(':memory:');
  service = new TimetableService(db);
  service.load(CLEAN);
  pipeline = new ImportPipeline(db);
});

afterEach(() => db.close());

describe('P3 验收 1：同一文件重复上传，净变化为 0', () => {
  it('第二次发布不新增任何课次', () => {
    stage('B1');
    expect(publish('B1').ok).toBe(true);
    service.build(TERM, '2026-08-31', '2026-12-31');
    const before = db.occurrenceFingerprint(TERM);
    const countBefore = db.queryAll(TERM, '2026-08-31', '2026-12-31').length;

    stage('B2');
    const second = publish('B2', { at: '2026-08-22T09:00:00Z' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.wrote).toBe(false);
    expect(second.diff).toMatchObject({ added: 0, removed: 0 });

    service.build(TERM, '2026-08-31', '2026-12-31');
    expect(db.queryAll(TERM, '2026-08-31', '2026-12-31').length).toBe(countBefore);
    expect(db.occurrenceFingerprint(TERM)).toBe(before);
    expect(db.countBatches()).toBe(2);
  });
});

describe('P3 验收 2：行序打乱后差异为"无变化"', () => {
  it('同样四行换个顺序，diff 全为 0', () => {
    const shuffled = [CSV_ROWS[0]!, CSV_ROWS[3]!, CSV_ROWS[1]!, CSV_ROWS[4]!, CSV_ROWS[2]!];
    const content = buf(shuffled);
    const r = pipeline.upload({
      batchId: 'B1',
      termId: TERM,
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
      mapping: mappingOf(content),
    });
    expect(r.status).toBe('IMPORTED_NOT_PUBLISHED');
    expect(publish('B1').ok).toBe(true);

    const again = pipeline.upload({
      batchId: 'B2',
      termId: TERM,
      fileName: '课表.csv',
      buffer: buf(CSV_ROWS),
      principal: CLERK,
      uploadedAt: '2026-08-20T10:00:00Z',
      mapping: mappingOf(buf(CSV_ROWS)),
    });
    expect(again.status).toBe('IMPORTED_NOT_PUBLISHED');
    const result = publish('B2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff.added).toBe(0);
    expect(result.diff.removed).toBe(0);
    expect(result.diff.unchanged).toBe(4);
  });
});

describe('P3 验收 3：含非法行整批拒绝', () => {
  it('一行错误导致整批不落库，正式数据指纹不变', () => {
    stage('B0');
    publish('B0');
    const before = db.templateFingerprint(TERM);

    const bad = [...CSV_ROWS, '不存在的老师,虚构一年三班,语文,周一,3,'];
    const content = buf(bad);
    const r = pipeline.upload({
      batchId: 'B-BAD',
      termId: TERM,
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-23T09:00:00Z',
      mapping: mappingOf(content),
    });

    expect(r.status).toBe('REJECTED');
    if (r.status !== 'REJECTED') return;
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(r.issues.length).toBeGreaterThan(0);
    expect(db.templateFingerprint(TERM)).toBe(before);
    expect(db.getBatch('B-BAD')?.status).toBe('REJECTED');
    expect(db.rowsOfBatch('B-BAD')).toHaveLength(0);
  });
});

describe('P3 验收 4：上传不等于正式发布', () => {
  it('上传后状态为 IMPORTED_NOT_PUBLISHED，课表尚未正式生效', () => {
    stage('B1');
    expect(db.getBatch('B1')?.status).toBe('IMPORTED_NOT_PUBLISHED');
    expect(db.activeTemplates(TERM)).toHaveLength(0);

    const state = pipeline.publicationState(TERM);
    expect(state.published).toBe(false);
    expect(state.pendingBatchIds).toEqual(['B1']);

    publish('B1');
    const after = pipeline.publicationState(TERM);
    expect(after.published).toBe(true);
    expect(after.pendingBatchIds).toEqual([]);
    expect(after.lastPublishedBatchId).toBe('B1');
  });

  it('导入批次标记 IMPORTED_UNVERIFIED，只有发布动作才产出 OFFICIAL', () => {
    stage('B1');
    expect(db.getBatch('B1')?.dataOrigin).toBe('IMPORTED_UNVERIFIED');
    expect(db.activeTemplates(TERM)).toHaveLength(0);
    expect(db.hasSimulated(TERM)).toBe(false);

    publish('B1');
    service.build(TERM, '2026-08-31', '2026-12-31');
    const rows = db.activeTemplates(TERM);
    expect(rows).toHaveLength(4);
    const timetable = db.queryAll(TERM, '2026-08-31', '2026-12-31');
    expect(timetable.length).toBeGreaterThan(0);
    for (const row of timetable) expect(row.dataOrigin).toBe('OFFICIAL');
  });
});

describe('P3 验收 5：撤销批次不删除已生效数据', () => {
  it('只打墓碑并留标记，模板行数不变', () => {
    stage('B1');
    publish('B1');
    service.build(TERM, '2026-08-31', '2026-12-31');
    const totalBefore = db.countTemplates(TERM);
    expect(totalBefore).toBe(4);

    const r = pipeline.revoke('B1', { at: '2026-09-01T00:00:00Z', reason: '误传版本', principal: CLERK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tombstonedTemplateIds).toHaveLength(4);
    expect(r.markers).toBe(4);

    expect(db.countTemplates(TERM)).toBe(totalBefore);
    expect(db.activeTemplates(TERM)).toHaveLength(0);
    expect(db.getBatch('B1')?.status).toBe('REVOKED');
  });

  it('未发布的批次不能撤销', () => {
    stage('B1');
    const r = pipeline.revoke('B1', { at: '2026-09-01T00:00:00Z', reason: 'x', principal: CLERK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BAD_STATUS');
  });
});

describe('P3 验收 6：不支持的格式明确报错', () => {
  it('.docx 返回 UNSUPPORTED_FORMAT 并留拒绝批次', () => {
    const r = pipeline.upload({
      batchId: 'B-DOCX',
      termId: TERM,
      fileName: '课表.docx',
      buffer: Buffer.from('PK\u0003\u0004fake'),
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
    });
    expect(r.status).toBe('REJECTED');
    if (r.status !== 'REJECTED') return;
    expect(r.code).toBe('UNSUPPORTED_FORMAT');
    expect(r.message).toContain('CSV');
    expect(db.getBatch('B-DOCX')?.status).toBe('REJECTED');
  });
});

describe('P3 验收 7：来源标记与模拟数据隔离', () => {
  it('存在模拟课表时拒绝导入', () => {
    service.load(DEMO_SNAPSHOT); // 带模拟模板
    service.build(TERM, '2026-08-31', '2026-12-31');

    const content = buf(CSV_ROWS);
    const r = pipeline.upload({
      batchId: 'B-SIM',
      termId: TERM,
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
      mapping: mappingOf(content),
    });
    expect(r.status).toBe('SIMULATED_REMAINS');
    expect(db.countBatches()).toBe(0);
  });

  it('显式清除模拟数据后才可导入，且清除范围仅限模拟数据', () => {
    service.load(DEMO_SNAPSHOT);
    service.build(TERM, '2026-08-31', '2026-12-31');
    const cleared = db.clearSimulated(TERM);
    expect(cleared.templates).toBeGreaterThan(0);
    expect(db.hasSimulated(TERM)).toBe(false);

    const content = buf(CSV_ROWS);
    const r = pipeline.upload({
      batchId: 'B1',
      termId: TERM,
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
      mapping: mappingOf(content),
    });
    expect(r.status).toBe('IMPORTED_NOT_PUBLISHED');
  });
});

describe('发布权限不内置任何角色', () => {
  it('未配置可发布角色时一律阻断', () => {
    stage('B1');
    const r = publish('B1', { authorizedRoles: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_CONFIGURED');
  });

  it('发布职责只允许配置给课务管理人员（S）', () => {
    stage('B1');
    const r = publish('B1', { authorizedRoles: ['A'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_CONFIGURED');
  });

  it('管理员即使被配置也不能发布', () => {
    stage('B1');
    const admin = mintPrincipal({
      userId: 'U-ADMIN',
      teacherId: null,
      displayName: '管理员',
      roles: ['A'],
      actingRole: 'A',
      sessionId: 'S-ADMIN',
      mustChangePassword: false,
    });
    const r = publish('B1', { principal: admin });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED');
  });

  it('没有书面依据编号时发布一律阻断', () => {
    stage('B1');
    const r = publish('B1', { basisDocumentId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_CONFIGURED');
    expect(db.activeTemplates(TERM)).toHaveLength(0);
  });
});

describe('覆盖发布必须显式确认', () => {
  it('已有排课时 REPLACE 未确认 → 阻断，数据不变', () => {
    stage('B1');
    publish('B1');
    const before = db.templateFingerprint(TERM);

    stage('B2', [
      '教师,班级,科目,星期,节次,单双周',
      '示例教师甲,虚构一年一班,语文,周一,1,',
    ]);
    const r = publish('B2', { mode: 'REPLACE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONFLICT_REQUIRES_ACK');
    expect(db.templateFingerprint(TERM)).toBe(before);
  });

  it('确认后 REPLACE 生效，旧模板打墓碑而非删除', () => {
    stage('B1');
    publish('B1');
    stage('B2', [
      '教师,班级,科目,星期,节次,单双周',
      '示例教师甲,虚构一年一班,语文,周一,1,',
    ]);
    const r = publish('B2', { mode: 'REPLACE', acknowledged: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff.added).toBe(0);
    expect(r.diff.unchanged).toBe(1);
    expect(r.diff.removed).toBe(3);
    expect(db.activeTemplates(TERM)).toHaveLength(1);
    expect(db.countTemplates(TERM)).toBe(5);
  });

  it('追加模式下与现有同班同时段冲突被拒绝', () => {
    stage('B1');
    publish('B1');
    // 同班同时段换成另一门课：不是重复行，但时段已被占用
    stage('B2', [
      '教师,班级,科目,星期,节次,单双周',
      '示例教师乙,虚构一年一班,数学,周一,1,',
    ]);
    const r = publish('B2', { mode: 'APPEND' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DUPLICATE_SLOT');
  });
});

describe('上传前置条件', () => {
  it('未提供映射时只返回建议，不落批次', () => {
    const content = buf(CSV_ROWS);
    const r = pipeline.upload({
      batchId: 'B1',
      termId: TERM,
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
    });
    expect(r.status).toBe('NEEDS_MAPPING');
    expect(db.countBatches()).toBe(0);
  });

  it('学期不存在时拒绝', () => {
    const content = buf(CSV_ROWS);
    const r = pipeline.upload({
      batchId: 'B1',
      termId: 'TERM-NOT-EXIST',
      fileName: '课表.csv',
      buffer: content,
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
      mapping: mappingOf(content),
    });
    expect(r.status).toBe('UNKNOWN_TERM');
  });

  it('空文件留下拒绝批次', () => {
    const r = pipeline.upload({
      batchId: 'B-EMPTY',
      termId: TERM,
      fileName: '课表.csv',
      buffer: Buffer.alloc(0),
      principal: CLERK,
      uploadedAt: '2026-08-20T09:00:00Z',
    });
    expect(r.status).toBe('REJECTED');
    expect(db.getBatch('B-EMPTY')?.status).toBe('REJECTED');
  });
});
