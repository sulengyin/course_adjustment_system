import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mintPrincipal } from '../src/auth/principal.js';
import { ChangeService } from '../src/service/change-service.js';
import { TimetableService } from '../src/service/timetable-service.js';
import { CourseDatabase } from '../src/store/database.js';
import { DEMO_SNAPSHOT } from '../src/store/fixtures.js';

const ROOT = new URL('../', import.meta.url).pathname;

describe('边界：身份只能由会话层签发', () => {
  it('src/ 下只有 auth 模块可以调用 mintPrincipal', () => {
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
        if (rel.startsWith('src/auth/')) continue;
        if (readFileSync(full, 'utf8').includes('mintPrincipal')) offenders.push(rel);
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('边界：私人理由不进入审计链', () => {
  it('方案理由留在业务表，不进审计', () => {
    const db = new CourseDatabase(':memory:');
    const timetable = new TimetableService(db);
    timetable.load(DEMO_SNAPSHOT);
    timetable.build(DEMO_SNAPSHOT.term.id, '2026-08-31', '2026-12-31');
    const changes = new ChangeService(db, { now: () => '2026-10-31T10:00:00.000Z' });

    const active = changes.activeAssignments(DEMO_SNAPSHOT.term.id).filter((a) => !a.cancelled);
    const first = active[0];
    const other = [...new Set(active.map((a) => a.teacherId))].find((t) => t !== first?.teacherId);
    if (!first || !other) throw new Error('虚构样本不足');

    const principal = mintPrincipal({
      userId: `U-${first.teacherId}`,
      teacherId: first.teacherId,
      displayName: first.teacherId,
      roles: ['T'],
      actingRole: 'T',
      sessionId: 'S-1',
      mustChangePassword: false,
    });

    changes.submitNew({
      termId: DEMO_SNAPSHOT.term.id,
      principal,
      items: [
        {
          occurrenceId: first.occurrenceId,
          kind: 'REASSIGN',
          toTeacherId: other,
          toDate: null,
          toPeriod: null,
        },
      ],
      reason: '家中老人住院需要陪护',
      idempotencyKey: 'IDEM-PRIVACY-1',
    });

    const leaked = db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE reason LIKE '%住院%' OR after_state LIKE '%住院%'")
      .get() as { n: number };
    expect(leaked.n).toBe(0);

    const stored = db.handle
      .prepare('SELECT reason FROM change_case WHERE idempotency_key = ?')
      .get('IDEM-PRIVACY-1') as { reason: string };
    expect(stored.reason).toBe('家中老人住院需要陪护');
    db.close();
  });
});
