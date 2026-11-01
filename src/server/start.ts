/**
 * 启动入口：先校验配置，再监听；监听后核对实际绑定地址与配置一致。
 * 任何一项不满足都抛错退出，不做"先起来再说"。
 */

import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { validateServerConfig, type ServerConfig } from './config.js';
import { createHandler, type AppDeps } from './http.js';

export interface StartedServer {
  readonly server: Server;
  readonly address: string;
  readonly port: number;
  readonly tls: boolean;
}

export async function startServer(config: ServerConfig, deps: AppDeps): Promise<StartedServer> {
  validateServerConfig(config);
  const handler = createHandler(deps);
  const server: Server =
    config.tls === null
      ? createHttpServer(handler)
      : createHttpsServer(
          {
            cert: readFileSync(config.tls.certFile),
            key: readFileSync(config.tls.keyFile),
            minVersion: 'TLSv1.2',
          },
          handler,
        );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindAddress, () => resolve());
  });

  const info = server.address() as AddressInfo | null;
  if (!info || typeof info === 'string') {
    server.close();
    throw new Error('无法确认实际监听地址');
  }
  if (info.address !== config.bindAddress) {
    // 例如传入 127.0.0.1 却监听在 ::1：宁可失败，也不留一个"以为绑了"的口子。
    server.close();
    throw new Error(`实际绑定地址 ${info.address} 与配置 ${config.bindAddress} 不一致`);
  }

  return { server, address: info.address, port: info.port, tls: config.tls !== null };
}

export async function stopServer(started: StartedServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()));
  });
}
