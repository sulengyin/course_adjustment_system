/**
 * 身份主体。
 *
 * `Principal` 只能由会话层签发（`AuthStore.issue`），业务服务只接受它、不接受裸字符串 ID。
 * 品牌字段只存在于类型层，用于阻止"随手拼一个对象"的误用；真正的防线是：
 * 服务层从 principal.teacherId 取值，调用方无法通过请求体指定"我是谁"。
 */

declare const PRINCIPAL_BRAND: unique symbol;

/** 角色代号与 docs/permission-matrix.md 一致，顺序即展示顺序。 */
export type Role = 'T' | 'S' | 'C' | 'R' | 'J' | 'A';

export const ALL_ROLES: readonly Role[] = Object.freeze(['T', 'S', 'C', 'R', 'J', 'A']);

export const ROLE_LABEL: Readonly<Record<Role, string>> = Object.freeze({
  T: '教师',
  S: '课务管理人员',
  C: '协调者',
  R: '记录者',
  J: '争议裁决者',
  A: '系统管理员',
});

/**
 * 当前不允许由管理员直接授予的角色：
 *  - R：任职名单未定（D06/D07），授予即等于替学校指定记录者。
 *  - J：争议裁决者名单未定（D04）。
 *  - C：动态角色，由"先有效接单"产生，不是岗位。
 */
export const NON_GRANTABLE_ROLES: readonly Role[] = Object.freeze(['C', 'R', 'J']);

export interface Principal {
  readonly userId: string;
  /** 关联的教师档案；非教师岗位为 null */
  readonly teacherId: string | null;
  readonly displayName: string;
  readonly roles: readonly Role[];
  /** 本次会话显式选择的身份；一人多角色时必须指定 */
  readonly actingRole: Role;
  /**
   * 账号级能力（来自 capability_grant）。不是角色：只能补 POLICY 里的 DENY，
   * 不能把 TBD_BLOCKED 变成可用；签发会话时读入，改授权需重新登录。
   */
  readonly grants?: readonly string[];
  readonly sessionId: string;
  /** 首登未改密：除改密与登出外一律拒绝 */
  readonly mustChangePassword: boolean;
  readonly [PRINCIPAL_BRAND]: true;
}

export function isRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}

/** 仅供会话层使用。业务代码不得调用。 */
export function mintPrincipal(input: Omit<Principal, typeof PRINCIPAL_BRAND>): Principal {
  return input as Principal;
}
