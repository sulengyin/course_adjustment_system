/**
 * 备份与恢复。
 *
 * 关键约束：
 *  - 备份用 `VACUUM INTO` 生成一致性快照，不直接拷贝运行中的数据库文件。
 *  - manifest 记录 sha256、字节数与对账清单（含审计链长度与末哈希），
 *    它是"整段尾部被截断"唯一能被发现的锚点。
 *  - 恢复前必须通过校验；覆盖已有文件必须显式声明。
 *  - 备份文件含个人理由与账号信息，权限固定 0600，存放位置由校方指定。
 */

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CourseDatabase } from '../store/database.js';
import { CourseDatabase as Database } from '../store/database.js';
import { type Tally, TALLY_KEYS, diffTally, tally, type TallyDiff } from './reconcile.js';
export interface BackupManifest {
  readonly formatVersion: 2;
  readonly createdAt: string;
  readonly schemaVersion: string;
  readonly dbFile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly tally: Tally;
}

export interface BackupResult {
  readonly dir: string;
  readonly manifest: BackupManifest;
}

export type VerifyProblem =
  | 'MANIFEST_MISSING'
  | 'MANIFEST_UNREADABLE'
  | 'DB_MISSING'
  | 'SHA_MISMATCH'
  | 'AUDIT_CHAIN_BROKEN'
  | 'TALLY_MISMATCH'
  | 'TARGET_EXISTS';

export interface VerifyResult {
  readonly ok: boolean;
  readonly problems: readonly VerifyProblem[];
  readonly diffs: readonly TallyDiff[];
  readonly manifest: BackupManifest | null;
  readonly audit: { readonly ok: boolean; readonly length: number; readonly brokenAt: number | null } | null;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly problems: readonly VerifyProblem[];
  readonly target: string;
  readonly diffs: readonly TallyDiff[];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

export function createBackup(db: CourseDatabase, dir: string, createdAt: string): BackupResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = createdAt.replace(/[:.]/g, '-');
  const dbFile = `backup-${stamp}.sqlite`;
  const dbPath = join(dir, dbFile);
  if (existsSync(dbPath)) throw new Error(`备份文件已存在：${dbPath}`);

  db.handle.exec(`VACUUM INTO ${quote(dbPath)}`);
  // 备份里含请假理由、口令哈希与账号信息；VACUUM INTO 生成的文件跟随 umask，
  // 在宽松环境下会是 0644，必须显式收紧。
  chmodSync(dbPath, 0o600);

  // 清单从"备份副本"读取，而不是从源库读取：确保记录的是备份里真实的内容。
  const copy = new Database(dbPath);
  let copyTally: Tally;
  let schemaVersion: string;
  try {
    copyTally = tally(copy);
    schemaVersion = String(copy.getMeta('schema_version') ?? 'unknown');
  } finally {
    copy.close();
  }

  const manifest: BackupManifest = {
    formatVersion: 2,
    createdAt,
    schemaVersion,
    dbFile,
    sha256: sha256File(dbPath),
    bytes: statSync(dbPath).size,
    tally: copyTally,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, manifest };
}

function readManifest(dir: string): BackupManifest | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return isManifest(parsed) ? parsed : null;
}

/**
 * 清单是外部文件，可能被手工编辑或来自旧版本。形状不合格时按"不可读"处理，
 * 不能让 `manifest.tally.teachers` 之类在后续对账里抛 TypeError —— 那会把
 * "备份不可信"伪装成"程序崩溃"。
 */
function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (m.formatVersion !== 2) return false;
  if (typeof m.dbFile !== 'string' || m.dbFile === '') return false;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return false;
  if (typeof m.bytes !== 'number' || !Number.isInteger(m.bytes) || m.bytes < 0) return false;
  const t = m.tally;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return false;
  const tally = t as Record<string, unknown>;
  for (const key of TALLY_KEYS) {
    const v = tally[key];
    if (key === 'auditLastHash') {
      if (v !== null && typeof v !== 'string') return false;
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return false;
  }
  return true;
}

export function verifyBackup(dir: string): VerifyResult {
  const problems: VerifyProblem[] = [];
  const manifest = readManifest(dir);
  if (!manifest) {
    return {
      ok: false,
      problems: [existsSync(join(dir, 'manifest.json')) ? 'MANIFEST_UNREADABLE' : 'MANIFEST_MISSING'],
      diffs: [],
      manifest: null,
      audit: null,
    };
  }
  const dbPath = join(dir, manifest.dbFile);
  if (!existsSync(dbPath)) {
    return { ok: false, problems: ['DB_MISSING'], diffs: [], manifest, audit: null };
  }

  const actualSha = sha256File(dbPath);
  if (actualSha !== manifest.sha256 || statSync(dbPath).size !== manifest.bytes) {
    problems.push('SHA_MISMATCH');
  }

  // 即使 sha 对得上，也要重算审计链与清单：防止"改完文件再改 sha"。
  const copy = new Database(dbPath);
  let actualTally: Tally;
  let chainOk = false;
  let brokenAt: number | null = null;
  try {
    const chain = copy.auditLog.verify();
    chainOk = chain.ok;
    brokenAt = chain.brokenAt;
    if (!chain.ok) problems.push('AUDIT_CHAIN_BROKEN');
    actualTally = tally(copy);
  } finally {
    copy.close();
  }

  const diffs = diffTally(manifest.tally, actualTally);
  if (diffs.length > 0) problems.push('TALLY_MISMATCH');

  return {
    ok: problems.length === 0,
    problems,
    diffs,
    manifest,
    audit: { ok: chainOk, length: actualTally.auditLength, brokenAt },
  };
}

/**
 * 恢复到目标路径。默认拒绝覆盖——覆盖生产库是不可逆操作。
 * 恢复前先校验，校验不过一律不动目标文件。
 */
export function restoreBackup(dir: string, targetPath: string, options: { overwrite?: boolean } = {}): RestoreResult {
  const verified = verifyBackup(dir);
  if (!verified.ok || !verified.manifest) {
    return { ok: false, problems: verified.problems, target: targetPath, diffs: verified.diffs };
  }
  if (existsSync(targetPath) && options.overwrite !== true) {
    return { ok: false, problems: ['TARGET_EXISTS'], target: targetPath, diffs: [] };
  }
  copyFileSync(join(dir, verified.manifest.dbFile), targetPath);
  chmodSync(targetPath, 0o600);

  // 恢复后再算一次，确认落盘内容与清单一致
  const restored = new Database(targetPath);
  let diffs: TallyDiff[];
  try {
    diffs = diffTally(verified.manifest.tally, tally(restored));
  } finally {
    restored.close();
  }
  return { ok: diffs.length === 0, problems: diffs.length === 0 ? [] : ['TALLY_MISMATCH'], target: targetPath, diffs };
}
