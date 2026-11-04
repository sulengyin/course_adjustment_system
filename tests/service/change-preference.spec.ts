import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChangePreferenceService,
  inputToPreference,
  parsePreferenceInput,
} from '../../src/service/change-preference-service.js';
import { CourseDatabase } from '../../src/store/database.js';
import { DEMO_SNAPSHOT } from '../../src/store/fixtures.js';

let db: CourseDatabase;
let service: ChangePreferenceService;

const AT = '2026-11-02T10:00:00.000Z';

const BASE = {
  considerSameClass: true,
  considerSameGrade: true,
  considerSameSubject: true,
  considerLightLoad: true,
  excludeBusyAtSlot: false,
  excludeConsecutive: false,
  consecutiveLimit: 3,
  excludeDayTotal: false,
  dayTotalLimit: 6,
  hintClassSubjectDay: true,
  classSubjectDayLimit: 2,
};

beforeEach(() => {
  db = new CourseDatabase(':memory:');
  db.loadSnapshot(DEMO_SNAPSHOT);
  service = new ChangePreferenceService(db, { now: () => AT });
});

afterEach(() => db.close());

describe('代课候选筛选偏好', () => {
  it('没有配置时用中性默认：全部考虑、不隐藏任何人', () => {
    const effective = service.effective('T-1');
    expect(effective.source).toBe('NEUTRAL');
    expect(effective.preference.consider.sameClass).toBe(true);
    expect(effective.preference.exclude.busyAtSlot).toBe(false);
    expect(effective.preference.exclude.consecutive).toBe(false);
    expect(effective.preference.exclude.dayTotal).toBe(false);
  });

  it('课务管理人员设全校默认后，教师默认沿用', () => {
    service.saveSchool({ ...BASE, excludeBusyAtSlot: true }, 'S-1');
    const effective = service.effective('T-1');
    expect(effective.source).toBe('SCHOOL_DEFAULT');
    expect(effective.preference.exclude.busyAtSlot).toBe(true);
  });

  it('教师自己的偏好覆盖全校默认', () => {
    service.saveSchool({ ...BASE, excludeBusyAtSlot: true }, 'S-1');
    service.saveTeacher('T-1', { ...BASE, excludeBusyAtSlot: false, excludeConsecutive: true });
    const effective = service.effective('T-1');
    expect(effective.source).toBe('TEACHER');
    expect(effective.preference.exclude.busyAtSlot).toBe(false);
    expect(effective.preference.exclude.consecutive).toBe(true);
    // 其他教师仍然用全校默认
    expect(service.effective('T-2').preference.exclude.busyAtSlot).toBe(true);
  });

  it('保存后留下更新时间与更新人', () => {
    const saved = service.saveTeacher('T-1', BASE);
    expect(saved.updatedAt).toBe(AT);
    expect(saved.updatedBy).toBe('T-1');
    expect(db.getPreference('TEACHER', 'T-1')?.consecutiveLimit).toBe(3);
  });

  it('全校默认只有一行，重复保存不产生第二行', () => {
    service.saveSchool(BASE, 'S-1');
    service.saveSchool({ ...BASE, consecutiveLimit: 4 }, 'S-2');
    expect(db.getPreference('SCHOOL', '')?.consecutiveLimit).toBe(4);
    expect(db.getPreference('SCHOOL', '')?.updatedBy).toBe('S-2');
  });
});

describe('偏好入参校验', () => {
  it('合法入参通过', () => {
    expect(parsePreferenceInput(BASE)).toEqual(BASE);
  });

  it('阈值越界或不是整数一律拒绝', () => {
    for (const bad of [
      { ...BASE, consecutiveLimit: 0 },
      { ...BASE, consecutiveLimit: 21 },
      { ...BASE, dayTotalLimit: 1.5 },
      { ...BASE, classSubjectDayLimit: '2' },
    ]) {
      expect(parsePreferenceInput(bad)).toBeNull();
    }
  });

  it('字段缺失或非布尔一律拒绝，不静默补全', () => {
    expect(parsePreferenceInput({ ...BASE, excludeBusyAtSlot: 'true' })).toBeNull();
    expect(parsePreferenceInput({ consecutiveLimit: 3 })).toBeNull();
    expect(parsePreferenceInput(null)).toBeNull();
    expect(parsePreferenceInput([])).toBeNull();
  });

  it('入参映射为领域结构后与存储记录一致', () => {
    const parsed = parsePreferenceInput({ ...BASE, excludeConsecutive: true, consecutiveLimit: 4 });
    expect(parsed).not.toBeNull();
    const domain = inputToPreference(parsed!);
    expect(domain.exclude.consecutive).toBe(true);
    expect(domain.exclude.consecutiveLimit).toBe(4);
    expect(domain.hint.classSubjectDayLimit).toBe(2);
  });
});
