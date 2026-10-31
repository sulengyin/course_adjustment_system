import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_L1_TOKENS,
  L0_INVARIANTS,
  L1_PARAMS,
  L2_POLICIES,
  enablePolicy,
  resolveL1,
} from './config/schema.js';
import { referenceEngine } from './engine/reference.js';

const l1Keys = L1_PARAMS.map((p) => p.key);
const l2Keys = L2_POLICIES.map((p) => p.key);

describe('V9 配置边界', () => {
  it('L0 硬不变量不得作为配置项出现', () => {
    const all = [...l1Keys, ...l2Keys];
    for (const inv of L0_INVARIANTS) {
      expect(all).not.toContain(inv.id);
    }
    expect(L0_INVARIANTS.length).toBe(14);
  });

  it('L1 每项默认值必须为空', () => {
    for (const p of L1_PARAMS) {
      expect(p.defaultValue, p.key).toBeNull();
      expect(p.blockedWhenUnset, p.key).toBe(true);
    }
  });

  it('L1 键名不得出现制度性语义词', () => {
    for (const key of l1Keys) {
      const lower = key.toLowerCase();
      for (const token of FORBIDDEN_L1_TOKENS) {
        expect(lower.includes(token.toLowerCase()), `${key} 含违禁词 ${token}`).toBe(false);
      }
    }
  });

  it('L2 必须默认关闭且要求书面依据', () => {
    for (const p of L2_POLICIES) {
      expect(p.defaultEnabled, p.key).toBe(false);
      expect(p.requiresBasisDocument, p.key).toBe(true);
      expect(p.relatedOpenItem.length, p.key).toBeGreaterThan(0);
    }
  });

  it('不得存在“个人偏好影响业务判定”的键', () => {
    const all = [...l1Keys, ...l2Keys].join(' ').toLowerCase();
    for (const bad of ['personal', 'preference', 'allowother', 'selfconsent', 'defaultbusy']) {
      expect(all.includes(bad), `出现可疑键 ${bad}`).toBe(false);
    }
  });
});

describe('CFG 未配置 / 未开启时的显式行为', () => {
  it('CFG-01 L1 未配置返回 NOT_CONFIGURED，不回退内置值', () => {
    const r = resolveL1('bell.schedule', {});
    expect(r.configured).toBe(false);
    if (!r.configured) expect(r.code).toBe('NOT_CONFIGURED');

    const set = resolveL1('bell.schedule', { 'bell.schedule': { 1: '08:00' } });
    expect(set.configured).toBe(true);
  });

  it('CFG-02 占用未核实不得判为可用', () => {
    const r = referenceEngine.availability({
      teacherId: 'TEACHER-009',
      date: '2026-09-07',
      period: 6,
      hasLesson: false,
      obligations: [{ type: 'DUTY', certainty: 'UNKNOWN', source: 'MANUAL' }],
    });
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.unverified).toHaveLength(1);
  });

  it('CFG-03 L2 未开启时轮换能力不可用', () => {
    expect(referenceEngine.rotation({ occurrenceId: 'OCC-X', declaredRule: null }).outcome)
      .toBe('UNKNOWN_ROTATION');
  });

  it('CFG-04 无书面依据不得开启 L2', () => {
    const r = enablePolicy('policy.dispute.adjudication', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BASIS_REQUIRED');

    const partial = enablePolicy('policy.dispute.adjudication', { documentNo: 'DOC-1' });
    expect(partial.ok).toBe(false);
  });

  it('L0 不可通过配置开启', () => {
    const r = enablePolicy('INV-01', {
      documentNo: 'DOC-1',
      basisType: 'POLICY',
      approver: 'PRINCIPAL',
      effectiveFrom: '2026-11-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('L0_NOT_CONFIGURABLE');
  });

  it('未知键不得被当作策略开启', () => {
    const r = enablePolicy('policy.unknown', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_KEY');
  });

  it('CFG-09 开启 L2 不解除任何 L0（轮换仍需显式依据）', () => {
    const r = enablePolicy('policy.rotation.computeRule', {
      documentNo: 'DOC-9',
      basisType: 'MINUTES',
      approver: 'ACADEMIC-OFFICE',
      effectiveFrom: '2026-11-01',
    });
    expect(r.ok).toBe(true);
    // 引擎不读取该开关即产生推算值：即便策略开启，未提供明确规则时仍不得推算
    expect(referenceEngine.rotation({ occurrenceId: 'OCC-Y', declaredRule: null }).computed).toBe(false);
  });

  it('CFG-07 模拟数据永远不得标记为正式', () => {
    const r = referenceEngine.importBatch({
      id: 'BATCH-SIM',
      origin: 'SIMULATED',
      published: true,
      rows: [],
      conflictsWithEffectiveIds: [],
    });
    expect(r.official).toBe(false);
    expect(r.outcome).toBe('IMPORTED_NOT_PUBLISHED');
  });
});
