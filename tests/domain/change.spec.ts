import { describe, expect, it } from 'vitest';
import {
  type Assignment,
  type ChangeItem,
  type ConfirmationRecord,
  canTransition,
  classifyCorrection,
  confirmationState,
  projectChange,
} from '../../src/domain/change.js';

function occ(
  id: string,
  classId: string,
  teacherId: string,
  date: string,
  period: number,
): Assignment {
  return {
    occurrenceId: id,
    classId,
    subjectId: `S-${id}`,
    teacherId,
    date,
    period,
    cancelled: false,
  };
}

function reassign(id: string, toTeacherId: string): ChangeItem {
  return {
    occurrenceId: id,
    kind: 'REASSIGN',
    toTeacherId,
    toDate: null,
    toPeriod: null,
  };
}

function move(id: string, toDate: string, toPeriod: number): ChangeItem {
  return {
    occurrenceId: id,
    kind: 'MOVE',
    toTeacherId: null,
    toDate,
    toPeriod,
  };
}

function cancel(id: string): ChangeItem {
  return {
    occurrenceId: id,
    kind: 'CANCEL',
    toTeacherId: null,
    toDate: null,
    toPeriod: null,
  };
}

describe('必要确认者由责任变化计算', () => {
  it('改派：原教师与新教师都必须确认', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [reassign('O1', 'T-ZHANG')]);
    expect(p.errors).toEqual([]);
    expect(p.required).toEqual(['T-LI', 'T-ZHANG']);
  });

  it('调时间：该教师必须确认（授课责任内容改变）', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [move('O1', '2026-09-08', 3)]);
    expect(p.errors).toEqual([]);
    expect(p.required).toEqual(['T-LI']);
  });

  it('取消：原教师必须确认', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [cancel('O1')]);
    expect(p.errors).toEqual([]);
    expect(p.required).toEqual(['T-LI']);
    expect(p.after[0]?.cancelled).toBe(true);
  });

  it('两人互换时段：双方确认，且不产生冲突', () => {
    const before = [
      occ('O1', 'C1', 'T-LI', '2026-09-07', 2),
      occ('O2', 'C1', 'T-WANG', '2026-09-08', 3),
    ];
    const p = projectChange(before, [
      move('O1', '2026-09-08', 3),
      move('O2', '2026-09-07', 2),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.required).toEqual(['T-LI', 'T-WANG']);
  });
});

describe('目标时段已有课：不是拒绝理由，而是方案必须写完整', () => {
  it('只把课调进已占用时段、不安排原课去向 → 报结构性冲突', () => {
    const before = [
      occ('O1', 'C1', 'T-LI', '2026-09-07', 2),
      occ('O2', 'C1', 'T-WANG', '2026-09-08', 3),
    ];
    const p = projectChange(before, [move('O1', '2026-09-08', 3)]);
    expect(p.errors.map((e) => e.code)).toContain('CLASS_SLOT_CONFLICT');
    expect(p.errors.every((e) => e.preExisting === false)).toBe(true);
    // 方案不完整时，只对真正被改动的教师提确认要求
    expect(p.required).toEqual(['T-LI']);
  });

  it('同样落点，但把原课取消 → 冲突消失，原教师进入确认集合', () => {
    const before = [
      occ('O1', 'C1', 'T-LI', '2026-09-07', 2),
      occ('O2', 'C1', 'T-WANG', '2026-09-08', 3),
    ];
    const p = projectChange(before, [
      move('O1', '2026-09-08', 3),
      cancel('O2'),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.required).toEqual(['T-LI', 'T-WANG']);
  });
});

describe('结构性冲突检测', () => {
  it('调过去后同一教师同时段有两节课 → 教师冲突', () => {
    const before = [
      occ('O1', 'C1', 'T-LI', '2026-09-07', 2),
      occ('O3', 'C2', 'T-LI', '2026-09-08', 3),
    ];
    const p = projectChange(before, [move('O1', '2026-09-08', 3)]);
    expect(p.errors.map((e) => e.code)).toContain('TEACHER_SLOT_CONFLICT');
  });

  it('变更前已存在的冲突被标记为 preExisting，不与本次方案混为一谈', () => {
    const before = [
      occ('O1', 'C1', 'T-LI', '2026-09-07', 2),
      occ('O2', 'C1', 'T-WANG', '2026-09-07', 2),
    ];
    const p = projectChange(before, [cancel('O1')]);
    expect(p.errors.every((e) => e.preExisting)).toBe(true);
  });
});

describe('方案自身不完整或无效', () => {
  it('同一课次出现两次 → DUPLICATE_ITEM', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [reassign('O1', 'T-A'), cancel('O1')]);
    expect(p.errors.map((e) => e.code)).toContain('DUPLICATE_ITEM');
  });

  it('课次不存在 → OCCURRENCE_NOT_FOUND', () => {
    const p = projectChange([], [cancel('O-404')]);
    expect(p.errors[0]?.code).toBe('OCCURRENCE_NOT_FOUND');
  });

  it('无变化 → NO_OP，且不产生确认者', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [move('O1', '2026-09-07', 2)]);
    expect(p.errors[0]?.code).toBe('NO_OP');
    expect(p.required).toEqual([]);
  });

  it('非法日期 2026-02-30 被拒绝，不被当作合法目标', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [move('O1', '2026-02-30', 2)]);
    expect(p.errors[0]?.code).toBe('INVALID_DATE');
  });
});

describe('班主任只通知，不自动成为确认者', () => {
  it('班主任不在 required，但出现在 notified', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [reassign('O1', 'T-ZHANG')], {
      C1: 'T-HEAD',
    });
    expect(p.required).toEqual(['T-LI', 'T-ZHANG']);
    expect(p.notified).toEqual(['T-HEAD']);
    expect(p.required).not.toContain('T-HEAD');
  });

  it('班主任本人责任被改变时，因教师身份进入 required', () => {
    const before = [occ('O1', 'C1', 'T-HEAD', '2026-09-07', 2)];
    const p = projectChange(before, [reassign('O1', 'T-ZHANG')], {
      C1: 'T-HEAD',
    });
    expect(p.required).toContain('T-HEAD');
    expect(p.notified).toEqual([]);
  });

  it('班主任未配置时显式暴露，不假装已通知', () => {
    const before = [occ('O1', 'C1', 'T-LI', '2026-09-07', 2)];
    const p = projectChange(before, [cancel('O1')]);
    expect(p.notified).toEqual([]);
    expect(p.notifiedUnknownClasses).toEqual(['C1']);
  });
});

describe('确认状态：沉默与旧版本都不算同意', () => {
  const required = ['T-A', 'T-B'];

  function rec(
    teacherId: string,
    revision: number,
    decision: 'ACCEPT' | 'DECLINE',
  ): ConfirmationRecord {
    return { teacherId, revision, decision };
  }

  it('无人答复 → PENDING', () => {
    expect(confirmationState(required, 2, []).state).toBe(
      'PENDING_CONFIRMATION',
    );
  });

  it('一人接受、一人沉默 → 仍为 PENDING', () => {
    const s = confirmationState(required, 2, [rec('T-A', 2, 'ACCEPT')]);
    expect(s.state).toBe('PENDING_CONFIRMATION');
    expect(s.missing).toEqual(['T-B']);
  });

  it('一人明确拒绝 → DECLINED，即使其他人未答复', () => {
    const s = confirmationState(required, 2, [rec('T-B', 2, 'DECLINE')]);
    expect(s.state).toBe('DECLINED');
  });

  it('确认后方案改版 → STALE，必须重新确认', () => {
    const s = confirmationState(required, 3, [
      rec('T-A', 2, 'ACCEPT'),
      rec('T-B', 2, 'ACCEPT'),
    ]);
    expect(s.state).toBe('STALE_CONFIRMATION');
    expect(s.stale).toEqual(['T-A', 'T-B']);
  });

  it('旧版本接受 + 当前版本拒绝 → DECLINED 优先', () => {
    const s = confirmationState(required, 3, [
      rec('T-A', 2, 'ACCEPT'),
      rec('T-A', 3, 'DECLINE'),
      rec('T-B', 3, 'ACCEPT'),
    ]);
    expect(s.state).toBe('DECLINED');
  });

  it('全部当前版本接受 → READY', () => {
    const s = confirmationState(required, 3, [
      rec('T-A', 3, 'ACCEPT'),
      rec('T-B', 3, 'ACCEPT'),
    ]);
    expect(s.state).toBe('READY_TO_APPLY');
  });
});

describe('纠错分类', () => {
  const current = occ('O1', 'C1', 'T-LI', '2026-09-07', 2);

  it('改变授课责任的纠错一律要求新方案', () => {
    const r = classifyCorrection(current, {
      teacherId: 'T-ZHANG',
      classId: null,
      subjectId: null,
      date: null,
      period: null,
    });
    expect(r.kind).toBe('REQUIRES_NEW_PROPOSAL');
    expect(r.changedFields).toEqual(['teacherId']);
  });

  it('未改变责任时不放行：白名单未配置 → TBD_CORRECTION_SCOPE', () => {
    const r = classifyCorrection(current, {
      teacherId: null,
      classId: null,
      subjectId: null,
      date: null,
      period: null,
    });
    expect(r.kind).toBe('TBD_CORRECTION_SCOPE');
  });
});

describe('状态机', () => {
  it('已生效不可回退或删除', () => {
    expect(canTransition('EFFECTIVE', 'DRAFT')).toBe(false);
    expect(canTransition('EFFECTIVE', 'PENDING_CONFIRMATION')).toBe(false);
  });

  it('不得跳过冲突复核直接生效', () => {
    expect(canTransition('PENDING_CONFIRMATION', 'EFFECTIVE')).toBe(false);
    expect(canTransition('BLOCKED_CONFLICT', 'EFFECTIVE')).toBe(false);
  });

  it('允许的路径存在', () => {
    expect(canTransition('DRAFT', 'PENDING_CONFIRMATION')).toBe(true);
    expect(canTransition('PENDING_CONFIRMATION', 'APPLYING')).toBe(true);
    expect(canTransition('APPLYING', 'EFFECTIVE')).toBe(true);
    expect(canTransition('PENDING_CONFIRMATION', 'WITHDRAWN')).toBe(true);
  });
});
