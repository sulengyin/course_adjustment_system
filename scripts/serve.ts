/**
 * 部署入口。所有参数来自环境变量，缺一项就报错退出，不猜默认值。
 *
 * 必填：
 *   CA_BIND_ADDRESS   内网绑定地址（IP 字面量；不允许 0.0.0.0）
 *   CA_PORT           端口
 *   CA_DB_PATH        SQLite 文件路径（不存在则新建，首次需运行初始化）
 * 选填：
 *   CA_TLS_CERT / CA_TLS_KEY   同时给出才启用 HTTPS
 *   CA_REQUIRE_TLS=1           要求 TLS；缺少证书时拒绝启动
 */

import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';
import { ChangeService } from '../src/service/change-service.js';
import { TimetableService } from '../src/service/timetable-service.js';
import { EmergencyService } from '../src/service/emergency-service.js';
import { startServer } from '../src/server/start.js';
import { ServerConfigError, validateServerConfig, type ServerConfig } from '../src/server/config.js';
import { createLogger } from '../src/log/logger.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  const bindAddress = env('CA_BIND_ADDRESS');
  const portRaw = env('CA_PORT');
  const dbPath = env('CA_DB_PATH');
  if (!bindAddress || !portRaw || !dbPath) {
    console.error('缺少必填环境变量：CA_BIND_ADDRESS / CA_PORT / CA_DB_PATH');
    process.exit(2);
  }

  const certFile = env('CA_TLS_CERT');
  const keyFile = env('CA_TLS_KEY');
  if ((certFile === '') !== (keyFile === '')) {
    console.error('CA_TLS_CERT 与 CA_TLS_KEY 必须同时提供');
    process.exit(2);
  }

  const config: ServerConfig = {
    bindAddress,
    port: Number(portRaw),
    tls: certFile && keyFile ? { certFile, keyFile } : null,
    requireTls: env('CA_REQUIRE_TLS') === '1',
  };

  try {
    validateServerConfig(config);
  } catch (error) {
    if (error instanceof ServerConfigError) {
      console.error(`配置被拒绝 [${error.code}]：${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const db = new CourseDatabase(dbPath);
  // 环境未定的库不许启动：否则界面上无法标明这是演示还是正式，用户会把演示数据当真。
  const mode = db.deploymentMode();
  if (mode === null) {
    console.error(
      '该库尚未设定环境，拒绝启动。请先执行：CA_DB_PATH=<库> CA_MODE=demo|production npm run set-mode',
    );
    db.close();
    process.exit(3);
  }

  const chain = db.auditLog.verify();
  if (!chain.ok) {
    console.error(`审计链校验失败（brokenAt=${chain.brokenAt}, ${chain.reason}），拒绝启动`);
    db.close();
    process.exit(3);
  }

  const logger = createLogger();
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer(config, {
      db,
      auth: new AuthService(db),
      changes: new ChangeService(db),
      timetable: new TimetableService(db),
      emergency: new EmergencyService(db),
      logger,
    });
  } catch (error) {
    // 端口被占用、证书读不出等启动错误必须明确退出，不能留下"半启动"进程。
    console.error(`启动失败：${(error as Error).message}`);
    db.close();
    process.exit(3);
  }
  logger.info('SERVER_STARTED', {
    address: started.address,
    port: started.port,
    tls: started.tls,
    count: chain.length,
  });

  console.log(
    `已启动：${started.tls ? 'https' : 'http'}://${started.address}:${started.port}　数据库=${dbPath}　审计条数=${chain.length}`,
  );
  console.log(
    mode === 'DEMO'
      ? '环境：演示 / 联调（DEMO）—— 库内全部为虚构数据，不得导入真实名单与真实课表。'
      : '环境：正式业务（PRODUCTION）—— 库内为真实业务数据，不得载入虚构演示数据。',
  );
  if (!started.tls) {
    console.warn('警告：当前为明文 HTTP。纯内网环境下口令与课表将以明文传输，需由校方书面确认该风险。');
  }

  const shutdown = (signal: string): void => {
    console.log(`收到 ${signal}，正在关闭…`);
    started.server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
