/**
 * 备份：生成一致性快照 + 清单。
 * 用法：CA_DB_PATH=/data/ca.sqlite CA_BACKUP_DIR=/data/backup npm run backup
 */

import { CourseDatabase } from '../src/store/database.js';
import { createBackup } from '../src/backup/service.js';
import { resolve, sep } from 'node:path';

const dbPath = process.env.CA_DB_PATH?.trim() ?? '';
const dir = process.env.CA_BACKUP_DIR?.trim() ?? '';
if (!dbPath || !dir) {
  console.error('缺少必填环境变量：CA_DB_PATH / CA_BACKUP_DIR');
  process.exit(2);
}
const dbAbs = resolve(dbPath);
const dirAbs = resolve(dir);
if (dbAbs === dirAbs || dbAbs.startsWith(`${dirAbs}${sep}`)) {
  console.error('备份目录不能包含正在使用的数据库文件（否则备件与活库混放，恢复时易误覆盖）');
  process.exit(2);
}

const db = new CourseDatabase(dbPath);
try {
  const result = createBackup(db, dir, new Date().toISOString());
  console.log(`备份完成：${dir}/${result.manifest.dbFile}`);
  console.log(`  sha256=${result.manifest.sha256}`);
  console.log(`  审计条数=${result.manifest.tally.auditLength}　末哈希=${result.manifest.tally.auditLastHash ?? '（空）'}`);
  console.log('  备份含个人材料，请存放在受控介质并限制访问。');
} finally {
  db.close();
}
