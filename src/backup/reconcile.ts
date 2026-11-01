/**
 * 备份/恢复对账：只数事实，不做判断。
 * 判断"是否一致"由 verifyBackup 比对本文件产出的清单完成。
 */

import type { CourseDatabase } from '../store/database.js';

export interface Tally {
  readonly users: number;
  readonly teachers: number;
  readonly classes: number;
  readonly subjects: number;
  readonly terms: number;
  readonly templatesActive: number;
  readonly occurrences: number;
  readonly importBatches: number;
  readonly emergencyRequests: number;
  readonly changeCases: number;
  readonly confirmations: number;
  readonly effectiveChanges: number;
  readonly auditLength: number;
  readonly auditLastHash: string | null;
}

function count(db: CourseDatabase, sql: string): number {
  const row = db.handle.prepare(sql).get() as { n: number };
  return row.n;
}

export function tally(db: CourseDatabase): Tally {
  const chain = db.auditLog.verify();
  return {
    users: count(db, 'SELECT COUNT(*) AS n FROM app_user'),
    teachers: count(db, 'SELECT COUNT(*) AS n FROM teacher'),
    classes: count(db, 'SELECT COUNT(*) AS n FROM school_class'),
    subjects: count(db, 'SELECT COUNT(*) AS n FROM subject'),
    terms: count(db, 'SELECT COUNT(*) AS n FROM term'),
    templatesActive: count(db, 'SELECT COUNT(*) AS n FROM teaching_template WHERE revoked_at IS NULL'),
    occurrences: count(db, 'SELECT COUNT(*) AS n FROM occurrence'),
    importBatches: count(db, 'SELECT COUNT(*) AS n FROM import_batch'),
    emergencyRequests: count(db, 'SELECT COUNT(*) AS n FROM emergency_request'),
    changeCases: count(db, 'SELECT COUNT(*) AS n FROM change_case'),
    confirmations: count(db, 'SELECT COUNT(*) AS n FROM change_confirmation'),
    effectiveChanges: count(db, 'SELECT COUNT(*) AS n FROM effective_change'),
    auditLength: chain.length,
    auditLastHash: chain.lastHash,
  };
}

export const TALLY_KEYS: readonly (keyof Tally)[] = Object.freeze([
  'users',
  'teachers',
  'classes',
  'subjects',
  'terms',
  'templatesActive',
  'occurrences',
  'importBatches',
  'emergencyRequests',
  'changeCases',
  'confirmations',
  'effectiveChanges',
  'auditLength',
  'auditLastHash',
]);

export interface TallyDiff {
  readonly key: keyof Tally;
  readonly expected: number | string | null;
  readonly actual: number | string | null;
}

export function diffTally(expected: Tally, actual: Tally): TallyDiff[] {
  const out: TallyDiff[] = [];
  for (const key of TALLY_KEYS) {
    if (expected[key] !== actual[key]) {
      out.push({ key, expected: expected[key], actual: actual[key] });
    }
  }
  return out;
}
