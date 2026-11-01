import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CourseDatabase } from '../../src/store/database.js';
import { AuditLog } from '../../src/store/audit-log.js';

const ROOT = new URL('../../', import.meta.url).pathname;

function newDb(): CourseDatabase {
  return new CourseDatabase(':memory:');
}

describe('审计：append-only 与哈希链', () => {
  it('顺序追加形成链，verify 通过且长度正确', () => {
    const db = newDb();
    const log = new AuditLog(db.handle);
    for (let i = 0; i < 5; i += 1) {
      log.append({
        at: `2026-11-01T00:0${i}:00.000Z`,
        actor: 'U1',
        action: 'TEST',
        objectType: 'X',
        objectId: `obj-${i}`,
      });
    }
    const status = log.verify();
    expect(status.ok).toBe(true);
    expect(status.length).toBe(5);
    expect(status.lastHash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.tail()?.seq).toBe(5);
    db.close();
  });

  it('任何一行被修改，链在那一行断开', () => {
    const db = newDb();
    const log = new AuditLog(db.handle);
    log.append({ at: '2026-11-01T00:00:00.000Z', actor: 'U1', action: 'A', objectType: 'X', objectId: '1' });
    log.append({ at: '2026-11-01T00:01:00.000Z', actor: 'U1', action: 'B', objectType: 'X', objectId: '2' });
    log.append({ at: '2026-11-01T00:02:00.000Z', actor: 'U1', action: 'C', objectType: 'X', objectId: '3' });

    // 模拟磁盘层篡改：先绕过数据库触发器，再改第 2 行
    db.handle.exec('DROP TRIGGER audit_event_no_update');
    db.handle.prepare("UPDATE audit_event SET actor = 'U9' WHERE seq = 2").run();

    const status = log.verify();
    expect(status.ok).toBe(false);
    expect(status.brokenAt).toBe(2);
    expect(status.reason).toBe('HASH_MISMATCH');
    db.close();
  });

  it('数据库触发器直接拒绝修改审计行', () => {
    const db = newDb();
    new AuditLog(db.handle).append({
      at: '2026-11-01T00:00:00.000Z',
      actor: 'U1',
      action: 'A',
      objectType: 'X',
      objectId: '1',
    });
    expect(() => db.handle.prepare("UPDATE audit_event SET action = 'B' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    db.close();
  });

  it('删掉中间一行会被序号连续性发现', () => {
    const db = newDb();
    const log = new AuditLog(db.handle);
    for (let i = 0; i < 4; i += 1) {
      log.append({ at: '2026-11-01T00:00:00.000Z', actor: 'U1', action: 'A', objectType: 'X', objectId: String(i) });
    }
    db.handle.prepare('DELETE FROM audit_event WHERE seq = 2').run();
    const status = log.verify();
    expect(status.ok).toBe(false);
    expect(status.brokenAt).toBe(3);
    expect(status.reason).toBe('SEQUENCE_GAP');
    db.close();
  });

  it('尾部被截断时链本身看不出来，但备份锚点能发现（长度/末哈希不符）', () => {
    const db = newDb();
    const log = new AuditLog(db.handle);
    for (let i = 0; i < 3; i += 1) {
      log.append({ at: '2026-11-01T00:00:00.000Z', actor: 'U1', action: 'A', objectType: 'X', objectId: String(i) });
    }
    const anchor = { length: log.verify().length, lastHash: log.tail()?.hash ?? null };
    db.handle.prepare('DELETE FROM audit_event WHERE seq = 3').run();

    const after = log.verify();
    expect(after.ok).toBe(true); // 链本身仍然自洽
    expect(after.length).not.toBe(anchor.length); // 锚点比对能发现
    expect(after.lastHash).not.toBe(anchor.lastHash);
    db.close();
  });

  it('P5 之前的历史行会被封印，且封印后链自洽', () => {
    const db = newDb();
    db.handle.exec('DROP TRIGGER audit_event_no_update');
    db.handle
      .prepare(
        `INSERT INTO audit_event(seq, at, actor, action, object_type, object_id, before_state, after_state, reason)
         VALUES(1, '2026-10-01T00:00:00.000Z', 'OLD', 'LEGACY', 'X', '1', NULL, NULL, NULL)`,
      )
      .run();
    db.handle.exec(`CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
                    BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END`);

    const log = new AuditLog(db.handle);
    expect(log.verify().ok).toBe(false);
    expect(log.verify().reason).toBe('UNSEALED_ROW');

    expect(log.sealLegacy()).toBe(1);
    expect(log.verify().ok).toBe(true);
    log.append({ at: '2026-11-01T00:00:00.000Z', actor: 'NEW', action: 'AFTER', objectType: 'X', objectId: '2' });
    expect(log.verify().ok).toBe(true);
    db.close();
  });
});

describe('边界：审计只有一个写入口', () => {
  it('src/ 下只有 audit-log.ts 直接写 audit_event', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = relative(ROOT, full);
        if (rel === 'src/store/audit-log.ts') continue;
        const text = readFileSync(full, 'utf8');
        if (/INSERT\s+INTO\s+audit_event/i.test(text) || /UPDATE\s+audit_event/i.test(text)) {
          offenders.push(rel);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
