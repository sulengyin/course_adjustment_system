/**
 * 首次部署：创建第一个系统管理员。
 * 只在库中没有任何账号时可用；初始口令只打印这一次，不落盘、不入日志。
 *
 * 用法：CA_DB_PATH=/data/ca.sqlite CA_ADMIN_LOGIN=admin CA_ADMIN_NAME=教务管理员 npm run init-admin
 */

import { CourseDatabase } from '../src/store/database.js';
import { AuthService } from '../src/auth/service.js';

const dbPath = process.env.CA_DB_PATH?.trim() ?? '';
const loginName = process.env.CA_ADMIN_LOGIN?.trim() ?? '';
const displayName = process.env.CA_ADMIN_NAME?.trim() ?? '';

if (!dbPath || !loginName || !displayName) {
  console.error('缺少必填环境变量：CA_DB_PATH / CA_ADMIN_LOGIN / CA_ADMIN_NAME');
  process.exit(2);
}

const db = new CourseDatabase(dbPath);
const auth = new AuthService(db);
try {
  const result = auth.bootstrapAdmin({ loginName, displayName });
  console.log('已创建系统管理员。');
  console.log(`  账号：${loginName}`);
  console.log(`  一次性初始口令：${result.initialPassword}`);
  console.log('首次登录后必须立即修改；此口令不再显示。');
} catch (error) {
  console.error(`初始化失败：${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
