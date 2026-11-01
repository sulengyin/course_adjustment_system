import { describe, expect, it } from 'vitest';
import {
  INITIAL_COORDINATION_STATE,
  applyClaim,
  closeCase,
  displayStates,
  escalation,
  markNotified,
  missingClosureFields,
  overdueStatus,
  proxyRecord,
  ratificationStatus,
  responsibilityPlan,
  submitClosure,
  type CoordinationState,
  type EmergencyClaim,
} from '../../src/domain/emergency.js';

function claim(
  id: string,
  teacherId: string,
  source: 'ONLINE' | 'ORAL',
  at: string,
  confirmedAt: string | null = null,
): EmergencyClaim {
  return { id, teacherId, source, recordedAt: at, confirmedAt, recordedBy: teacherId };
}

const FULL_CLOSURE = {
  outcome: '已安排代课',
  summary: '联系同年级教师临时顶课，班级正常上课',
  responsiblePerson: 'T01',
  closedAt: '2026-09-07T08:10:00+08:00',
  contactRecord: '07:05 电话联系，07:12 回复同意',
};

function owned(teacherId = 'T02'): CoordinationState {
  return applyClaim(INITIAL_COORDINATION_STATE, claim('C-1', teacherId, 'ONLINE', '2026-09-07T07:10:00+08:00')).state;
}

describe('E1 五件事互不蕴含', () => {
  it('求助初始态：没有负责人、没有送达、没有结案、没有授课', () => {
    const s = INITIAL_COORDINATION_STATE;
    expect(s.status).toBe('REQUESTED');
    expect(s.ownerTeacherId).toBeNull();
    expect(s.provisionalTeacherId).toBeNull();
    expect(s.closureSubmittedAt).toBeNull();
    expect(s.teachingVerification).toBe('PENDING');
    expect(displayStates(s)).toEqual(['REQUESTED']);
  });

  it('有了负责人不等于结案，也不等于上过课', () => {
    const s = owned();
    expect(s.status).toBe('OWNED');
    expect(s.closureSubmittedAt).toBeNull();
    expect(s.teachingVerification).toBe('PENDING');
    expect(displayStates(s)).toEqual(['OWNED']);
  });

  it('提交结案不等于结案确认，也不等于授课核验', () => {
    const submitted = submitClosure(owned(), FULL_CLOSURE);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.state.status).toBe('CLOSURE_SUBMITTED');
    expect(submitted.state.teachingVerification).toBe('PENDING');
    expect(displayStates(submitted.state)).toEqual(['CLOSURE_SUBMITTED']);
  });
});

describe('E3 / E10 口头接受只能"暂有人协调"，本人追认才成为负责人', () => {
  it('口头登记后 owner 仍为空，只显示待追认', () => {
    const r = applyClaim(
      INITIAL_COORDINATION_STATE,
      claim('C-1', 'T02', 'ORAL', '2026-09-07T12:51:00+08:00', null),
    );
    expect(r.outcome).toBe('PROVISIONAL');
    expect(r.state.status).toBe('NO_OWNER');
    expect(r.state.ownerTeacherId).toBeNull();
    expect(r.state.provisionalTeacherId).toBe('T02');
  });

  it('本人补确认后成为负责人，且保留口头登记与确认两个时间', () => {
    const oral = applyClaim(
      INITIAL_COORDINATION_STATE,
      claim('C-1', 'T02', 'ORAL', '2026-09-07T12:51:00+08:00', null),
    ).state;
    const r = applyClaim(oral, claim('C-2', 'T02', 'ONLINE', '2026-09-07T12:56:00+08:00', '2026-09-07T12:56:00+08:00'));
    expect(r.outcome).toBe('OWNED');
    expect(r.state.ownerTeacherId).toBe('T02');
    expect(r.state.provisionalTeacherId).toBeNull();
    expect(r.state.claims.map((c) => c.recordedAt)).toEqual([
      '2026-09-07T12:51:00+08:00',
      '2026-09-07T12:56:00+08:00',
    ]);
    expect(r.state.claims[1]?.confirmedAt).toBe('2026-09-07T12:56:00+08:00');
  });

  it('追认期限未定：返回 NOT_CONFIGURED，不推断逾期', () => {
    expect(ratificationStatus()).toEqual({ code: 'NOT_CONFIGURED', blockedBy: ['O5'] });
  });
});

describe('E7 / V23-10 接单唯一性与来源冲突', () => {
  it('先有效在线接单者成为唯一负责人', () => {
    const first = applyClaim(INITIAL_COORDINATION_STATE, claim('C-1', 'T02', 'ONLINE', '2026-09-07T07:10:00+08:00'));
    expect(first.outcome).toBe('OWNED');
    expect(first.state.ownerTeacherId).toBe('T02');

    const second = applyClaim(first.state, claim('C-2', 'T03', 'ONLINE', '2026-09-07T07:11:00+08:00'));
    expect(second.outcome).toBe('ALREADY_OWNED');
    expect(second.state.ownerTeacherId).toBe('T02');
    expect(second.requiresAdjudication).toBe(false);
  });

  it('口头与在线来自不同人时保留双方来源，不按时间定序', () => {
    const oral = applyClaim(
      INITIAL_COORDINATION_STATE,
      claim('C-1', 'T03', 'ORAL', '2026-09-07T12:51:00+08:00', null),
    ).state;
    const r = applyClaim(oral, claim('C-2', 'T04', 'ONLINE', '2026-09-07T12:52:00+08:00'));
    expect(r.outcome).toBe('AMBIGUOUS');
    expect(r.state.status).toBe('AMBIGUOUS');
    expect(r.state.ownerTeacherId).toBeNull();
    expect(r.requiresAdjudication).toBe(true);
    expect(r.state.claims.map((c) => c.source)).toEqual(['ORAL', 'ONLINE']);
  });

  it('歧义状态不会被后到的接单自动消除', () => {
    const oral = applyClaim(
      INITIAL_COORDINATION_STATE,
      claim('C-1', 'T03', 'ORAL', '2026-09-07T12:51:00+08:00', null),
    ).state;
    const ambiguous = applyClaim(oral, claim('C-2', 'T04', 'ONLINE', '2026-09-07T12:52:00+08:00')).state;
    const r = applyClaim(ambiguous, claim('C-3', 'T05', 'ONLINE', '2026-09-07T12:53:00+08:00'));
    expect(r.outcome).toBe('AMBIGUOUS');
    expect(r.state.ownerTeacherId).toBeNull();
  });

  it('已通知只是人工记录的事实，不产生负责人', () => {
    const notified = markNotified(INITIAL_COORDINATION_STATE);
    expect(notified.status).toBe('NOTIFIED');
    expect(notified.ownerTeacherId).toBeNull();
  });
});

describe('E8 结案与授课事实核验分离', () => {
  it('结案完成但未核验授课时，两个状态同时成立', () => {
    const closed = closeCase(owned(), { teachingVerified: false });
    expect(closed.caseClosed).toBe(true);
    expect(closed.teachingStillPending).toBe(true);
    expect(closed.state.status).toBe('CLOSED');
    expect(closed.state.teachingVerification).toBe('PENDING');
    expect(displayStates(closed.state)).toEqual(['CLOSED', 'TEACHING_PENDING']);
  });

  it('只有显式核验才把授课标为已核验', () => {
    const closed = closeCase(owned(), { teachingVerified: true });
    expect(closed.teachingStillPending).toBe(false);
    expect(displayStates(closed.state)).toEqual(['CLOSED']);
  });

  it('没有负责人时不能提交结案', () => {
    const r = submitClosure(INITIAL_COORDINATION_STATE, FULL_CLOSURE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_COORDINATION_OWNER');
  });
});

describe('E9 结案必须记录五类事实', () => {
  it('缺项时逐项列出，不落库', () => {
    const missing = missingClosureFields({ outcome: '已安排代课', summary: '  ' });
    expect(missing).toEqual(['summary', 'responsiblePerson', 'closedAt', 'contactRecord']);

    const r = submitClosure(owned(), { outcome: '已安排代课' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('CLOSURE_FIELDS_MISSING');
    expect(r.missing).toEqual(['summary', 'responsiblePerson', 'closedAt', 'contactRecord']);
  });

  it('五项齐全时可以提交', () => {
    const r = submitClosure(owned(), FULL_CLOSURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.closureSubmittedAt).toBe(FULL_CLOSURE.closedAt);
  });
});

describe('E4 / E5 / E6 未决规则一律显式未配置', () => {
  it('补确认截止钟点未定：不返回 17:00 或 24:00', () => {
    expect(overdueStatus()).toEqual({ code: 'NOT_CONFIGURED', blockedBy: ['BIZ-04', 'TIME'] });
  });

  it('责任组/主责/代理/兜底岗位未定', () => {
    expect(responsibilityPlan()).toEqual({ code: 'NOT_CONFIGURED', blockedBy: ['E5'] });
  });

  it('主责拒绝时要求升级，但不指定代理', () => {
    expect(escalation({ primaryDeclined: false })).toEqual({ code: 'NO_ESCALATION', target: null });
    const r = escalation({ primaryDeclined: true });
    expect(r.code).toBe('NOT_CONFIGURED');
    expect(r.target).toBeNull();
    if (r.code === 'NOT_CONFIGURED') expect(r.blockedBy).toEqual(['E5']);
  });
});

describe('E11 代录不代确认', () => {
  it('代录只产生待本人确认，不计入本人确认', () => {
    const r = proxyRecord({
      recordedForTeacherId: 'T05',
      recordedByTeacherId: 'T02',
      teacherConfirmed: true,
    });
    expect(r.countsAsTeacherConfirmation).toBe(false);
    expect(r.pendingTeacherConfirmation).toBe(true);
    expect(r.state).toBe('PENDING_TEACHER_CONFIRMATION');
  });
});
