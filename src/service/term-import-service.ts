/**
 * 真实学期与作息导入。
 *
 * 为什么单独做入口：作息是课表时间的唯一来源（`src/domain/generate.ts` 按 period 查
 * bell，查不到就标 BELL_NOT_CONFIGURED），没有它导入的课表只能得到"时间未知"。
 *
 * 三条约束：
 *  1. 只允许课务管理人员（IMPORT_TIMETABLE）执行——作息属于课表基础资料，不是账号管理。
 *  2. 库里已有学期就拒绝：学期一旦被模板/课次引用，覆盖会让历史课表的时间重新解释。
 *  3. 真实作息只标 IMPORTED_UNVERIFIED，不冒充 OFFICIAL。
 *
 * 不做的：大课间、眼保健操、午餐午休这些非课节时段不入 bell。
 * bell 的语义是"第 N 节几点到几点"，把课间塞进去会被课表当成一节课。
 */

import type { CourseDatabase } from '../store/database.js';
import type { AuthService } from '../auth/service.js';
import type { Principal } from '../auth/principal.js';
import type { BellEntry, DataOrigin, WeekParity } from '../domain/model.js';

export interface TermImportInput {
  readonly label: string;
  readonly startMonday: string;
  readonly endDate: string;
  /** null = 学校未声明第一周单双周；不得默认按单周 */
  readonly firstWeekParity: WeekParity | null;
  readonly bells: readonly BellEntry[];
}

export interface TermImportResult {
  readonly termId: string;
  readonly periods: number;
  readonly dataOrigin: DataOrigin;
}

export type TermRejectCode =
  | 'EMPTY_LABEL'
  | 'BAD_DATE'
  | 'START_NOT_MONDAY'
  | 'END_BEFORE_START'
  | 'BAD_PARITY'
  | 'EMPTY_BELL'
  | 'BAD_PERIOD'
  | 'PERIOD_NOT_SEQUENTIAL'
  | 'BAD_TIME'
  | 'END_NOT_AFTER_START'
  | 'TERM_EXISTS';

export class TermImportError extends Error {
  constructor(
    readonly code: TermRejectCode,
    message: string,
  ) {
    super(message);
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDate(value: string): Date | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // 拒绝 2026-02-31 这类被 Date 自动进位的日期
  return d.toISOString().slice(0, 10) === value ? d : null;
}

export class TermImportService {
  private readonly now: () => string;

  constructor(
    private readonly db: CourseDatabase,
    private readonly auth: AuthService,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
  }

  import(principal: Principal, input: TermImportInput): TermImportResult {
    this.auth.requireAction(principal, 'IMPORT_TIMETABLE');

    const label = input.label.trim();
    if (label === '') throw new TermImportError('EMPTY_LABEL', '学期名称不能为空');

    const start = parseDate(input.startMonday);
    if (start === null) throw new TermImportError('BAD_DATE', `起始周一格式应为 YYYY-MM-DD：${input.startMonday}`);
    // getUTCDay: 0=周日, 1=周一
    if (start.getUTCDay() !== 1) {
      throw new TermImportError('START_NOT_MONDAY', `起始日必须是周一：${input.startMonday} 是周${'日一二三四五六'[start.getUTCDay()]}`);
    }

    const end = parseDate(input.endDate);
    if (end === null) throw new TermImportError('BAD_DATE', `结束日期格式应为 YYYY-MM-DD：${input.endDate}`);
    if (end.getTime() < start.getTime()) {
      throw new TermImportError('END_BEFORE_START', `结束日期不能早于起始周一：${input.endDate} < ${input.startMonday}`);
    }

    if (input.firstWeekParity !== null && input.firstWeekParity !== 'ODD' && input.firstWeekParity !== 'EVEN') {
      throw new TermImportError('BAD_PARITY', `第一周单双周只能是 ODD / EVEN / 未声明：${String(input.firstWeekParity)}`);
    }

    if (input.bells.length === 0) throw new TermImportError('EMPTY_BELL', '作息为空：至少要有一节课的时间');

    const periods = [...input.bells].map((b) => b.period).sort((a, b) => a - b);
    for (const p of periods) {
      if (!Number.isInteger(p) || p < 1) throw new TermImportError('BAD_PERIOD', `节次必须是正整数：${p}`);
    }
    for (let i = 0; i < periods.length; i += 1) {
      if (periods[i] !== i + 1) {
        throw new TermImportError('PERIOD_NOT_SEQUENTIAL', `节次必须从 1 连续编号，缺第 ${i + 1} 节`);
      }
    }

    for (const b of input.bells) {
      if (b.startsAt === null || !TIME_RE.test(b.startsAt)) {
        throw new TermImportError('BAD_TIME', `第 ${b.period} 节开始时间格式应为 HH:MM：${String(b.startsAt)}`);
      }
      if (b.endsAt === null || !TIME_RE.test(b.endsAt)) {
        throw new TermImportError('BAD_TIME', `第 ${b.period} 节结束时间格式应为 HH:MM：${String(b.endsAt)}`);
      }
      if (b.endsAt <= b.startsAt) {
        throw new TermImportError(
          'END_NOT_AFTER_START',
          `第 ${b.period} 节结束时间必须晚于开始时间：${b.startsAt}–${b.endsAt}`,
        );
      }
    }

    if (this.db.countTerms() > 0) {
      throw new TermImportError('TERM_EXISTS', '库中已有学期。学期被课表引用后不能覆盖，需另建库或先做显式迁移');
    }

    const termId = `TERM-${input.startMonday}`;
    const at = this.now();
    this.db.transaction(() => {
      this.db.insertTerm({
        id: termId,
        label,
        startMonday: input.startMonday,
        endDate: input.endDate,
        firstWeekParity: input.firstWeekParity,
        dataOrigin: 'IMPORTED_UNVERIFIED',
      });
      this.db.insertBell(termId, input.bells, 'IMPORTED_UNVERIFIED');
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'IMPORT_TERM',
        objectType: 'TERM',
        objectId: termId,
        afterState: 'IMPORTED_UNVERIFIED',
        reason: `真实作息导入：${label}，${input.bells.length} 节课，${input.startMonday}–${input.endDate}`,
      });
    });

    return { termId, periods: input.bells.length, dataOrigin: 'IMPORTED_UNVERIFIED' };
  }
}
