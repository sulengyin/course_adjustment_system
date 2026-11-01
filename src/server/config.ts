/**
 * 部署配置校验：第一版纯内网。
 *
 * 三条硬规则（不是建议）：
 *  1. 只能绑定回环或私有地址；`0.0.0.0` / `::` / 公网地址一律拒绝启动。
 *  2. 不解析主机名——主机名可能被改指向公网。
 *  3. 要求 TLS 却没有提供证书 → 拒绝启动，不允许"先明文跑起来"。
 */

import { existsSync } from 'node:fs';

export type ServerConfigCode =
  | 'BAD_PORT'
  | 'BAD_ADDRESS'
  | 'WILDCARD_BIND'
  | 'PUBLIC_BIND'
  | 'TLS_REQUIRED_BUT_MISSING'
  | 'TLS_FILE_NOT_FOUND';

export class ServerConfigError extends Error {
  constructor(
    readonly code: ServerConfigCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TlsConfig {
  readonly certFile: string;
  readonly keyFile: string;
}

export interface ServerConfig {
  readonly bindAddress: string;
  readonly port: number;
  readonly tls: TlsConfig | null;
  /** 生产建议为 true；为 false 时启动日志必须记录明文传输风险 */
  readonly requireTls: boolean;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function inCidr(ip: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

export function isPrivateIpv4(address: string): boolean {
  const ip = ipv4ToInt(address);
  if (ip === null) return false;
  return inCidr(ip, '127.0.0.0', 8) || inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16);
}

/** IPv6 只允许回环、唯一本地地址（fc00::/7）与链路本地（fe80::/10）。 */
export function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  const first = lower.split(':')[0] ?? '';
  if (first.startsWith('fc') || first.startsWith('fd')) return true;
  if (first.startsWith('fe8') || first.startsWith('fe9') || first.startsWith('fea') || first.startsWith('feb')) return true;
  return false;
}

export function validateServerConfig(config: ServerConfig): void {
  // 0 = 由操作系统分配端口（仅用于本机自检与测试）；生产部署应写明确端口。
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ServerConfigError('BAD_PORT', `端口不合法：${config.port}`);
  }
  const address = config.bindAddress.trim();
  if (address === '') {
    throw new ServerConfigError('BAD_ADDRESS', '必须显式指定内网绑定地址，不允许留空');
  }
  if (address === '0.0.0.0' || address === '::' || address === '::0') {
    throw new ServerConfigError('WILDCARD_BIND', '不允许绑定通配地址；请指定具体内网地址');
  }
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
  const isV6 = address.includes(':');
  if (!isV4 && !isV6) {
    throw new ServerConfigError('BAD_ADDRESS', '必须是 IP 字面量，不接受主机名（可能被改指向公网）');
  }
  if (isV4 && !isPrivateIpv4(address)) {
    throw new ServerConfigError('PUBLIC_BIND', `只允许绑定回环或私有地址：${address}`);
  }
  if (isV6 && !isPrivateIpv6(address)) {
    throw new ServerConfigError('PUBLIC_BIND', `只允许绑定回环或私有地址：${address}`);
  }
  if (config.requireTls && config.tls === null) {
    throw new ServerConfigError('TLS_REQUIRED_BUT_MISSING', '已要求 TLS 但未提供证书与私钥，拒绝以明文启动');
  }
  if (config.tls !== null) {
    if (!existsSync(config.tls.certFile)) {
      throw new ServerConfigError('TLS_FILE_NOT_FOUND', `证书文件不存在：${config.tls.certFile}`);
    }
    if (!existsSync(config.tls.keyFile)) {
      throw new ServerConfigError('TLS_FILE_NOT_FOUND', `私钥文件不存在：${config.tls.keyFile}`);
    }
  }
}
