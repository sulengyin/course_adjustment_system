import { describe, expect, it } from 'vitest';
import { applyMapping, proposeMapping } from '../../src/import/mapping.js';
import { parseParity, parsePeriod, parseWeekday, validateRows } from '../../src/import/validate.js';

const REFS = {
  teachers: () => [
    { id: 'T01', name: '示例教师甲' },
    { id: 'T02', name: '示例教师乙' },
    { id: 'T03', name: '同名教师' },
    { id: 'T04', name: '同名教师' },
  ],
  classes: () => [{ id: 'C1', name: '虚构一年一班' }, { id: 'C2', name: '虚构一年二班' }],
  subjects: () => [{ id: 'S-YW', name: '语文' }, { id: 'S-SX', name: '数学' }],
};

function rows(lines: Array<[string, string, string, string, string, string]>) {
  return lines.map((v, i) => ({
    line: i + 2,
    values: {
      teacher: v[0],
      class: v[1],
      subject: v[2],
      weekday: v[3],
      period: v[4],
      parity: v[5],
      validFrom: '',
      validTo: '',
    },
  }));
}

describe('字段映射', () => {
  it('识别中文表头并给出建议', () => {
    const p = proposeMapping(['教师', '班级', '科目', '星期', '节次', '单双周', '备注']);
    expect(p.missing).toEqual([]);
    expect(p.mapping).toMatchObject({ teacher: 0, class: 1, subject: 2, weekday: 3, period: 4, parity: 5 });
    expect(p.unmappedHeaders).toEqual(['备注']);
  });

  it('缺少必需列时不返回映射，不按位置瞎猜', () => {
    const p = proposeMapping(['甲', '乙', '丙']);
    expect(p.mapping).toBeNull();
    expect(p.missing).toEqual(['teacher', 'class', 'subject', 'weekday', 'period']);
  });

  it('列顺序打乱也能识别', () => {
    const p = proposeMapping(['节次', '教师', '星期', '班级', '科目']);
    expect(p.mapping).toMatchObject({ teacher: 1, class: 3, subject: 4, weekday: 2, period: 0 });
  });

  it('按映射取值，缺失列返回空串', () => {
    const table = {
      headers: ['教师', '班级', '科目', '星期', '节次'],
      rows: [['甲', '一班', '语文', '周一', '1']],
    };
    const p = proposeMapping(table.headers);
    expect(p.mapping).not.toBeNull();
    const mapped = applyMapping(table, p.mapping!);
    expect(mapped[0]?.values.parity).toBe('');
    expect(mapped[0]?.line).toBe(2);
  });
});

describe('字段解析', () => {
  it('星期', () => {
    expect(parseWeekday('周一')).toBe(1);
    expect(parseWeekday('星期三')).toBe(3);
    expect(parseWeekday('5')).toBe(5);
    expect(parseWeekday('Fri')).toBe(5);
    expect(parseWeekday('周日')).toBeNull();
    expect(parseWeekday('六')).toBeNull();
  });

  it('节次', () => {
    expect(parsePeriod('1')).toBe(1);
    expect(parsePeriod('第3节')).toBe(3);
    expect(parsePeriod('0')).toBeNull();
    expect(parsePeriod('一节')).toBeNull();
  });

  it('单双周，留空视为每周', () => {
    expect(parseParity('')).toBe('ALL');
    expect(parseParity('单周')).toBe('ODD');
    expect(parseParity('双')).toBe('EVEN');
    expect(parseParity('隔周')).toBeNull();
  });
});

describe('整批校验', () => {
  it('正常数据全部通过', () => {
    const r = validateRows(
      rows([
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', ''],
        ['示例教师乙', '虚构一年一班', '数学', '周一', '2', ''],
      ]),
      REFS,
    );
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ teacherId: 'T01', classId: 'C1', subjectId: 'S-YW', weekday: 1, period: 1 });
  });

  it('未知教师报错', () => {
    const r = validateRows(rows([['不存在的老师', '虚构一年一班', '语文', '周一', '1', '']]), REFS);
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.code).toBe('UNKNOWN_REF');
  });

  it('同名教师无法唯一定位时报 AMBIGUOUS_REF', () => {
    const r = validateRows(rows([['同名教师', '虚构一年一班', '语文', '周一', '1', '']]), REFS);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'AMBIGUOUS_REF')).toBe(true);
  });

  it('用教师 ID 也能匹配', () => {
    const r = validateRows(rows([['T02', 'C2', 'S-SX', '周五', '4', '']]), REFS);
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ teacherId: 'T02', classId: 'C2', subjectId: 'S-SX' });
  });

  it('非法星期/节次/单双周分别报错', () => {
    const r = validateRows(rows([['示例教师甲', '虚构一年一班', '语文', '周日', '99', '隔周']]), REFS);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('INVALID_WEEKDAY');
    expect(codes).toContain('INVALID_PERIOD');
    expect(codes).toContain('INVALID_PARITY');
  });

  it('完全重复的行被识别', () => {
    const r = validateRows(
      rows([
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', ''],
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', ''],
      ]),
      REFS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'DUPLICATE_ROW')).toBe(true);
  });

  it('同一教师同一时段排两个班 → TEACHER_DOUBLE_BOOKING', () => {
    const r = validateRows(
      rows([
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', ''],
        ['示例教师甲', '虚构一年二班', '语文', '周一', '1', ''],
      ]),
      REFS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'TEACHER_DOUBLE_BOOKING')).toBe(true);
  });

  it('单周与双周同槽不算冲突', () => {
    const r = validateRows(
      rows([
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', '单周'],
        ['示例教师乙', '虚构一年一班', '数学', '周一', '1', '双周'],
      ]),
      REFS,
    );
    expect(r.ok).toBe(true);
  });

  it('同一班级同一时段两位教师 → CLASS_DOUBLE_BOOKING', () => {
    const r = validateRows(
      rows([
        ['示例教师甲', '虚构一年一班', '语文', '周一', '1', ''],
        ['示例教师乙', '虚构一年一班', '数学', '周一', '1', ''],
      ]),
      REFS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'CLASS_DOUBLE_BOOKING')).toBe(true);
  });

  it('生效止早于生效起报错', () => {
    const base = rows([['示例教师甲', '虚构一年一班', '语文', '周一', '1', '']]);
    const r = validateRows(
      base.map((x) => ({
        ...x,
        values: { ...x.values, validFrom: '2026-10-01', validTo: '2026-09-01' },
      })),
      REFS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_RANGE')).toBe(true);
  });
});
