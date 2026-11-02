/**
 * P4 变更协商领域逻辑：纯函数，不依赖数据库、HTTP、权限。
 *
 * 核心口径（V2.3-01 §4.2）：
 *   必要确认者 = 本次方案中授课责任被实际改变的教师，
 *   由"变更前 vs 变更后"的完整状态对比得出，不由发起人指定。
 *
 * 特别说明：目标时段是否已被其他课占用，**不是**拒绝理由。
 *   占用只会在"变更后的完整状态"上表现为结构性冲突，并要求该时段的原教师进入确认集合。
 *   若方案把原课一并安排（互换/顶替），则无冲突；若未安排其去向，则方案描述不完整。
 */

export type ChangeItemKind = 'REASSIGN' | 'MOVE' | 'CANCEL';

/** 一条变更条目描述"某个课次变更后的最终归属"，不是"移动指令"。 */
export interface ChangeItem {
  readonly occurrenceId: string;
  readonly kind: ChangeItemKind;
  /** REASSIGN 必填：变更后的授课教师 */
  readonly toTeacherId: string | null;
  /** MOVE 必填：变更后的日期，YYYY-MM-DD */
  readonly toDate: string | null;
  /** MOVE 必填：变更后的节次 */
  readonly toPeriod: number | null;
}

/** 课次的当前有效归属。 */
export interface Assignment {
  readonly occurrenceId: string;
  readonly classId: string;
  readonly subjectId: string;
  readonly teacherId: string;
  readonly date: string;
  readonly period: number;
  readonly cancelled: boolean;
}

export type ChangeErrorCode =
  | 'OCCURRENCE_NOT_FOUND'
  | 'DUPLICATE_ITEM'
  | 'MISSING_TARGET'
  | 'INVALID_DATE'
  | 'INVALID_PERIOD'
  | 'NO_OP'
  | 'CLASS_SLOT_CONFLICT'
  | 'TEACHER_SLOT_CONFLICT';

export interface ChangeError {
  readonly code: ChangeErrorCode;
  readonly occurrenceId: string | null;
  readonly detail: string;
  /** 该冲突在变更前是否已经存在（不是本方案造成的） */
  readonly preExisting: boolean;
}

export interface Projection {
  /** 变更后的完整状态（未被条目涉及的课次保持原样） */
  readonly after: readonly Assignment[];
  readonly errors: readonly ChangeError[];
  /** 责任被实际改变的教师，去重后按字典序 */
  readonly required: readonly string[];
  /** 受影响班级的班主任：仅通知，不进入 required */
  readonly notified: readonly string[];
  /** 受影响的班级中，班主任未配置的（不得假装已通知） */
  readonly notifiedUnknownClasses: readonly string[];
}

const SEP = '\u001f';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function slotIndex(
  list: readonly Assignment[],
  kind: 'C' | 'T',
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const a of list) {
    if (a.cancelled) continue;
    const key =
      kind === 'C'
        ? `C${SEP}${a.classId}${SEP}${a.date}${SEP}${a.period}`
        : `T${SEP}${a.teacherId}${SEP}${a.date}${SEP}${a.period}`;
    const set = index.get(key) ?? new Set<string>();
    set.add(a.occurrenceId);
    index.set(key, set);
  }
  return index;
}

function collectSlotConflicts(
  before: readonly Assignment[],
  after: readonly Assignment[],
): ChangeError[] {
  const errors: ChangeError[] = [];
  for (const [kind, code] of [
    ['C', 'CLASS_SLOT_CONFLICT'],
    ['T', 'TEACHER_SLOT_CONFLICT'],
  ] as const) {
    const beforeIndex = slotIndex(before, kind);
    const afterIndex = slotIndex(after, kind);
    for (const [key, members] of afterIndex) {
      if (members.size < 2) continue;
      const prior = beforeIndex.get(key) ?? new Set<string>();
      const isSubset = [...members].every((id) => prior.has(id));
      const ids = [...members].sort();
      errors.push({
        code,
        occurrenceId: ids[0] ?? null,
        detail: `${key.split(SEP).slice(1).join(' ')} 同时存在 ${ids.join(', ')}`,
        preExisting: isSubset,
      });
    }
  }
  return errors;
}

/**
 * 计算变更后的完整状态、结构性冲突与必要确认者。
 * 条目本身有错时仍继续投影其余条目，最终由 errors 决定可否提交。
 */
export function projectChange(
  before: readonly Assignment[],
  items: readonly ChangeItem[],
  classHeadByClass: Readonly<Record<string, string>> = {},
): Projection {
  const byId = new Map(before.map((a) => [a.occurrenceId, a]));
  const afterById = new Map(before.map((a) => [a.occurrenceId, a]));
  const errors: ChangeError[] = [];
  const required = new Set<string>();
  const affectedClasses = new Set<string>();
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.occurrenceId)) {
      errors.push({
        code: 'DUPLICATE_ITEM',
        occurrenceId: item.occurrenceId,
        detail: '同一课次在方案中出现多次，无法确定最终归属',
        preExisting: false,
      });
      continue;
    }
    seen.add(item.occurrenceId);

    const base = byId.get(item.occurrenceId);
    if (!base) {
      errors.push({
        code: 'OCCURRENCE_NOT_FOUND',
        occurrenceId: item.occurrenceId,
        detail: '课次不存在或已不属于当前课表',
        preExisting: false,
      });
      continue;
    }
    affectedClasses.add(base.classId);

    if (item.kind === 'REASSIGN') {
      if (!item.toTeacherId) {
        errors.push({
          code: 'MISSING_TARGET',
          occurrenceId: item.occurrenceId,
          detail: '调课未指定新教师',
          preExisting: false,
        });
        continue;
      }
      if (item.toTeacherId === base.teacherId) {
        errors.push({
          code: 'NO_OP',
          occurrenceId: item.occurrenceId,
          detail: '调课后教师未变化',
          preExisting: false,
        });
        continue;
      }
      afterById.set(item.occurrenceId, { ...base, teacherId: item.toTeacherId });
      required.add(base.teacherId);
      required.add(item.toTeacherId);
      continue;
    }

    if (item.kind === 'MOVE') {
      if (!item.toDate || item.toPeriod === null) {
        errors.push({
          code: 'MISSING_TARGET',
          occurrenceId: item.occurrenceId,
          detail: '调时间未指定目标日期或节次',
          preExisting: false,
        });
        continue;
      }
      if (!isValidDate(item.toDate)) {
        errors.push({
          code: 'INVALID_DATE',
          occurrenceId: item.occurrenceId,
          detail: `目标日期非法：${item.toDate}`,
          preExisting: false,
        });
        continue;
      }
      if (!Number.isInteger(item.toPeriod) || item.toPeriod < 1) {
        errors.push({
          code: 'INVALID_PERIOD',
          occurrenceId: item.occurrenceId,
          detail: `目标节次非法：${String(item.toPeriod)}`,
          preExisting: false,
        });
        continue;
      }
      if (item.toDate === base.date && item.toPeriod === base.period) {
        errors.push({
          code: 'NO_OP',
          occurrenceId: item.occurrenceId,
          detail: '调时间后与原时间相同',
          preExisting: false,
        });
        continue;
      }
      afterById.set(item.occurrenceId, {
        ...base,
        date: item.toDate,
        period: item.toPeriod,
      });
      // 时间变了，该教师的授课责任内容随之改变，本人必须确认
      required.add(base.teacherId);
      continue;
    }

    // CANCEL
    if (base.cancelled) {
      errors.push({
        code: 'NO_OP',
        occurrenceId: item.occurrenceId,
        detail: '该课次已是取消状态',
        preExisting: false,
      });
      continue;
    }
    afterById.set(item.occurrenceId, { ...base, cancelled: true });
    required.add(base.teacherId);
  }

  const after = [...afterById.values()].sort((a, b) =>
    a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0,
  );

  errors.push(...collectSlotConflicts(before, after));

  const notified: string[] = [];
  const notifiedUnknownClasses: string[] = [];
  for (const classId of [...affectedClasses].sort()) {
    const head = classHeadByClass[classId];
    if (!head) {
      notifiedUnknownClasses.push(classId);
      continue;
    }
    if (!required.has(head) && !notified.includes(head)) notified.push(head);
  }

  return {
    after,
    errors,
    required: [...required].sort(),
    notified: notified.sort(),
    notifiedUnknownClasses,
  };
}

/* ---------------- 确认状态 ---------------- */

export interface ConfirmationRecord {
  readonly teacherId: string;
  /** 该确认针对的方案版本 */
  readonly revision: number;
  readonly decision: 'ACCEPT' | 'DECLINE';
}

export type ConfirmationState =
  | 'READY_TO_APPLY'
  | 'PENDING_CONFIRMATION'
  | 'STALE_CONFIRMATION'
  | 'DECLINED'
  | 'NOT_REQUIRED';

export interface ConfirmationStatus {
  readonly state: ConfirmationState;
  /** 当前版本下尚未确认的教师 */
  readonly missing: readonly string[];
  /** 只有旧版本确认、必须重新确认的教师 */
  readonly stale: readonly string[];
}

/**
 * 沉默、已读、旧版本确认都不构成同意。
 * 一人明确拒绝即整体不可生效，即使其他人尚未答复。
 */
export function confirmationState(
  required: readonly string[],
  revision: number,
  records: readonly ConfirmationRecord[],
): ConfirmationStatus {
  if (required.length === 0) {
    return { state: 'NOT_REQUIRED', missing: [], stale: [] };
  }

  const latest = new Map<string, ConfirmationRecord>();
  for (const r of records) {
    if (!required.includes(r.teacherId)) continue;
    const prev = latest.get(r.teacherId);
    if (!prev || r.revision >= prev.revision) latest.set(r.teacherId, r);
  }

  const missing: string[] = [];
  const stale: string[] = [];
  let declined = false;

  for (const teacherId of required) {
    const record = latest.get(teacherId);
    if (!record) {
      missing.push(teacherId);
      continue;
    }
    if (record.revision < revision) {
      stale.push(teacherId);
      if (record.decision === 'ACCEPT') {
        missing.push(teacherId);
      }
      continue;
    }
    if (record.decision === 'DECLINE') {
      declined = true;
    }
    // ACCEPT 且版本匹配 → 该项已满足，不进入 missing
  }

  if (declined) {
    return { state: 'DECLINED', missing: missing.sort(), stale: stale.sort() };
  }
  if (stale.length > 0) {
    return {
      state: 'STALE_CONFIRMATION',
      missing: missing.sort(),
      stale: stale.sort(),
    };
  }
  if (missing.length > 0) {
    return {
      state: 'PENDING_CONFIRMATION',
      missing: missing.sort(),
      stale: [],
    };
  }
  return { state: 'READY_TO_APPLY', missing: [], stale: [] };
}

/* ---------------- 纠错分类 ---------------- */

export type CorrectionKind = 'REQUIRES_NEW_PROPOSAL' | 'TBD_CORRECTION_SCOPE';

export interface CorrectionInput {
  readonly teacherId: string | null;
  readonly classId: string | null;
  readonly subjectId: string | null;
  readonly date: string | null;
  readonly period: number | null;
}

/**
 * 只实现确定方向：一旦改变授课责任，就必须走新方案。
 * 白名单未配置（BIZ-01）时，其余情况一律返回 TBD_CORRECTION_SCOPE，不得放行。
 */
export function classifyCorrection(
  current: Assignment,
  next: CorrectionInput,
): { readonly kind: CorrectionKind; readonly changedFields: readonly string[] } {
  const changed: string[] = [];
  if (next.teacherId !== null && next.teacherId !== current.teacherId) {
    changed.push('teacherId');
  }
  if (next.classId !== null && next.classId !== current.classId) {
    changed.push('classId');
  }
  if (next.subjectId !== null && next.subjectId !== current.subjectId) {
    changed.push('subjectId');
  }
  if (next.date !== null && next.date !== current.date) changed.push('date');
  if (next.period !== null && next.period !== current.period) {
    changed.push('period');
  }

  return {
    kind: changed.length > 0 ? 'REQUIRES_NEW_PROPOSAL' : 'TBD_CORRECTION_SCOPE',
    changedFields: changed,
  };
}

/* ---------------- 状态机迁移 ---------------- */

export type CaseStatus =
  | 'DRAFT'
  | 'PENDING_CONFIRMATION'
  | 'BLOCKED_CONFLICT'
  | 'APPLYING'
  | 'EFFECTIVE'
  | 'REJECTED'
  | 'WITHDRAWN';

const ALLOWED: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  DRAFT: ['PENDING_CONFIRMATION', 'WITHDRAWN'],
  PENDING_CONFIRMATION: [
    'PENDING_CONFIRMATION',
    'BLOCKED_CONFLICT',
    'APPLYING',
    'REJECTED',
    'WITHDRAWN',
  ],
  BLOCKED_CONFLICT: ['PENDING_CONFIRMATION', 'REJECTED', 'WITHDRAWN'],
  APPLYING: ['EFFECTIVE', 'PENDING_CONFIRMATION'],
  EFFECTIVE: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** 已生效的方案不可删除、不可回退，只能新建恢复方案。 */
export function isTerminal(status: CaseStatus): boolean {
  return status === 'EFFECTIVE' || status === 'REJECTED' || status === 'WITHDRAWN';
}
