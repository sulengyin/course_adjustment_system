import { chainHash } from '../hash.js';
import type {
  AccessOutcome,
  AfterSchoolFact,
  AfterSchoolOutcome,
  ApplyOutcome,
  ApplyRequest,
  AuthorizationOutcome,
  AvailabilityOutcome,
  AvailabilityQuery,
  Calendar,
  ChangeProposal,
  ClaimOutcome,
  Closure,
  ClosureOutcome,
  ConfirmationOutcome,
  ConfirmationSet,
  ConfirmerSet,
  ConsentOutcome,
  CoordinationEvent,
  Correction,
  CorrectionOutcome,
  Engine,
  EscalationEvent,
  EscalationOutcome,
  ExecutionOutcome,
  ExecutionRecord,
  HistoryEvent,
  HistoryOutcome,
  ImportBatch,
  ImportOutcome,
  NetworkContext,
  OccurrenceResult,
  OwnerOutcome,
  Principal,
  ProxyOutcome,
  ProxyRecord,
  ResourceRef,
  RotationOutcome,
  RotationSession,
  SubstituteResponse,
  Template,
  ThirdPartyClaim,
} from '../types.js';

/**
 * 参考判定引擎：只实现 V2.3 / R05 已确认的事实关系。
 * 所有未决事项返回显式的"未配置/待核验/待裁定"，不产生业务默认值。
 */
export const referenceEngine: Engine = {
  importBatch(batch: ImportBatch): ImportOutcome {
    // 冲突优先：即使已发布，与生效变更重叠也不得覆盖
    if (batch.conflictsWithEffectiveIds.length > 0) {
      return {
        outcome: 'CONFLICT',
        official: false,
        overwritten: false,
        conflictQueue: [...batch.conflictsWithEffectiveIds],
      };
    }
    if (batch.origin === 'SIMULATED') {
      // 模拟数据永远不得成为学校正式数据
      return { outcome: 'IMPORTED_NOT_PUBLISHED', official: false, overwritten: false, conflictQueue: [] };
    }
    if (!batch.published) {
      // INV-05：上传不等于学校正式发布
      return { outcome: 'IMPORTED_NOT_PUBLISHED', official: false, overwritten: false, conflictQueue: [] };
    }
    return { outcome: 'ACCEPTED', official: true, overwritten: false, conflictQueue: [] };
  },

  availability(q: AvailabilityQuery): AvailabilityOutcome {
    const unverified = q.obligations
      .filter((o) => o.certainty === 'UNKNOWN')
      .map((o) => `${o.type}:${o.source}`);
    if (q.hasLesson) {
      return { outcome: 'OCCUPIED', unverified, willingnessAssessed: false };
    }
    if (q.obligations.some((o) => o.certainty === 'KNOWN')) {
      return { outcome: 'OCCUPIED', unverified, willingnessAssessed: false };
    }
    if (unverified.length > 0) {
      // INV-11：无课不等于确定有空
      return { outcome: 'UNKNOWN', unverified, willingnessAssessed: false };
    }
    return { outcome: 'AVAILABLE', unverified, willingnessAssessed: false };
  },

  substituteConsent(r: SubstituteResponse): ConsentOutcome {
    // INV-01：已读/送达/沉默都不是同意
    if (r.decision === 'ACCEPT') {
      return { outcome: 'ACCEPTED', isAgreement: true, effective: false };
    }
    if (r.decision === 'DECLINE') {
      return { outcome: 'DECLINED', isAgreement: false, effective: false };
    }
    return { outcome: 'PENDING_CONFIRMATION', isAgreement: false, effective: false };
  },

  coordinationOwner(events: CoordinationEvent[]): OwnerOutcome {
    const accepts = events.filter((e) => e.type === 'ACCEPT_ONLINE' || e.type === 'ACCEPT_ORAL');
    if (accepts.length === 0) {
      // INV-02：请求送达不等于有人承接
      return { outcome: 'NO_OWNER', ownerId: null, requiresAdjudication: false, sources: [] };
    }
    const actors = [...new Set(accepts.map((a) => a.actorId))];
    const kinds = [...new Set(accepts.map((a) => a.type))];
    if (actors.length > 1) {
      // O2-1 未关闭：口头与在线先后冲突不得自动裁定
      return {
        outcome: 'AMBIGUOUS',
        ownerId: null,
        requiresAdjudication: true,
        sources: accepts.map((a) => `${a.type}@${a.at}${a.recordedAt ? `(rec:${a.recordedAt})` : ''}`),
      };
    }
    if (kinds.length > 1) {
      return {
        outcome: 'AMBIGUOUS',
        ownerId: null,
        requiresAdjudication: true,
        sources: accepts.map((a) => `${a.type}@${a.at}`),
      };
    }
    return {
      outcome: 'OWNER',
      ownerId: actors[0] ?? null,
      requiresAdjudication: false,
      sources: accepts.map((a) => `${a.type}@${a.at}`),
    };
  },

  thirdPartyClaim(c: ThirdPartyClaim): ClaimOutcome {
    // INV-03：任何人（含授权人员）都不能替他人生成"本人确认"
    if (c.basis === 'NONE') {
      return { outcome: 'REJECTED', generatesConfirmation: false, reason: 'NO_VERIFIABLE_EVIDENCE' };
    }
    if (c.basis === 'ORAL_BY_AUTHORIZED' && !c.claimerIsAuthorizedRecorder) {
      return { outcome: 'REJECTED', generatesConfirmation: false, reason: 'NOT_AUTHORIZED_RECORDER' };
    }
    return {
      outcome: 'RECORDED_PENDING',
      generatesConfirmation: false,
      reason: 'AWAITING_TEACHER_SELF_CONFIRMATION',
    };
  },

  confirmationState(cs: ConfirmationSet): ConfirmationOutcome {
    const current = cs.confirmations.filter((c) => c.proposalRevision === cs.proposalRevision);
    const stale = cs.confirmations
      .filter((c) => c.proposalRevision !== cs.proposalRevision)
      .map((c) => c.teacherId);
    const missing = cs.required.filter(
      (t) => !current.some((c) => c.teacherId === t && c.decision === 'ACCEPT'),
    );
    if (current.some((c) => c.decision === 'DECLINE')) {
      return { outcome: 'DECLINED', missing, stale };
    }
    if (stale.length > 0) {
      // INV-01/AC06：旧版本的同意不可沿用到变更后的方案
      return { outcome: 'STALE_CONFIRMATION', missing, stale };
    }
    if (missing.length > 0) {
      return { outcome: 'PENDING_CONFIRMATION', missing, stale };
    }
    return { outcome: 'READY_TO_APPLY', missing: [], stale };
  },

  classifyCorrection(c: Correction): CorrectionOutcome {
    if (c.responsibilityChanged) {
      // INV-10：借纠错改责任
      return { outcome: 'REQUIRES_NEW_PROPOSAL', requiresNewProposal: true, whitelistStatus: 'NOT_CONFIGURED' };
    }
    return {
      outcome: 'FACTUAL_CORRECTION',
      requiresNewProposal: false,
      // BIZ-01 未定：识别为资料性纠错，但能否放行仍取决于白名单
      whitelistStatus: 'NOT_CONFIGURED',
    };
  },

  rotation(_s: RotationSession): RotationOutcome {
    // BIZ-06 未定：不按奇偶周或实际次数推算
    return { outcome: 'UNKNOWN_ROTATION', computed: false, reason: 'ROTATION_RULE_NOT_CONFIGURED' };
  },

  execution(r: ExecutionRecord): ExecutionOutcome {
    if (r.executedRegistered && r.executedRegisteredBy) {
      return { outcome: 'EXECUTED', settlementEligible: false };
    }
    // AC10：已安排不等于已执行；首版不自动判定执行
    return { outcome: 'NOT_EXECUTED', settlementEligible: false };
  },

  proxyRecord(r: ProxyRecord): ProxyOutcome {
    if (r.teacherConfirmed) {
      return { outcome: 'CONFIRMED_BY_TEACHER', teacherConfirmed: true, countsAsTeacherConfirmation: true };
    }
    // AC11：代录不代确认
    return {
      outcome: 'PENDING_TEACHER_CONFIRMATION',
      teacherConfirmed: false,
      countsAsTeacherConfirmation: false,
    };
  },

  access(net: NetworkContext, _p: Principal | null): AccessOutcome {
    // INV-13：首版纯校内
    if (net.fromExternal) {
      return { outcome: 'DENIED_EXTERNAL' };
    }
    return { outcome: 'ALLOWED' };
  },

  afterSchool(f: AfterSchoolFact): AfterSchoolOutcome {
    if (f.actualKnown) {
      return { outcome: 'KNOWN_FILING', treatFilingAsActual: false };
    }
    // AC13：备案内容不等于当天实际占用
    return { outcome: 'UNKNOWN_ACTUAL', treatFilingAsActual: false };
  },

  history(events: HistoryEvent[], erased: string[]): HistoryOutcome {
    let prev = 'GENESIS';
    let valid = true;
    for (const ev of events) {
      if (ev.prevHash !== prev) valid = false;
      prev = chainHash(ev.prevHash, ev);
    }
    return {
      appendOnly: true,
      // 保留全部事件，不因纠错/变更而删除
      entries: [...events],
      chainValid: valid && erased.length === 0,
      erased: [...erased],
    };
  },

  generateOccurrences(
    templates: Template[],
    cal: Calendar,
    date: string,
    bell: Record<number, string>,
  ): OccurrenceResult {
    const d = new Date(`${date}T00:00:00Z`);
    const weekday = d.getUTCDay();
    if (weekday < 1 || weekday > 5) {
      return { outcome: 'OK', occurrences: [], rotationUnknown: [] };
    }
    if (cal.holidays.includes(date)) {
      return { outcome: 'OK', occurrences: [], rotationUnknown: [] };
    }
    const termStart = new Date(`${cal.termStartMonday}T00:00:00Z`);
    const weekIndex = Math.floor((d.getTime() - termStart.getTime()) / (7 * 24 * 3600 * 1000));
    const parity: 'ODD' | 'EVEN' = weekIndex % 2 === 0 ? 'ODD' : 'EVEN';

    const rows: OccurrenceResult['occurrences'] = [];
    const rotationUnknown: string[] = [];

    for (const t of templates) {
      if (t.weekday !== weekday) continue;
      if (t.parity !== 'ALL' && t.parity !== parity) continue;
      if (t.rotation === 'CUSTOM') {
        rotationUnknown.push(t.id);
        continue;
      }
      const startsAt = bell[t.period] ?? null;
      // 缺结束时间即不确定，不推断
      const certainty = t.endsAt === null || startsAt === null ? 'UNKNOWN' : 'KNOWN';
      rows.push({
        templateId: t.id,
        classId: t.classId,
        teacherId: t.teacherId,
        date,
        period: t.period,
        startsAt,
        endsAt: t.endsAt,
        certainty,
      });
    }
    return {
      outcome: rotationUnknown.length > 0 ? 'UNKNOWN_ROTATION' : 'OK',
      occurrences: rows,
      rotationUnknown,
    };
  },

  requiredConfirmers(p: ChangeProposal, classHeadByClass: Record<string, string>): ConfirmerSet {
    const affected = new Set<string>();
    for (const m of p.moves) {
      if (m.fromTeacherId !== m.toTeacherId) {
        affected.add(m.fromTeacherId);
        affected.add(m.toTeacherId);
      }
    }
    // INV-07：由受影响集合计算；班主任只在被通知之列
    const notified = [...new Set(
      p.moves.map((m) => classHeadByClass[m.classId]).filter((x): x is string => Boolean(x)),
    )];
    return { required: [...affected].sort(), notified: notified.sort() };
  },

  applyChange(r: ApplyRequest): ApplyOutcome {
    if (r.alreadyAppliedKeys.includes(r.idempotencyKey)) {
      // INV-14 / V2.3-12：重复提交不产生重复变更
      return { applied: false, duplicate: true, appliedOccurrenceIds: [], skippedExecuted: [] };
    }
    const executed = new Set(r.executedOccurrenceIds);
    const applied = r.targetOccurrenceIds.filter((id) => !executed.has(id));
    const skipped = r.targetOccurrenceIds.filter((id) => executed.has(id));
    return { applied: applied.length > 0, duplicate: false, appliedOccurrenceIds: applied, skippedExecuted: skipped };
  },

  escalate(events: EscalationEvent[]): EscalationOutcome {
    if (events.some((e) => e.type === 'PRIMARY_DECLINED')) {
      // CONFIRMED：主责明确拒绝立即升级；但不产生授课确认
      return { outcome: 'IMMEDIATE_ESCALATION', target: 'DEPUTY', generatesTeachingConfirmation: false };
    }
    if (events.some((e) => e.type === 'PRIMARY_UNREACHABLE' || e.type === 'NO_RESPONSE')) {
      // O4-1 / 时间参数未关闭：不自动升级
      return { outcome: 'NOT_CONFIGURED', target: null, generatesTeachingConfirmation: false };
    }
    return { outcome: 'MANUAL_ONLY', target: null, generatesTeachingConfirmation: false };
  },

  closeCase(c: Closure): ClosureOutcome {
    if (c.approvedBy === null) {
      return { outcome: 'PENDING_APPROVAL', teachingStillPending: !c.teachingVerified, caseClosed: false };
    }
    if (c.approvedBy === c.submittedBy) {
      // V2.3 必测 11：提交与批准必须分开
      return { outcome: 'REJECTED_SELF_APPROVAL', teachingStillPending: !c.teachingVerified, caseClosed: false };
    }
    return {
      outcome: 'CLOSED',
      // INV-04：结案不等于课程完成
      teachingStillPending: !c.teachingVerified,
      caseClosed: true,
    };
  },

  authorize(p: Principal | null, action: 'READ' | 'CONFIRM' | 'DOWNLOAD_BACKUP', res: ResourceRef): AuthorizationOutcome {
    if (!p) return { allowed: false, reason: 'UNAUTHENTICATED' };
    if (p.roles.length > 1 && p.actingAs === null) {
      // 一人多角色须显式切换，避免权限叠加
      return { allowed: false, reason: 'AMBIGUOUS_ROLE' };
    }
    if (action === 'DOWNLOAD_BACKUP') {
      return p.roles.includes('ADMIN')
        ? { allowed: true, reason: 'ADMIN' }
        : { allowed: false, reason: 'NOT_ADMIN' };
    }
    if (action === 'CONFIRM') {
      // INV-08：管理员不代确认
      const isOwner = res.ownerTeacherId === p.id;
      return isOwner
        ? { allowed: true, reason: 'SELF_CONFIRM' }
        : { allowed: false, reason: 'NOT_OWNER' };
    }
    if (res.kind === 'PRIVATE_REASON') {
      return res.ownerTeacherId === p.id
        ? { allowed: true, reason: 'OWNER' }
        : { allowed: false, reason: 'PRIVATE_RESOURCE' };
    }
    return { allowed: true, reason: 'AUTHENTICATED' };
  },
};
