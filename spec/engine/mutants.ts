import type { Engine } from '../types.js';
import { referenceEngine } from './reference.js';

export interface Mutant {
  name: string;
  violates: string;
  /** 该变异体必须被这条场景捕获 */
  expectedFailure: string;
  engine: Engine;
}

const base = referenceEngine;

/**
 * 变异体：每个都故意违反一条 L0 不变量。
 * 若元测试无法让它们失败，说明反例测试没有判别力。
 */
export const MUTANTS: readonly Mutant[] = Object.freeze([
  {
    name: 'silence-as-consent',
    violates: 'INV-01 沉默≠同意',
    expectedFailure: 'AC03',
    engine: {
      ...base,
      substituteConsent(r) {
        if (r.decision === 'DECLINE') return { outcome: 'DECLINED', isAgreement: false, effective: false };
        return { outcome: 'ACCEPTED', isAgreement: true, effective: false };
      },
    },
  },
  {
    name: 'empty-means-available',
    violates: 'INV-11 无占用记录≠有空',
    expectedFailure: 'AC02',
    engine: {
      ...base,
      availability(q) {
        if (q.hasLesson) return { outcome: 'OCCUPIED', unverified: [], willingnessAssessed: false };
        return { outcome: 'AVAILABLE', unverified: [], willingnessAssessed: false };
      },
    },
  },
  {
    name: 'third-party-records-consent',
    violates: 'INV-03 他人不能代为确认',
    expectedFailure: 'AC05',
    engine: {
      ...base,
      thirdPartyClaim() {
        return { outcome: 'RECORDED_PENDING', generatesConfirmation: false, reason: 'CLAIM_ACCEPTED' };
      },
    },
  },
  {
    name: 'stale-confirmation-reuse',
    violates: 'INV-01 旧版本确认不可沿用',
    expectedFailure: 'AC06',
    engine: {
      ...base,
      confirmationState(cs) {
        const accepted = cs.confirmations.filter((c) => c.decision === 'ACCEPT').map((c) => c.teacherId);
        const missing = cs.required.filter((t) => !accepted.includes(t));
        return missing.length === 0
          ? { outcome: 'READY_TO_APPLY', missing: [], stale: [] }
          : { outcome: 'PENDING_CONFIRMATION', missing, stale: [] };
      },
    },
  },
  {
    name: 'publish-on-upload',
    violates: 'INV-05 导入≠正式发布',
    expectedFailure: 'AC01',
    engine: {
      ...base,
      importBatch(b) {
        if (b.conflictsWithEffectiveIds.length > 0) {
          return { outcome: 'CONFLICT', official: false, overwritten: false, conflictQueue: [...b.conflictsWithEffectiveIds] };
        }
        return { outcome: 'ACCEPTED', official: true, overwritten: false, conflictQueue: [] };
      },
    },
  },
  {
    name: 'silent-overwrite',
    violates: 'INV-14 不得静默覆盖已生效事实',
    expectedFailure: 'AC08',
    engine: {
      ...base,
      importBatch() {
        return { outcome: 'ACCEPTED', official: true, overwritten: true, conflictQueue: [] };
      },
    },
  },
  {
    name: 'rotation-guess',
    violates: 'BIZ-06 不得推算轮换',
    expectedFailure: 'AC09',
    engine: {
      ...base,
      rotation() {
        return { outcome: 'COMPUTED', computed: true, reason: 'ASSUMED_PARITY' };
      },
    },
  },
  {
    name: 'scheduled-as-executed',
    violates: 'INV-02 已安排≠已执行',
    expectedFailure: 'AC10',
    engine: {
      ...base,
      execution(r) {
        return r.scheduled
          ? { outcome: 'EXECUTED', settlementEligible: false }
          : { outcome: 'NOT_EXECUTED', settlementEligible: false };
      },
    },
  },
  {
    name: 'proxy-counts-as-confirmation',
    violates: 'INV-03 代录≠本人确认',
    expectedFailure: 'AC11',
    engine: {
      ...base,
      proxyRecord() {
        return { outcome: 'CONFIRMED_BY_TEACHER', teacherConfirmed: true, countsAsTeacherConfirmation: true };
      },
    },
  },
  {
    name: 'external-access-allowed',
    violates: 'INV-13 校外不得直连',
    expectedFailure: 'AC12',
    engine: {
      ...base,
      access() {
        return { outcome: 'ALLOWED' };
      },
    },
  },
  {
    name: 'filing-as-actual',
    violates: 'AC13 备案≠当天实际',
    expectedFailure: 'AC13',
    engine: {
      ...base,
      afterSchool() {
        return { outcome: 'KNOWN_FILING', treatFilingAsActual: true };
      },
    },
  },
  {
    name: 'history-erasure',
    violates: 'AC14 历史可追溯、不抹除',
    expectedFailure: 'AC14',
    engine: {
      ...base,
      history(events) {
        return { appendOnly: true, entries: events.slice(-1), chainValid: true, erased: [] };
      },
    },
  },
  {
    name: 'self-approval',
    violates: 'V2.3-11 提交与批准分开',
    expectedFailure: 'V23-11',
    engine: {
      ...base,
      closeCase(c) {
        return { outcome: 'CLOSED', teachingStillPending: false, caseClosed: true };
      },
    },
  },
  {
    name: 'admin-may-confirm',
    violates: 'INV-08 管理员不代确认',
    expectedFailure: 'V23-13',
    engine: {
      ...base,
      authorize(p, action, res) {
        if (!p) return { allowed: false, reason: 'UNAUTHENTICATED' };
        if (action === 'CONFIRM') return { allowed: true, reason: 'ADMIN_OVERRIDE' };
        return base.authorize(p, action, res);
      },
    },
  },
  {
    name: 'duplicate-apply',
    violates: 'V2.3-12 重试不得重复生效',
    expectedFailure: 'V23-12',
    engine: {
      ...base,
      applyChange(r) {
        return {
          applied: true,
          duplicate: false,
          appliedOccurrenceIds: r.targetOccurrenceIds,
          skippedExecuted: [],
        };
      },
    },
  },
]);
