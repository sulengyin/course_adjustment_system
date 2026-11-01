/**
 * 口令散列与强度基线。
 *
 * 技术基线（非学校制度，见 docs/02 §L1 备注）：scrypt + 每用户独立随机盐。
 * 不采集手机号、不发送短信；初始口令由管理员一次性交付，首登强制修改。
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** 口令最小长度：技术基线。不写入任何"学校规定"字样。 */
export const MIN_PASSWORD_LENGTH = 12;

const INITIAL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const INITIAL_DIGITS = '23456789';
const INITIAL_ALPHABET = `${INITIAL_LETTERS}${INITIAL_DIGITS}`;

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 一次性初始口令：无易混淆字符，12 位，约 59 bit 熵。
 *
 * 必须"按构造"满足强度基线：先各放一个字母与一个数字，再随机补足并打乱。
 * 纯随机抽 12 位约有 3% 概率抽成"全字母"，会被 checkPasswordStrength 拒绝，
 * 表现为首次部署偶发失败——这种概率性失败最容易被当成环境问题。
 */
export function generateInitialPassword(): string {
  const chars = [
    INITIAL_LETTERS[randomInt(INITIAL_LETTERS.length)] as string,
    INITIAL_DIGITS[randomInt(INITIAL_DIGITS.length)] as string,
  ];
  for (let i = chars.length; i < 12; i += 1) {
    chars.push(INITIAL_ALPHABET[randomInt(INITIAL_ALPHABET.length)] as string);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

export type PasswordProblem = 'TOO_SHORT' | 'SAME_AS_OLD' | 'ONLY_ONE_CHARACTER_CLASS';

/**
 * 强度检查只做"不能太弱"，不规定学校的口令策略。
 * 至少两类字符（字母/数字/符号），避免 12 个相同字符这类形式合规。
 * `previous` 是本次校验中用户提供的旧口令明文；改密时必须与它不同。
 */
export function checkPasswordStrength(input: {
  readonly next: string;
  readonly previous: string | null;
}): PasswordProblem | null {
  if (input.next.length < MIN_PASSWORD_LENGTH) return 'TOO_SHORT';
  if (input.previous !== null && input.next === input.previous) return 'SAME_AS_OLD';
  const classes = [/[A-Za-z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(input.next)).length;
  if (classes < 2) return 'ONLY_ONE_CHARACTER_CLASS';
  return null;
}
