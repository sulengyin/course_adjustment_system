/**
 * 权限判定：表驱动，逐操作、逐角色。
 *
 * 三条不可协商的规则（docs/permission-matrix.md）：
 *  1. 角色互不蕴含：管理员不因技术权限获得业务权，因此这里没有"超级角色"分支。
 *  2. `TBD_BLOCKED` 一律拒绝，返回 ROLE_NOT_ASSIGNED；不得临时授予任何人。
 *  3. 默认拒绝：未列入表的操作不存在。
 */

import type { Principal, Role } from './principal.js';

export type Verdict = 'ALLOW' | 'DENY' | 'TBD_BLOCKED';

export type Action =
  | 'VIEW_OWN_TIMETABLE'
  | 'VIEW_OTHER_TIMETABLE'
  | 'IMPORT_TIMETABLE'
  | 'IMPORT_ROSTER'
  | 'PUBLISH_TIMETABLE'
  | 'CREATE_OWN_CHANGE'
  | 'DECIDE_OWN_CONFIRMATION'
  | 'VIEW_OWN_AUDIT'
  | 'VIEW_SCHOOL_AUDIT'
  | 'MANAGE_ACCOUNTS'
  | 'RESET_PASSWORD'
  | 'DOWNLOAD_BACKUP'
  | 'CHANGE_L1_CONFIG'
  | 'ENABLE_L2_POLICY'
  | 'RECORD_EXECUTION_FACT'
  | 'REQUEST_HELP'
  | 'VIEW_OWN_EMERGENCY_REQUEST'
  | 'RECORD_ORAL_ACCEPTANCE'
  | 'CLAIM_COORDINATION'
  | 'TRANSFER_COORDINATION'
  | 'SUBMIT_CLOSURE'
  | 'CONFIRM_CLOSURE';

type Row = Readonly<Record<Role, Verdict>>;

const ALLOW: Verdict = 'ALLOW';
const DENY: Verdict = 'DENY';
const TBD: Verdict = 'TBD_BLOCKED';

function row(t: Verdict, s: Verdict, c: Verdict, r: Verdict, j: Verdict, a: Verdict): Row {
  return Object.freeze({ T: t, S: s, C: c, R: r, J: j, A: a });
}

/** 与 docs/permission-matrix.md 的操作表逐行对应；改这里必须同时改文档与追溯表。 */
export const POLICY: Readonly<Record<Action, Row>> = Object.freeze({
  VIEW_OWN_TIMETABLE: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, ALLOW),
  VIEW_OTHER_TIMETABLE: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, ALLOW),
  IMPORT_TIMETABLE: row(DENY, ALLOW, DENY, DENY, DENY, DENY),
  // 教师/班级名单是业务基础资料，归课务管理人员；管理员不代管（INV-08 同向）
  IMPORT_ROSTER: row(DENY, ALLOW, DENY, DENY, DENY, DENY),
  // 发布岗位未证实（AC01）：S 也只有 TBD_BLOCKED
  PUBLISH_TIMETABLE: row(DENY, TBD, DENY, DENY, DENY, DENY),
  CREATE_OWN_CHANGE: row(ALLOW, DENY, DENY, DENY, DENY, DENY),
  // 确认本人课务：身份即授权，与角色无关；管理员不在此列（INV-08）
  DECIDE_OWN_CONFIRMATION: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, DENY),
  VIEW_OWN_AUDIT: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, ALLOW),
  VIEW_SCHOOL_AUDIT: row(DENY, ALLOW, DENY, DENY, DENY, ALLOW),
  MANAGE_ACCOUNTS: row(DENY, DENY, DENY, DENY, DENY, ALLOW),
  RESET_PASSWORD: row(DENY, DENY, DENY, DENY, DENY, ALLOW),
  DOWNLOAD_BACKUP: row(DENY, DENY, DENY, DENY, DENY, ALLOW),
  CHANGE_L1_CONFIG: row(DENY, ALLOW, DENY, DENY, DENY, DENY),
  // 开启 L2 制度的授权角色未定（D 系列 OPEN）
  ENABLE_L2_POLICY: row(DENY, TBD, DENY, DENY, DENY, DENY),
  // 录入执行事实：BIZ-03 未定，S/R 均 TBD_BLOCKED
  RECORD_EXECUTION_FACT: row(DENY, TBD, DENY, TBD, DENY, DENY),
  // 求助：身份即授权（V2.3-01 §5.1），但只能针对本人课次；管理员无教师身份
  REQUEST_HELP: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, DENY),
  VIEW_OWN_EMERGENCY_REQUEST: row(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, DENY),
  // 口头接受登记：R 的任职名单未定（D06/D07）
  RECORD_ORAL_ACCEPTANCE: row(DENY, DENY, DENY, TBD, DENY, DENY),
  // 接单：先有效接单者唯一；候选范围与"有效"定义未定（E5/D07/O2-1）
  CLAIM_COORDINATION: row(DENY, DENY, ALLOW, ALLOW, DENY, DENY),
  TRANSFER_COORDINATION: row(DENY, DENY, ALLOW, ALLOW, DENY, DENY),
  SUBMIT_CLOSURE: row(DENY, DENY, ALLOW, ALLOW, DENY, DENY),
  // 结案确认人未指定（BIZ-05）
  CONFIRM_CLOSURE: row(DENY, TBD, DENY, DENY, TBD, DENY),
});

/** 界面展示用名称。只做翻译，不参与判定；新增 Action 时必须同时补齐，否则类型检查失败。 */
export const ACTION_LABEL: Readonly<Record<Action, string>> = Object.freeze({
  VIEW_OWN_TIMETABLE: '查看本人课表',
  VIEW_OTHER_TIMETABLE: '查看他人课表',
  IMPORT_TIMETABLE: '导入课表文件',
  IMPORT_ROSTER: '导入教师 / 班级名单',
  PUBLISH_TIMETABLE: '正式发布课表',
  CREATE_OWN_CHANGE: '发起本人调课方案',
  DECIDE_OWN_CONFIRMATION: '确认本人课务',
  VIEW_OWN_AUDIT: '查看本人相关审计',
  VIEW_SCHOOL_AUDIT: '查看全校审计',
  MANAGE_ACCOUNTS: '开户 / 停用账号',
  RESET_PASSWORD: '重置密码',
  DOWNLOAD_BACKUP: '下载备份',
  CHANGE_L1_CONFIG: '修改 L1 参数',
  ENABLE_L2_POLICY: '开启 L2 制度',
  RECORD_EXECUTION_FACT: '录入执行事实',
  REQUEST_HELP: '发起求助',
  VIEW_OWN_EMERGENCY_REQUEST: '查看本人求助',
  RECORD_ORAL_ACCEPTANCE: '登记口头接受',
  CLAIM_COORDINATION: '接单成为协调者',
  TRANSFER_COORDINATION: '移交协调责任',
  SUBMIT_CLOSURE: '提交结案',
  CONFIRM_CLOSURE: '批准结案',
});

/** 固定顺序，供界面逐项自检；顺序即权限矩阵中的阅读顺序。 */
export const ALL_ACTIONS: readonly Action[] = Object.freeze(Object.keys(ACTION_LABEL) as Action[]);

export type PolicyCode = 'ALLOWED' | 'ROLE_NOT_ASSIGNED' | 'FORBIDDEN';

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly code: PolicyCode;
  readonly action: Action;
  readonly actingRole: Role;
}

export function decidePolicy(actingRole: Role, action: Action): PolicyDecision {
  const verdict = POLICY[action][actingRole];
  if (verdict === 'ALLOW') return { allowed: true, code: 'ALLOWED', action, actingRole };
  if (verdict === 'TBD_BLOCKED') return { allowed: false, code: 'ROLE_NOT_ASSIGNED', action, actingRole };
  return { allowed: false, code: 'FORBIDDEN', action, actingRole };
}

export function can(principal: Principal, action: Action): PolicyDecision {
  return decidePolicy(principal.actingRole, action);
}
