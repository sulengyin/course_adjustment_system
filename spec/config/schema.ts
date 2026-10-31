/**
 * 配置契约：L0 不可配置 / L1 空值必填 / L2 默认关闭且开启需书面依据。
 * 本文件是"L0 不出现在设置页"这一要求的可执行载体。
 */

export interface L0Invariant {
  id: string;
  statement: string;
}

/** L0：硬不变量。不得出现在任何配置 schema 中。 */
export const L0_INVARIANTS: readonly L0Invariant[] = Object.freeze([
  { id: 'INV-01', statement: '沉默/已读/未回复/过期 ≠ 同意' },
  { id: 'INV-02', statement: '临时登记 ≠ 教师接受 ≠ 正式生效 ≠ 已执行' },
  { id: 'INV-03', statement: '口头登记 ≠ 本人电子确认；补确认不倒填时间' },
  { id: 'INV-04', statement: '协调结案 ≠ 授课事实已核验 ≠ 课程已完成' },
  { id: 'INV-05', statement: '导入文件 ≠ 学校正式发布' },
  { id: 'INV-06', statement: '已执行授课事实不可被恢复方案改写' },
  { id: 'INV-07', statement: '必要确认者由受影响集合计算，不由发起人指定' },
  { id: 'INV-08', statement: '系统管理员不代确认、不默认裁决' },
  { id: 'INV-09', statement: '生效后不可删除，取消须新建方案并重新确认' },
  { id: 'INV-10', statement: '纯资料纠错不得改变实际授课/工作责任' },
  { id: 'INV-11', statement: '无占用记录 ≠ 有空；有空 ≠ 愿意' },
  { id: 'INV-12', statement: '服务端逐操作、逐资源校验；前端隐藏不算授权' },
  { id: 'INV-13', statement: '第一版纯校内访问，校外不得直连' },
  { id: 'INV-14', statement: '任何变更不得静默覆盖已生效事实' },
]);

export interface L1Param {
  key: string;
  label: string;
  /** 永远为 null：L1 不预填任何值 */
  defaultValue: null;
  /** 未配置时依赖该参数的能力返回 NOT_CONFIGURED */
  blockedWhenUnset: true;
  authority: string;
}

/** L1：校本参数。空值 + 必填，不提供推荐值。 */
export const L1_PARAMS: readonly L1Param[] = Object.freeze([
  { key: 'school.name', label: '校名', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'school.termLabel', label: '学期显示', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'school.timezone', label: '时区', defaultValue: null, blockedWhenUnset: true, authority: '部署方' },
  { key: 'calendar.term', label: '学期起止与上课日', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'calendar.exceptions', label: '节假日/调休/考试周/活动日', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'bell.schedule', label: '节次起止时间', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'rotation.parityBase', label: '单双周基准周', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'makeup.deadlineClock', label: '补确认截止钟点', defaultValue: null, blockedWhenUnset: true, authority: '校方（BIZ-04）' },
  { key: 'escalation.thresholds', label: '升级阈值', defaultValue: null, blockedWhenUnset: true, authority: '校方（时间参数）' },
  { key: 'escalation.reminders', label: '提醒间隔', defaultValue: null, blockedWhenUnset: true, authority: '校方' },
  { key: 'conflict.severity', label: '各占用类型的冲突级别', defaultValue: null, blockedWhenUnset: true, authority: '校方（BIZ-08）' },
  { key: 'import.strictness', label: '导入容差', defaultValue: null, blockedWhenUnset: true, authority: '课务管理人员' },
  { key: 'retention.days', label: '数据留存期限', defaultValue: null, blockedWhenUnset: true, authority: '校方（BIZ-10）' },
  { key: 'backup.rpo', label: '恢复点目标', defaultValue: null, blockedWhenUnset: true, authority: '校方' },
  { key: 'backup.rto', label: '恢复时间目标', defaultValue: null, blockedWhenUnset: true, authority: '校方' },
  { key: 'notification.channels', label: '通知渠道（仅站内待办可用）', defaultValue: null, blockedWhenUnset: true, authority: '校方' },
  { key: 'print.template', label: '单据模板', defaultValue: null, blockedWhenUnset: true, authority: '校方（BIZ-12）' },
]);

export interface L2Policy {
  key: string;
  label: string;
  /** L2 默认一律关闭 */
  defaultEnabled: false;
  /** 开启必须登记书面依据 */
  requiresBasisDocument: true;
  relatedOpenItem: string;
}

/** L2：待决制度。默认关闭；开启不解除任何 L0。 */
export const L2_POLICIES: readonly L2Policy[] = Object.freeze([
  { key: 'policy.offlineNote.acceptAsEvidence', label: '线下调课单作为本人确认证据', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'D01/D02' },
  { key: 'policy.scheduleVersion.conflictMode', label: '新版课表与既有变更重叠处理', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'D03' },
  { key: 'policy.dispute.adjudication', label: '争议裁决角色与流程', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'D04' },
  { key: 'policy.occupancy.shareScope', label: '动态占用强制共享范围', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'D05' },
  { key: 'policy.correction.whitelist', label: '免确认纠错字段白名单', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'BIZ-01' },
  { key: 'policy.coordination.autoAssign', label: '接单先后自动裁定', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'O2-1' },
  { key: 'policy.coordination.autoEscalate', label: '按阈值自动升级', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'O4-1/时间参数' },
  { key: 'policy.makeup.lateAllowed', label: '逾期后仍允许补确认', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'BIZ-04' },
  { key: 'policy.rotation.computeRule', label: '轮换课推算规则', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'BIZ-06' },
  { key: 'policy.afterSchool.filing', label: '备案课后服务作为硬冲突依据', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'BIZ-07' },
  { key: 'policy.execution.completionCriteria', label: '“已执行”判定依据', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'BIZ-03' },
  { key: 'policy.settlement.stateFlow', label: '代课记录推进至可结算（不含金额）', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'D08' },
  { key: 'integration.dingtalk', label: '钉钉接入', defaultEnabled: false, requiresBasisDocument: true, relatedOpenItem: 'T01' },
]);

/** 不允许出现在 L1 键名中的语义词：出现即意味着"制度被做成了参数" */
export const FORBIDDEN_L1_TOKENS: readonly string[] = Object.freeze([
  'silence',
  'consent',
  'agree',
  'approve',
  'confirm',
  'overwrite',
  'publishOnUpload',
  'adminMay',
  'autoAccept',
]);

export interface BasisRecord {
  documentNo: string;
  basisType: 'POLICY' | 'MINUTES' | 'APPROVAL';
  approver: string;
  effectiveFrom: string;
}

export type EnableResult =
  | { ok: true; key: string; basis: BasisRecord }
  | { ok: false; key: string; reason: 'UNKNOWN_KEY' | 'L0_NOT_CONFIGURABLE' | 'BASIS_REQUIRED' };

/** 开启 L2 的最小实现：必须带依据，且只能开 L2。 */
export function enablePolicy(
  key: string,
  basis: Partial<BasisRecord> | null,
): EnableResult {
  if (L0_INVARIANTS.some((i) => i.id === key)) {
    return { ok: false, key, reason: 'L0_NOT_CONFIGURABLE' };
  }
  const policy = L2_POLICIES.find((p) => p.key === key);
  if (!policy) {
    return { ok: false, key, reason: 'UNKNOWN_KEY' };
  }
  if (
    !basis ||
    !basis.documentNo ||
    !basis.basisType ||
    !basis.approver ||
    !basis.effectiveFrom
  ) {
    return { ok: false, key, reason: 'BASIS_REQUIRED' };
  }
  return { ok: true, key, basis: basis as BasisRecord };
}

export type ConfigLookup =
  | { configured: true; key: string; value: unknown }
  | { configured: false; key: string; code: 'NOT_CONFIGURED' };

/** L1 读取：未配置就返回 NOT_CONFIGURED，绝不回退到内置值。 */
export function resolveL1(key: string, values: Record<string, unknown>): ConfigLookup {
  const raw = values[key];
  if (raw === undefined || raw === null) {
    return { configured: false, key, code: 'NOT_CONFIGURED' };
  }
  return { configured: true, key, value: raw };
}
