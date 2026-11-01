/**
 * 应急协调的纯函数层（P6 受限实现）。
 *
 * 这里只编码**已经确认**的分离关系：
 *   求助 ≠ 已送达 ≠ 有人承接 ≠ 已解决 ≠ 已上课 ≠ 已核验
 *
 * 所有未决事项不在此处猜测，而是以 `NOT_CONFIGURED` + 阻断项编号返回：
 *   - 补确认截止与逾期判定：BIZ-04 / TIME
 *   - 口头接单的追认期限：O5
 *   - 责任组 / 当日主责 / 排班代理 / 兜底岗位：E5
 *   - 口头与在线接单的先后裁定：O2-1
 *   - 结案确认人：BIZ-05
 *
 * 领域函数可以表达"如果这些规则确定了，状态会怎样变化"，
 * 但服务层不得在规则未定时调用这些分支。见 `src/service/emergency-service.ts`。
 */

export type CoordinationStatus =
  | 'REQUESTED'
  | 'NOTIFIED'
  | 'NO_OWNER'
  | 'OWNED'
  | 'AMBIGUOUS'
  | 'CLOSURE_SUBMITTED'
  | 'CLOSED';

/** 授课事实的核验状态：与协调状态是两条独立的线。 */
export type TeachingVerification = 'PENDING' | 'VERIFIED';

export type ClaimSource = 'ONLINE' | 'ORAL';

export interface EmergencyClaim {
  readonly id: string;
  readonly teacherId: string;
  readonly source: ClaimSource;
  readonly recordedAt: string;
  /** 口头接受由本人补确认的时刻；在线接单当场即为确认。 */
  readonly confirmedAt: string | null;
  readonly recordedBy: string;
}

export interface CoordinationState {
  readonly status: CoordinationStatus;
  readonly ownerTeacherId: string | null;
  /** 口头登记但尚未追认的人：只能显示"暂有人协调/待追认" */
  readonly provisionalTeacherId: string | null;
  readonly claims: readonly EmergencyClaim[];
  readonly teachingVerification: TeachingVerification;
  readonly closureSubmittedAt: string | null;
}

export const INITIAL_COORDINATION_STATE: CoordinationState = Object.freeze({
  status: 'REQUESTED',
  ownerTeacherId: null,
  provisionalTeacherId: null,
  claims: Object.freeze([]) as readonly EmergencyClaim[],
  teachingVerification: 'PENDING',
  closureSubmittedAt: null,
});

export type NotConfiguredCode = 'NOT_CONFIGURED';

export interface NotConfigured {
  readonly code: NotConfiguredCode;
  /** 阻断项编号，直接对应 docs/decisions.csv / docs/traceability.csv */
  readonly blockedBy: readonly string[];
}

function notConfigured(...blockedBy: string[]): NotConfigured {
  return { code: 'NOT_CONFIGURED', blockedBy: Object.freeze(blockedBy) };
}

function withClaim(state: CoordinationState, claim: EmergencyClaim): CoordinationState {
  return { ...state, claims: Object.freeze([...state.claims, claim]) };
}

export type ClaimOutcome = 'OWNED' | 'PROVISIONAL' | 'ALREADY_OWNED' | 'AMBIGUOUS';

export interface ClaimResult {
  readonly state: CoordinationState;
  readonly outcome: ClaimOutcome;
  /** 是否需要人工裁定；为 true 时 ownerTeacherId 必为 null。 */
  readonly requiresAdjudication: boolean;
}

/**
 * 接单/口头登记对状态的影响。
 *
 * 规则来源：
 *  - 先有效接单者为唯一当前负责人（V2.3-02 O2 / V23-10）。
 *  - 口头接受不等于有效接单，只能标"暂有人协调/待追认"（state-machines §3）。
 *  - 口头与在线来源冲突时保留双方来源，不按时间先后裁定（O2-1 未决）。
 */
export function applyClaim(state: CoordinationState, claim: EmergencyClaim): ClaimResult {
  if (state.status === 'AMBIGUOUS') {
    // 歧义状态不会被后到的记录自动消除，只能由人裁定。
    return { state: withClaim(state, claim), outcome: 'AMBIGUOUS', requiresAdjudication: true };
  }

  const others = state.claims.filter((c) => c.teacherId !== claim.teacherId);
  const samePersonAlreadyOwns =
    state.ownerTeacherId === claim.teacherId ||
    state.claims.some((c) => c.teacherId === claim.teacherId && c.source === 'ONLINE');

  if (claim.source === 'ORAL') {
    if (samePersonAlreadyOwns) {
      return { state: withClaim(state, claim), outcome: 'ALREADY_OWNED', requiresAdjudication: false };
    }
    if (others.length === 0) {
      return {
        state: {
          ...withClaim(state, claim),
          status: 'NO_OWNER',
          provisionalTeacherId: claim.teacherId,
        },
        outcome: 'PROVISIONAL',
        requiresAdjudication: false,
      };
    }
    // 另一个人也登记过：口头/在线并存，先后顺序未决。
    return {
      state: {
        ...withClaim(state, claim),
        status: 'AMBIGUOUS',
        ownerTeacherId: null,
        provisionalTeacherId: null,
      },
      outcome: 'AMBIGUOUS',
      requiresAdjudication: true,
    };
  }

  if (state.ownerTeacherId === claim.teacherId) {
    return { state: withClaim(state, claim), outcome: 'ALREADY_OWNED', requiresAdjudication: false };
  }
  if (state.ownerTeacherId !== null) {
    // 已有有效负责人：后到者不生效，但记录保留。
    return { state: withClaim(state, claim), outcome: 'ALREADY_OWNED', requiresAdjudication: false };
  }
  if (others.some((c) => c.source === 'ORAL')) {
    // 与另一人的口头接受冲突：不按时间定序（V23-10）。
    return {
      state: {
        ...withClaim(state, claim),
        status: 'AMBIGUOUS',
        provisionalTeacherId: null,
      },
      outcome: 'AMBIGUOUS',
      requiresAdjudication: true,
    };
  }
  if (others.some((c) => c.source === 'ONLINE')) {
    // 理论上不应出现（在线接单即应产生 owner）；保守处理为歧义，不猜。
    return {
      state: { ...withClaim(state, claim), status: 'AMBIGUOUS' },
      outcome: 'AMBIGUOUS',
      requiresAdjudication: true,
    };
  }

  return {
    state: {
      ...withClaim(state, claim),
      status: 'OWNED',
      ownerTeacherId: claim.teacherId,
      provisionalTeacherId: null,
    },
    outcome: 'OWNED',
    requiresAdjudication: false,
  };
}

/** 仅记录"已通知"这一人工事实；送达判定未定（BIZ-13），服务层不调用。 */
export function markNotified(state: CoordinationState): CoordinationState {
  if (state.status !== 'REQUESTED') return state;
  return { ...state, status: 'NOTIFIED' };
}

export const CLOSURE_FIELDS = Object.freeze([
  'outcome',
  'summary',
  'responsiblePerson',
  'closedAt',
  'contactRecord',
] as const);

export type ClosureField = (typeof CLOSURE_FIELDS)[number];

/** V2.3-02 R02-B4-7：结案须记录结果 / 经过 / 责任人 / 时间 / 联系记录。 */
export interface ClosureFacts {
  readonly outcome: string;
  readonly summary: string;
  readonly responsiblePerson: string;
  readonly closedAt: string;
  readonly contactRecord: string;
}

export function missingClosureFields(facts: Partial<ClosureFacts>): ClosureField[] {
  return CLOSURE_FIELDS.filter((field) => {
    const value = facts[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

export type SubmitClosureResult =
  | { readonly ok: true; readonly state: CoordinationState }
  | {
      readonly ok: false;
      readonly code: 'NO_COORDINATION_OWNER' | 'CLOSURE_FIELDS_MISSING';
      readonly missing: readonly ClosureField[];
    };

export function submitClosure(state: CoordinationState, facts: Partial<ClosureFacts>): SubmitClosureResult {
  if (state.status !== 'OWNED' || state.ownerTeacherId === null) {
    return { ok: false, code: 'NO_COORDINATION_OWNER', missing: [] };
  }
  const missing = missingClosureFields(facts);
  if (missing.length > 0) {
    return { ok: false, code: 'CLOSURE_FIELDS_MISSING', missing };
  }
  return {
    ok: true,
    state: { ...state, status: 'CLOSURE_SUBMITTED', closureSubmittedAt: facts.closedAt as string },
  };
}

/**
 * 结案确认：只表达"结案与授课核验是两条线"。
 * 谁能确认结案（BIZ-05）不在本函数决定，由调用方以授权结果传入。
 */
export function closeCase(
  state: CoordinationState,
  input: { readonly teachingVerified: boolean },
): { readonly state: CoordinationState; readonly caseClosed: true; readonly teachingStillPending: boolean } {
  return {
    state: {
      ...state,
      status: 'CLOSED',
      teachingVerification: input.teachingVerified ? 'VERIFIED' : 'PENDING',
    },
    caseClosed: true,
    teachingStillPending: !input.teachingVerified,
  };
}

/** 展示用状态：结案但未核验时必须同时显示 TEACHING_PENDING。 */
export function displayStates(state: CoordinationState): string[] {
  if (state.status === 'CLOSED' && state.teachingVerification === 'PENDING') {
    return ['CLOSED', 'TEACHING_PENDING'];
  }
  return [state.status];
}

/** 补确认逾期判定：截止钟点与调休规则未定，返回显式未配置。 */
export function overdueStatus(): NotConfigured {
  return notConfigured('BIZ-04', 'TIME');
}

/** 口头接单的追认期限未定（O5）。 */
export function ratificationStatus(): NotConfigured {
  return notConfigured('O5');
}

/** 责任组 / 当日主责 / 排班代理 / 兜底岗位未定（E5）。 */
export function responsibilityPlan(): NotConfigured {
  return notConfigured('E5');
}

export type EscalationResult =
  | { readonly code: 'NO_ESCALATION'; readonly target: null }
  | { readonly code: 'NOT_CONFIGURED'; readonly target: null; readonly blockedBy: readonly string[] };

/** 主责明确拒绝时必须立即升级（V23-09），但升级到谁由未定的代理岗位决定。 */
export function escalation(input: { readonly primaryDeclined: boolean }): EscalationResult {
  if (!input.primaryDeclined) return { code: 'NO_ESCALATION', target: null };
  return { code: 'NOT_CONFIGURED', target: null, blockedBy: Object.freeze(['E5']) };
}

export interface ProxyRecordResult {
  readonly state: 'PENDING_TEACHER_CONFIRMATION';
  readonly countsAsTeacherConfirmation: false;
  readonly pendingTeacherConfirmation: true;
}

/**
 * 校内代录校外求助：代录只记录"有人转述了什么"，
 * 不因代录而产生本人确认（AC11 / INV-03）。
 */
export function proxyRecord(input: {
  readonly recordedForTeacherId: string;
  readonly recordedByTeacherId: string;
  readonly teacherConfirmed: boolean;
}): ProxyRecordResult {
  void input;
  return {
    state: 'PENDING_TEACHER_CONFIRMATION',
    countsAsTeacherConfirmation: false,
    pendingTeacherConfirmation: true,
  };
}
