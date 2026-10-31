import type {
  BellEntry,
  CalendarException,
  SchoolClass,
  SchoolSnapshot,
  Subject,
  Teacher,
  TeachingTemplate,
  Term,
} from '../domain/model.js';

/**
 * 全部为虚构数据，不含任何真实学校、教师、班级信息。
 *
 * 这个数据集是故意"脏"的：它必须包含互相矛盾、缺失、无法判定的样本，
 * 否则测不出系统是否会拒绝错误数据。已知缺陷见 DEFECTS。
 */
export const DEMO_TERM: Term = {
  id: 'TERM-2026-FALL',
  label: '2026 学年第一学期（虚构）',
  startMonday: '2026-08-31',
  endDate: '2026-12-31',
  firstWeekParity: 'ODD',
  dataOrigin: 'SIMULATED',
};

export const DEMO_TEACHERS: readonly Teacher[] = [
  { id: 'T01', displayName: '示例教师甲', dataOrigin: 'SIMULATED' },
  { id: 'T02', displayName: '示例教师乙', dataOrigin: 'SIMULATED' },
  { id: 'T03', displayName: '示例教师丙', dataOrigin: 'SIMULATED' },
  { id: 'T04', displayName: '示例教师丁', dataOrigin: 'SIMULATED' },
];

export const DEMO_CLASSES: readonly SchoolClass[] = [
  { id: 'C1', displayName: '虚构一年一班', grade: '一年级', dataOrigin: 'SIMULATED' },
  { id: 'C2', displayName: '虚构一年二班', grade: '一年级', dataOrigin: 'SIMULATED' },
  { id: 'C3', displayName: '虚构二年一班', grade: '二年级', dataOrigin: 'SIMULATED' },
];

export const DEMO_SUBJECTS: readonly Subject[] = [
  { id: 'S-YW', name: '语文', dataOrigin: 'SIMULATED' },
  { id: 'S-SX', name: '数学', dataOrigin: 'SIMULATED' },
  { id: 'S-YY', name: '英语', dataOrigin: 'SIMULATED' },
  { id: 'S-TY', name: '体育', dataOrigin: 'SIMULATED' },
];

/** 第 5 节只有开始时间、没有结束时间：属于"确定有课、时间不确定" */
export const DEMO_BELL: readonly BellEntry[] = [
  { period: 1, startsAt: '08:00', endsAt: '08:40' },
  { period: 2, startsAt: '08:50', endsAt: '09:30' },
  { period: 3, startsAt: '09:50', endsAt: '10:30' },
  { period: 4, startsAt: '10:40', endsAt: '11:20' },
  { period: 5, startsAt: '13:30', endsAt: null },
];

export const DEMO_EXCEPTIONS: readonly CalendarException[] = [
  {
    id: 'EX-01',
    termId: DEMO_TERM.id,
    date: '2026-10-01',
    kind: 'HOLIDAY',
    followsWeekday: null,
    suspendedPeriods: null,
    reason: '法定假日',
    dataOrigin: 'SIMULATED',
  },
  {
    id: 'EX-02',
    termId: DEMO_TERM.id,
    date: '2026-10-10',
    kind: 'MAKEUP_DAY',
    followsWeekday: 4,
    suspendedPeriods: null,
    reason: '调休，按周四课表',
    dataOrigin: 'SIMULATED',
  },
  {
    id: 'EX-03',
    termId: DEMO_TERM.id,
    date: '2026-11-11',
    kind: 'SUSPENDED',
    followsWeekday: null,
    suspendedPeriods: [3, 4],
    reason: '校运会',
    dataOrigin: 'SIMULATED',
  },
  {
    id: 'EX-04',
    termId: DEMO_TERM.id,
    date: '2026-12-02',
    kind: 'MAKEUP_DAY',
    followsWeekday: null,
    suspendedPeriods: null,
    reason: '只通知了"当天上课"，没说按哪天的课表',
    dataOrigin: 'SIMULATED',
  },
  {
    id: 'EX-05',
    termId: DEMO_TERM.id,
    date: '2026-09-15',
    kind: 'HOLIDAY',
    followsWeekday: null,
    suspendedPeriods: null,
    reason: '与下一条重复登记',
    dataOrigin: 'SIMULATED',
  },
  {
    id: 'EX-06',
    termId: DEMO_TERM.id,
    date: '2026-09-15',
    kind: 'SUSPENDED',
    followsWeekday: null,
    suspendedPeriods: 'ALL',
    reason: '同一天两条互相矛盾的例外记录',
    dataOrigin: 'SIMULATED',
  },
];

export const DEMO_TEMPLATES: readonly TeachingTemplate[] = [
  // 正常的周一上午
  { id: 'TP-01', termId: DEMO_TERM.id, classId: 'C1', teacherId: 'T01', subjectId: 'S-YW', weekday: 1, period: 1, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  { id: 'TP-02', termId: DEMO_TERM.id, classId: 'C1', teacherId: 'T02', subjectId: 'S-SX', weekday: 1, period: 2, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  { id: 'TP-03', termId: DEMO_TERM.id, classId: 'C2', teacherId: 'T02', subjectId: 'S-SX', weekday: 1, period: 3, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  // 冲突样本：同一教师 T01 同一时段被排到两个班
  { id: 'TP-04', termId: DEMO_TERM.id, classId: 'C2', teacherId: 'T01', subjectId: 'S-YW', weekday: 1, period: 1, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  // 单双周样本
  { id: 'TP-05', termId: DEMO_TERM.id, classId: 'C1', teacherId: 'T03', subjectId: 'S-YY', weekday: 2, period: 1, parity: 'ODD', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  { id: 'TP-06', termId: DEMO_TERM.id, classId: 'C1', teacherId: 'T04', subjectId: 'S-TY', weekday: 2, period: 1, parity: 'EVEN', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  // 轮换课样本：口径未定，不得推算
  { id: 'TP-07', termId: DEMO_TERM.id, classId: 'C3', teacherId: 'T03', subjectId: 'S-YY', weekday: 3, period: 2, parity: 'ALL', rotation: 'CUSTOM', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  // 只有开始时间的课：第 5 节
  { id: 'TP-08', termId: DEMO_TERM.id, classId: 'C3', teacherId: 'T04', subjectId: 'S-TY', weekday: 4, period: 5, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  // 有效期到学期中
  { id: 'TP-09', termId: DEMO_TERM.id, classId: 'C2', teacherId: 'T03', subjectId: 'S-YY', weekday: 3, period: 1, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: '2026-10-31', dataOrigin: 'SIMULATED' },
  // 下午课
  { id: 'TP-10', termId: DEMO_TERM.id, classId: 'C1', teacherId: 'T01', subjectId: 'S-YW', weekday: 4, period: 4, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  { id: 'TP-11', termId: DEMO_TERM.id, classId: 'C2', teacherId: 'T04', subjectId: 'S-TY', weekday: 5, period: 2, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
  { id: 'TP-12', termId: DEMO_TERM.id, classId: 'C3', teacherId: 'T02', subjectId: 'S-SX', weekday: 5, period: 3, parity: 'ALL', rotation: 'NONE', validFrom: null, validTo: null, dataOrigin: 'SIMULATED' },
];

export const DEMO_SNAPSHOT: SchoolSnapshot = {
  term: DEMO_TERM,
  teachers: DEMO_TEACHERS,
  classes: DEMO_CLASSES,
  subjects: DEMO_SUBJECTS,
  bell: DEMO_BELL,
  exceptions: DEMO_EXCEPTIONS,
  templates: DEMO_TEMPLATES,
};

/** 数据集里故意保留的缺陷，测试与演示都以此为准 */
export const DEFECTS: readonly string[] = [
  'TP-04 与 TP-01 冲突：T01 周一第 1 节同时排给 C1 与 C2',
  '第 5 节缺少结束时间：课次 certainty=UNKNOWN，不参与硬冲突',
  'TP-07 为轮换课：只返回 UNKNOWN_ROTATION，不推算',
  '2026-12-02 调休未说明按哪天课表：整日 UNKNOWN_CALENDAR',
  '2026-09-15 同一天两条矛盾例外：整日 UNKNOWN_CALENDAR',
  'TP-09 有效期止于 2026-10-31：之后不再生成',
];
