import { chainHash } from './hash.js';
import type { Engine, HistoryEvent, Principal, Template } from './types.js';

export interface Scenario {
  id: string;
  title: string;
  /** 对应需求来源 */
  source: string;
  run(e: Engine): void;
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
  }
}

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

const teacher = (id: string): Principal => ({ id, roles: ['TEACHER'], actingAs: null });
const admin = (id: string): Principal => ({ id, roles: ['ADMIN'], actingAs: null });

const BELL = { 1: '08:00', 2: '08:50', 3: '09:40', 4: '11:20' };

const TEMPLATES: Template[] = [
  { id: 'TPL-1', classId: 'CLASS-1', teacherId: 'TEACHER-001', subject: '语文', weekday: 1, period: 1, parity: 'ODD', rotation: 'NONE', endsAt: '08:40' },
  { id: 'TPL-2', classId: 'CLASS-2', teacherId: 'TEACHER-002', subject: '数学', weekday: 1, period: 2, parity: 'ODD', rotation: 'NONE', endsAt: '09:30' },
  { id: 'TPL-3', classId: 'CLASS-3', teacherId: 'TEACHER-003', subject: '英语', weekday: 1, period: 3, parity: 'ALL', rotation: 'NONE', endsAt: null },
  { id: 'TPL-4', classId: 'CLASS-4', teacherId: 'TEACHER-004', subject: '综合实践', weekday: 1, period: 4, parity: 'ALL', rotation: 'CUSTOM', endsAt: '11:40' },
];

const CAL = { termStartMonday: '2026-08-31', holidays: ['2026-10-01'] };

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: 'AC01',
    title: '导入文件未确认正式发布时，仅凭上传不得宣告学校正式生效',
    source: 'R05 AC01 / INV-05',
    run(e) {
      const r = e.importBatch({
        id: 'BATCH-1',
        origin: 'IMPORTED_UNVERIFIED',
        published: false,
        rows: [{ teacherExternalRef: 'E-001', classId: 'CLASS-1', date: '2026-08-31', period: 1, subject: '语文' }],
        conflictsWithEffectiveIds: [],
      });
      eq(r.outcome, 'IMPORTED_NOT_PUBLISHED', 'AC01 结果码');
      eq(r.official, false, 'AC01 不得标记为正式');
    },
  },
  {
    id: 'AC02',
    title: '课表无课但存在未同步课后服务时，不得表示"确定有空"',
    source: 'R05 AC02 / INV-11',
    run(e) {
      const r = e.availability({
        teacherId: 'TEACHER-001',
        date: '2026-09-07',
        period: 5,
        hasLesson: false,
        obligations: [{ type: 'AFTER_SCHOOL', certainty: 'UNKNOWN', source: 'FILING' }],
      });
      eq(r.outcome, 'UNKNOWN', 'AC02 结果码');
      eq(r.unverified.length, 1, 'AC02 必须列出未核实来源');
      eq(r.willingnessAssessed, false, 'AC02 不得评估意愿');
    },
  },
  {
    id: 'AC03',
    title: '教师已读但未答复代课请求，不表示同意',
    source: 'R05 AC03 / INV-01',
    run(e) {
      const r = e.substituteConsent({
        requestId: 'REQ-1',
        teacherId: 'TEACHER-002',
        delivery: 'DELIVERED',
        read: true,
        decision: null,
      });
      eq(r.outcome, 'PENDING_CONFIRMATION', 'AC03 结果码');
      eq(r.isAgreement, false, 'AC03 已读不构成同意');
      eq(r.effective, false, 'AC03 不构成正式责任变更');
    },
  },
  {
    id: 'AC04',
    title: '协调请求已发送但无人明确承接时，不表示已有协调责任人',
    source: 'R05 AC04 / INV-02',
    run(e) {
      const r = e.coordinationOwner([
        { type: 'REQUEST_SENT', actorId: 'TEACHER-001', at: '2026-09-07T07:00:00+08:00' },
      ]);
      eq(r.outcome, 'NO_OWNER', 'AC04 结果码');
      eq(r.ownerId, null, 'AC04 不得推定负责人');
    },
  },
  {
    id: 'AC05',
    title: '教师转述他人同意但无可核验本人依据时，不替其生成确认',
    source: 'R05 AC05 / INV-03',
    run(e) {
      const r = e.thirdPartyClaim({
        claimedBy: 'TEACHER-001',
        aboutTeacherId: 'TEACHER-002',
        basis: 'NONE',
        claimerIsAuthorizedRecorder: false,
      });
      eq(r.outcome, 'REJECTED', 'AC05 结果码');
      eq(r.generatesConfirmation, false, 'AC05 不得生成本人确认');
    },
  },
  {
    id: 'AC06',
    title: '方案变更后，针对旧版本的确认不得沿用',
    source: 'R05 AC06 / INV-01',
    run(e) {
      const r = e.confirmationState({
        proposalId: 'CASE-1',
        proposalRevision: 3,
        required: ['TEACHER-001', 'TEACHER-002'],
        confirmations: [
          { teacherId: 'TEACHER-001', proposalRevision: 2, decision: 'ACCEPT' },
          { teacherId: 'TEACHER-002', proposalRevision: 2, decision: 'ACCEPT' },
        ],
      });
      eq(r.outcome, 'STALE_CONFIRMATION', 'AC06 结果码');
      eq(r.stale.length, 2, 'AC06 旧版本确认应全部标为失效');
      eq(r.missing.length, 2, 'AC06 当前版本仍需重新确认');
    },
  },
  {
    id: 'AC07',
    title: '纠正误写节次与新授课责任变更必须区分',
    source: 'R05 AC07 / INV-10',
    run(e) {
      const factual = e.classifyCorrection({ changeId: 'CORR-1', responsibilityChanged: false, field: 'period' });
      eq(factual.outcome, 'FACTUAL_CORRECTION', 'AC07 资料性纠错');
      eq(factual.requiresNewProposal, false, 'AC07 不要求新方案');
      eq(factual.whitelistStatus, 'NOT_CONFIGURED', 'AC07 白名单未定，不得自动放行');

      const resp = e.classifyCorrection({ changeId: 'CORR-2', responsibilityChanged: true, field: 'teacher' });
      eq(resp.outcome, 'REQUIRES_NEW_PROPOSAL', 'AC07 责任变化必须走新方案');
      eq(resp.requiresNewProposal, true, 'AC07 责任变化需重新确认');
    },
  },
  {
    id: 'AC08',
    title: '再导入新课表与已生效临时调整冲突时，显示冲突而不静默覆盖',
    source: 'R05 AC08 / INV-14',
    run(e) {
      const r = e.importBatch({
        id: 'BATCH-2',
        origin: 'IMPORTED_UNVERIFIED',
        published: true,
        rows: [],
        conflictsWithEffectiveIds: ['OCC-9'],
      });
      eq(r.outcome, 'CONFLICT', 'AC08 结果码');
      eq(r.overwritten, false, 'AC08 不得覆盖');
      eq(r.conflictQueue.length, 1, 'AC08 必须进入冲突队列');
    },
  },
  {
    id: 'AC09',
    title: '轮换课不得无依据按奇偶周或实际次数推算',
    source: 'R05 AC09 / BIZ-06',
    run(e) {
      const r = e.rotation({ occurrenceId: 'OCC-4', declaredRule: null });
      eq(r.outcome, 'UNKNOWN_ROTATION', 'AC09 结果码');
      eq(r.computed, false, 'AC09 不得推算');
    },
  },
  {
    id: 'AC10',
    title: '代课已安排但未实际执行时，不得标记完成或可计发',
    source: 'R05 AC10 / INV-02',
    run(e) {
      const r = e.execution({
        occurrenceId: 'OCC-10',
        scheduled: true,
        executedRegistered: false,
        executedRegisteredBy: null,
      });
      eq(r.outcome, 'NOT_EXECUTED', 'AC10 结果码');
      eq(r.settlementEligible, false, 'AC10 不得可结算');
    },
  },
  {
    id: 'AC11',
    title: '校内代理人代录校外求助时，不冒充接课教师本人确认',
    source: 'R05 AC11 / INV-03',
    run(e) {
      const r = e.proxyRecord({
        occurrenceId: 'OCC-11',
        recordedBy: 'REGISTRAR-1',
        recordedForTeacherId: 'TEACHER-005',
        teacherConfirmed: false,
      });
      eq(r.outcome, 'PENDING_TEACHER_CONFIRMATION', 'AC11 结果码');
      eq(r.countsAsTeacherConfirmation, false, 'AC11 不得计入本人确认');
    },
  },
  {
    id: 'AC12',
    title: '校外网络尝试直接访问业务服务应被拒绝',
    source: 'R05 AC12 / INV-13',
    run(e) {
      const r = e.access({ fromExternal: true }, teacher('TEACHER-001'));
      eq(r.outcome, 'DENIED_EXTERNAL', 'AC12 结果码');
    },
  },
  {
    id: 'AC13',
    title: '只有课后服务备案表而教师临时互换未备案时，不得声称等于当天实际',
    source: 'R05 AC13',
    run(e) {
      const r = e.afterSchool({ filingExists: true, actualKnown: false });
      eq(r.outcome, 'UNKNOWN_ACTUAL', 'AC13 结果码');
      eq(r.treatFilingAsActual, false, 'AC13 不得把备案当实际');
    },
  },
  {
    id: 'AC14',
    title: '变更与纠错后仍可追溯原始依据、变化事实、操作者与时间',
    source: 'R05 AC14',
    run(e) {
      const e1: HistoryEvent = { id: 'EV-1', type: 'ORIGINAL', at: '2026-09-01T08:00:00Z', actorId: 'SCHEDULER-1', prevHash: 'GENESIS', payload: '第3节 语文 张一' };
      const e2: HistoryEvent = { id: 'EV-2', type: 'CORRECTION', at: '2026-09-02T09:00:00Z', actorId: 'SCHEDULER-1', prevHash: chainHash('GENESIS', e1), payload: '第3节→第4节（笔误）' };
      const e3: HistoryEvent = { id: 'EV-3', type: 'CHANGE', at: '2026-09-03T10:00:00Z', actorId: 'TEACHER-001', prevHash: chainHash(e2.prevHash, e2), payload: '第4节 张一→李一' };
      const r = e.history([e1, e2, e3], []);
      eq(r.entries.length, 3, 'AC14 不得抹除历史');
      eq(r.chainValid, true, 'AC14 审计链必须完整');
      eq(r.erased.length, 0, 'AC14 无抹除记录');
    },
  },

  /* ---------------- V2.3 必测场景（可自动化的部分） ---------------- */

  {
    id: 'V23-01',
    title: '同名教师不同 ID、单双周与跨班任教不得错误匹配',
    source: 'V2.3 必测 1',
    run(e) {
      const pair = [TEMPLATES[0]!, TEMPLATES[1]!];
      const odd = e.generateOccurrences(pair, CAL, '2026-08-31', BELL);
      eq(odd.occurrences.length, 2, 'V23-01 单周应命中两节');
      const ids = odd.occurrences.map((o) => o.teacherId);
      ok(ids.includes('TEACHER-001') && ids.includes('TEACHER-002'), 'V23-01 两个 ID 必须独立出现');
      ok(!ids.includes('TEACHER-003'), 'V23-01 不得按姓名合并');

      const even = e.generateOccurrences(pair, CAL, '2026-09-07', BELL);
      eq(even.occurrences.length, 0, 'V23-01 双周不应命中单周课');
    },
  },
  {
    id: 'V23-02',
    title: '缺少结束时间时保持不确定，不推断结束时间',
    source: 'V2.3 必测 2',
    run(e) {
      const r = e.generateOccurrences([TEMPLATES[2]!], CAL, '2026-08-31', BELL);
      const occ = r.occurrences[0];
      ok(Boolean(occ), 'V23-02 应生成课次');
      eq(occ!.endsAt, null, 'V23-02 结束时间必须为空');
      eq(occ!.certainty, 'UNKNOWN', 'V23-02 必须标记不确定');
    },
  },
  {
    id: 'V23-03',
    title: '多人互换时必要确认者由受影响集合计算，班主任仅通知',
    source: 'V2.3 必测 3 / INV-07',
    run(e) {
      const r = e.requiredConfirmers(
        {
          id: 'CASE-3',
          revision: 1,
          moves: [
            { occurrenceId: 'OCC-A', fromTeacherId: 'TEACHER-001', toTeacherId: 'TEACHER-002', classId: 'CLASS-1' },
            { occurrenceId: 'OCC-B', fromTeacherId: 'TEACHER-002', toTeacherId: 'TEACHER-003', classId: 'CLASS-2' },
            { occurrenceId: 'OCC-C', fromTeacherId: 'TEACHER-003', toTeacherId: 'TEACHER-001', classId: 'CLASS-3' },
          ],
        },
        { 'CLASS-1': 'HEAD-1', 'CLASS-2': 'HEAD-2', 'CLASS-3': 'HEAD-3' },
      );
      eq(r.required, ['TEACHER-001', 'TEACHER-002', 'TEACHER-003'], 'V23-03 必要确认者');
      eq(r.notified, ['HEAD-1', 'HEAD-2', 'HEAD-3'], 'V23-03 班主任仅通知');
      ok(!r.required.includes('HEAD-1'), 'V23-03 班主任不得自动成为确认者');
    },
  },
  {
    id: 'V23-04',
    title: '任一人拒绝时方案不得生效',
    source: 'V2.3 必测 4',
    run(e) {
      const r = e.confirmationState({
        proposalId: 'CASE-4',
        proposalRevision: 1,
        required: ['TEACHER-001', 'TEACHER-002'],
        confirmations: [
          { teacherId: 'TEACHER-001', proposalRevision: 1, decision: 'ACCEPT' },
          { teacherId: 'TEACHER-002', proposalRevision: 1, decision: 'DECLINE' },
        ],
      });
      eq(r.outcome, 'DECLINED', 'V23-04 结果码');
    },
  },
  {
    id: 'V23-05',
    title: '恢复方案不得改写已执行课次',
    source: 'V2.3 必测 5 / INV-06',
    run(e) {
      const r = e.applyChange({
        changeId: 'RECOVERY-1',
        idempotencyKey: 'KEY-5',
        targetOccurrenceIds: ['OCC-1', 'OCC-2'],
        executedOccurrenceIds: ['OCC-1'],
        alreadyAppliedKeys: [],
      });
      eq(r.appliedOccurrenceIds, ['OCC-2'], 'V23-05 仅未执行课次可恢复');
      eq(r.skippedExecuted, ['OCC-1'], 'V23-05 已执行课次必须跳过');
    },
  },
  {
    id: 'V23-06',
    title: '管理员纠错若改变授课责任则被挡住',
    source: 'V2.3 必测 6 / INV-10',
    run(e) {
      const r = e.classifyCorrection({ changeId: 'CORR-6', responsibilityChanged: true, field: 'teacher' });
      eq(r.requiresNewProposal, true, 'V23-06 必须走必要教师确认');
    },
  },
  {
    id: 'V23-09',
    title: '主责明确无法处理时立即升级，且不产生授课确认',
    source: 'V2.3 必测 9',
    run(e) {
      const r = e.escalate([{ type: 'PRIMARY_DECLINED', at: '2026-09-07T07:30:00+08:00' }]);
      eq(r.outcome, 'IMMEDIATE_ESCALATION', 'V23-09 结果码');
      eq(r.target, 'DEPUTY', 'V23-09 升级至当日代理');
      eq(r.generatesTeachingConfirmation, false, 'V23-09 不得产生授课确认');
    },
  },
  {
    id: 'V23-10',
    title: '口头与在线接单冲突时保留来源并标为待裁定',
    source: 'V2.3 必测 10 / O2-1',
    run(e) {
      const r = e.coordinationOwner([
        { type: 'ACCEPT_ORAL', actorId: 'COORD-1', at: '2026-09-07T12:51:00+08:00', recordedAt: '2026-09-07T12:54:00+08:00' },
        { type: 'ACCEPT_ONLINE', actorId: 'COORD-2', at: '2026-09-07T12:52:00+08:00' },
      ]);
      eq(r.outcome, 'AMBIGUOUS', 'V23-10 结果码');
      eq(r.requiresAdjudication, true, 'V23-10 必须待裁定');
      eq(r.ownerId, null, 'V23-10 不得自动指定负责人');
      eq(r.sources.length, 2, 'V23-10 必须保留两方来源');
    },
  },
  {
    id: 'V23-11',
    title: '协调结案与授课事实核验分离',
    source: 'V2.3 必测 11 / INV-04',
    run(e) {
      const r = e.closeCase({
        caseId: 'CASE-11',
        submittedBy: 'COORD-1',
        approvedBy: 'REGISTRAR-1',
        teachingVerified: false,
      });
      eq(r.caseClosed, true, 'V23-11 结案可完成');
      eq(r.teachingStillPending, true, 'V23-11 授课事实仍待核验');
    },
  },
  {
    id: 'V23-12',
    title: '重复提交同一请求不产生重复生效',
    source: 'V2.3 必测 12 / INV-14',
    run(e) {
      const first = e.applyChange({
        changeId: 'CHANGE-12',
        idempotencyKey: 'KEY-12',
        targetOccurrenceIds: ['OCC-12'],
        executedOccurrenceIds: [],
        alreadyAppliedKeys: [],
      });
      eq(first.applied, true, 'V23-12 首次应生效');
      const second = e.applyChange({
        changeId: 'CHANGE-12',
        idempotencyKey: 'KEY-12',
        targetOccurrenceIds: ['OCC-12'],
        executedOccurrenceIds: [],
        alreadyAppliedKeys: ['KEY-12'],
      });
      eq(second.duplicate, true, 'V23-12 重试应识别为重复');
      eq(second.applied, false, 'V23-12 不得重复生效');
    },
  },
  {
    id: 'V23-13',
    title: '普通教师不能查看他人私人理由、代为确认或下载备份',
    source: 'V2.3 必测 13 / INV-08 / INV-12',
    run(e) {
      const t = teacher('TEACHER-001');
      eq(e.authorize(t, 'READ', { kind: 'PRIVATE_REASON', ownerTeacherId: 'TEACHER-002' }).allowed, false, 'V23-13 私人理由');
      eq(e.authorize(t, 'CONFIRM', { kind: 'CONFIRMATION', ownerTeacherId: 'TEACHER-002' }).allowed, false, 'V23-13 代确认');
      eq(e.authorize(t, 'DOWNLOAD_BACKUP', { kind: 'BACKUP' }).allowed, false, 'V23-13 下载备份');
      eq(e.authorize(t, 'CONFIRM', { kind: 'CONFIRMATION', ownerTeacherId: 'TEACHER-001' }).allowed, true, 'V23-13 本人确认应允许');
      eq(e.authorize(admin('ADMIN-1'), 'CONFIRM', { kind: 'CONFIRMATION', ownerTeacherId: 'TEACHER-002' }).allowed, false, 'V23-13 管理员不得代确认');
    },
  },
]);
