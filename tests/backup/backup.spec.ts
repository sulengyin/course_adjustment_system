import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup, verifyBackup } from '../../src/backup/service.js';
import { TimetableService } from '../../src/service/timetable-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

let db: CourseDatabase;
let dir: string;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 模拟"改完文件再改 sha"：只更新 manifest 的 sha/字节数，保留原对账清单。 */
function reseal(dbPath: string): void {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.sha256 = sha256File(dbPath);
  manifest.bytes = statSync(dbPath).size;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca-backup-'));
  db = new CourseDatabase(':memory:');
  const timetable = new TimetableService(db);
  timetable.load(DEMO_SNAPSHOT);
  timetable.build(DEMO_SNAPSHOT.term.id, '2026-08-31', '2026-12-31');
  db.handle.prepare("INSERT INTO teacher(id, display_name, data_origin) VALUES('T-AUDIT','审计样本','SIMULATED')").run();
  db.auditLog.append({
    at: '2026-11-01T00:00:00.000Z',
    actor: 'SYSTEM',
    action: 'TEST_EVENT',
    objectType: 'TEST',
    objectId: 'X',
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('备份与对账', () => {
  it('清单记录备份副本的真实内容，校验通过', () => {
    const result = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    expect(result.manifest.tally.teachers).toBeGreaterThan(0);
    expect(result.manifest.tally.auditLength).toBe(1);
    expect(result.manifest.schemaVersion).toBe('p6-1');
    expect(result.manifest.formatVersion).toBe(2);

    const verified = verifyBackup(dir);
    expect(verified.ok, JSON.stringify(verified.problems)).toBe(true);
    expect(verified.diffs).toEqual([]);
  });

  it('恢复到新路径后对账一致', () => {
    createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const target = join(dir, 'restored.sqlite');
    const restored = restoreBackup(dir, target);
    expect(restored.ok, JSON.stringify(restored.problems)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('默认拒绝覆盖已有文件', () => {
    createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const target = join(dir, 'existing.sqlite');
    writeFileSync(target, 'not a database');
    const restored = restoreBackup(dir, target);
    expect(restored.ok).toBe(false);
    expect(restored.problems).toContain('TARGET_EXISTS');
    expect(readFileSync(target, 'utf8')).toBe('not a database');
  });

  it('文件被改动 → SHA_MISMATCH', () => {
    const backup = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const dbPath = join(dir, backup.manifest.dbFile);
    writeFileSync(dbPath, Buffer.concat([readFileSync(dbPath), Buffer.from([0])]));
    const verified = verifyBackup(dir);
    expect(verified.ok).toBe(false);
    expect(verified.problems).toContain('SHA_MISMATCH');
  });

  it('改审计行并同步改 sha → 审计链断开，仍被发现', () => {
    const backup = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const dbPath = join(dir, backup.manifest.dbFile);

    const copy = new CourseDatabase(dbPath);
    copy.handle.exec('DROP TRIGGER audit_event_no_update');
    copy.handle.prepare("UPDATE audit_event SET actor = 'FORGED' WHERE seq = 1").run();
    copy.close();
    reseal(dbPath);

    const verified = verifyBackup(dir);
    expect(verified.ok).toBe(false);
    expect(verified.problems).toContain('AUDIT_CHAIN_BROKEN');
    expect(verified.audit?.brokenAt).toBe(1);
  });

  it('截掉审计尾部并同步改 sha → 清单对账发现条数/末哈希不符', () => {
    const backup = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const dbPath = join(dir, backup.manifest.dbFile);

    const copy = new CourseDatabase(dbPath);
    copy.handle.prepare('DELETE FROM audit_event WHERE seq = 1').run();
    copy.close();
    reseal(dbPath);

    const verified = verifyBackup(dir);
    expect(verified.ok).toBe(false);
    expect(verified.audit?.ok).toBe(true); // 链本身自洽
    expect(verified.problems).toContain('TALLY_MISMATCH');
    expect(verified.diffs.map((d) => d.key)).toContain('auditLength');
  });

  it('清单缺失时拒绝恢复', () => {
    createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    rmSync(join(dir, 'manifest.json'));
    const verified = verifyBackup(dir);
    expect(verified.ok).toBe(false);
    expect(verified.problems).toContain('MANIFEST_MISSING');
    expect(restoreBackup(dir, join(dir, 'x.sqlite')).ok).toBe(false);
  });

  it('清单形状不合法时按不可读处理，不抛异常', () => {
    const backup = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.tally = { teachers: 'many' };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const verified = verifyBackup(dir);
    expect(verified.ok).toBe(false);
    expect(verified.problems).toContain('MANIFEST_UNREADABLE');
    expect(restoreBackup(dir, join(dir, 'y.sqlite')).ok).toBe(false);
    expect(existsSync(join(dir, backup.manifest.dbFile))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('备份与恢复出的库文件权限固定为 0600', () => {
    const backup = createBackup(db, dir, '2026-11-01T12:00:00.000Z');
    expect(statSync(join(dir, backup.manifest.dbFile)).mode & 0o777).toBe(0o600);

    const target = join(dir, 'restored-mode.sqlite');
    expect(restoreBackup(dir, target).ok).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
