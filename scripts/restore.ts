/**
 * 恢复：先校验再覆盖；默认拒绝覆盖，必须显式 CA_OVERWRITE=1。
 * 用法：CA_BACKUP_DIR=/data/backup CA_DB_PATH=/data/ca-restored.sqlite npm run restore
 */

import { CourseDatabase } from '../src/store/database.js';
import { restoreBackup, verifyBackup } from '../src/backup/service.js';

const dir = process.env.CA_BACKUP_DIR?.trim() ?? '';
const target = process.env.CA_DB_PATH?.trim() ?? '';
if (!dir || !target) {
  console.error('缺少必填环境变量：CA_BACKUP_DIR / CA_DB_PATH');
  process.exit(2);
}

const verified = verifyBackup(dir);
if (!verified.ok) {
  console.error(`备份未通过校验，拒绝恢复：${verified.problems.join(',')}`);
  for (const diff of verified.diffs) {
    console.error(`  ${diff.key}: 清单=${String(diff.expected)} 实际=${String(diff.actual)}`);
  }
  process.exit(1);
}

const result = restoreBackup(dir, target, { overwrite: process.env.CA_OVERWRITE === '1' });
if (!result.ok) {
  console.error(`恢复失败：${result.problems.join(',')}`);
  process.exit(1);
}

const db = new CourseDatabase(target);
try {
  const chain = db.auditLog.verify();
  console.log(`恢复完成：${target}`);
  console.log(`  审计条数=${chain.length}　链完整=${chain.ok}　末哈希=${chain.lastHash ?? '（空）'}`);
  if (!chain.ok) {
    console.error(`审计链异常：brokenAt=${chain.brokenAt} ${chain.reason ?? ''}`);
    process.exitCode = 3;
  }
} finally {
  db.close();
}
