import { addDays, formatDate, parseDate } from '../../src/domain/calendar.js';
import type {
  BellEntry,
  CalendarException,
  ExceptionKind,
  SchoolClass,
  SchoolSnapshot,
  Subject,
  Teacher,
  TeachingTemplate,
  Weekday,
} from '../../src/domain/model.js';

/** 确定性伪随机，失败可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomCase {
  readonly snapshot: SchoolSnapshot;
  readonly from: string;
  readonly to: string;
  readonly teacherIds: readonly string[];
  readonly classIds: readonly string[];
}

const MONDAYS = ['2026-08-31', '2027-02-22', '2027-09-06', '2028-02-28'];

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rnd() * arr.length)];
  if (v === undefined) throw new Error('empty array');
  return v;
}

function intBetween(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

export function buildRandomCase(seed: number): RandomCase {
  const rnd = mulberry32(seed);
  const termId = `TERM-P-${seed}`;
  const startMonday = pick(rnd, MONDAYS);
  const weeks = intBetween(rnd, 3, 8);
  const endDate = addDays(startMonday, weeks * 7 - 3);
  const firstWeekParity = pick(rnd, ['ODD', 'EVEN', null] as const);

  const teachers: Teacher[] = Array.from({ length: 4 }, (_, i) => ({
    id: `T${i + 1}`,
    displayName: `教师${i + 1}`,
    dataOrigin: 'SIMULATED' as const,
  }));
  const classes: SchoolClass[] = Array.from({ length: 3 }, (_, i) => ({
    id: `C${i + 1}`,
    displayName: `班级${i + 1}`,
    grade: '一年级',
    dataOrigin: 'SIMULATED' as const,
  }));
  const subjects: Subject[] = Array.from({ length: 4 }, (_, i) => ({
    id: `S${i + 1}`,
    name: `学科${i + 1}`,
    dataOrigin: 'SIMULATED' as const,
  }));

  const bell: BellEntry[] = [];
  for (let period = 1; period <= 5; period++) {
    const roll = rnd();
    if (roll < 0.15) continue; // 完全缺该节次
    if (roll < 0.3) bell.push({ period, startsAt: `0${8 + period}:00`, endsAt: null });
    else bell.push({ period, startsAt: `0${8 + period}:00`, endsAt: `0${8 + period}:40` });
  }
  if (bell.length === 0) bell.push({ period: 1, startsAt: '08:00', endsAt: '08:40' });

  const exceptions: CalendarException[] = [];
  let exSeq = 0;
  const totalDays = weeks * 7;
  for (let d = 0; d < totalDays; d++) {
    if (rnd() > 0.06) continue;
    const date = addDays(startMonday, d);
    const kind = pick(rnd, ['HOLIDAY', 'MAKEUP_DAY', 'SUSPENDED'] as const) as ExceptionKind;
    exSeq += 1;
    exceptions.push({
      id: `EX-${seed}-${exSeq}`,
      termId,
      date,
      kind,
      followsWeekday: kind === 'MAKEUP_DAY' ? (rnd() < 0.8 ? (pick(rnd, [1, 2, 3, 4, 5]) as Weekday) : null) : null,
      suspendedPeriods:
        kind === 'SUSPENDED' ? (rnd() < 0.8 ? [intBetween(rnd, 1, 5)] : null) : null,
      reason: null,
      dataOrigin: 'SIMULATED',
    });
  }

  const templates: TeachingTemplate[] = [];
  const count = intBetween(rnd, 8, 16);
  for (let i = 0; i < count; i++) {
    const validTo =
      rnd() < 0.25 ? formatDate(new Date(parseDate(startMonday).getTime() + (totalDays - 5) * 86400000)) : null;
    templates.push({
      id: `TP-${seed}-${i + 1}`,
      termId,
      classId: pick(rnd, classes).id,
      teacherId: pick(rnd, teachers).id,
      subjectId: pick(rnd, subjects).id,
      weekday: pick(rnd, [1, 2, 3, 4, 5] as const) as Weekday,
      period: intBetween(rnd, 1, 5),
      parity: pick(rnd, ['ALL', 'ODD', 'EVEN'] as const),
      rotation: rnd() < 0.08 ? 'CUSTOM' : 'NONE',
      validFrom: null,
      validTo,
      dataOrigin: 'SIMULATED',
    });
  }

  return {
    snapshot: {
      term: {
        id: termId,
        label: `随机学期 ${seed}`,
        startMonday,
        endDate,
        firstWeekParity,
        dataOrigin: 'SIMULATED',
      },
      teachers,
      classes,
      subjects,
      bell,
      exceptions,
      templates,
    },
    from: startMonday,
    to: endDate,
    teacherIds: teachers.map((t) => t.id),
    classIds: classes.map((c) => c.id),
  };
}
