/**
 * 班级与科目导入。
 *
 * 课表导入要求"班级/科目"已存在（`docs/04_导入格式说明.md`），否则整批拒绝。
 * 这两张表是课表的两个维度，错一条就会让整学期课表挂错班级或错科目，
 * 所以走"整批预检 → 整批生效"，不做逐行修补。
 *
 * 三条约束：
 *  1. 只允许课务管理人员（IMPORT_ROSTER）执行。
 *  2. 库中已有班级/科目就拒绝：它们被模板引用后改名或删除，历史课表会重新解释。
 *  3. 真实资料只标 IMPORTED_UNVERIFIED，不冒充 OFFICIAL。
 */

import type { CourseDatabase } from '../store/database.js';
import type { AuthService } from '../auth/service.js';
import type { Principal } from '../auth/principal.js';
import type { DataOrigin } from '../domain/model.js';

export interface ClassInput {
  readonly name: string;
  readonly grade: string;
}

export interface SubjectInput {
  readonly name: string;
}

export interface BaseImportResult {
  readonly count: number;
  readonly ids: readonly string[];
  readonly dataOrigin: DataOrigin;
}

export type BaseRejectCode =
  | 'EMPTY_LIST'
  | 'EMPTY_NAME'
  | 'EMPTY_GRADE'
  | 'DUPLICATE_NAME'
  | 'CLASSES_EXIST'
  | 'SUBJECTS_EXIST'
  | 'NAME_TOO_LONG';

export class BaseImportError extends Error {
  constructor(
    readonly code: BaseRejectCode,
    message: string,
  ) {
    super(message);
  }
}

/** 名称上限：备注性字段会被表格软件当成正常内容，过长的名称通常意味着粘错列 */
const MAX_NAME = 40;

export class SchoolBaseImportService {
  private readonly now: () => string;

  constructor(
    private readonly db: CourseDatabase,
    private readonly auth: AuthService,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
  }

  importClasses(principal: Principal, list: readonly ClassInput[]): BaseImportResult {
    this.auth.requireAction(principal, 'IMPORT_ROSTER');
    if (list.length === 0) throw new BaseImportError('EMPTY_LIST', '班级名单为空');

    const seen = new Map<string, string>();
    const rows = list.map((c, i) => {
      const name = c.name.trim();
      const grade = c.grade.trim();
      if (name === '') throw new BaseImportError('EMPTY_NAME', `第 ${i + 1} 行班级名称为空`);
      if (name.length > MAX_NAME) throw new BaseImportError('NAME_TOO_LONG', `第 ${i + 1} 行班级名称过长：${name}`);
      if (grade === '') throw new BaseImportError('EMPTY_GRADE', `第 ${i + 1} 行（${name}）缺年级`);
      const prev = seen.get(name);
      if (prev !== undefined) throw new BaseImportError('DUPLICATE_NAME', `班级名称重复：「${name}」出现在第 ${prev} 行与第 ${i + 1} 行`);
      seen.set(name, String(i + 1));
      return { id: `C-${name}`, displayName: name, grade, dataOrigin: 'IMPORTED_UNVERIFIED' as DataOrigin };
    });

    if (this.db.countClasses() > 0) {
      throw new BaseImportError('CLASSES_EXIST', '库中已有班级。班级被课表引用后不能覆盖，需另建库或先做显式迁移');
    }

    const at = this.now();
    this.db.transaction(() => {
      this.db.insertClasses(rows);
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'IMPORT_CLASSES',
        objectType: 'SCHOOL_CLASS',
        objectId: `${rows.length} 条`,
        afterState: 'IMPORTED_UNVERIFIED',
        reason: `真实班级导入：${rows.length} 个班，年级 ${[...new Set(rows.map((r) => r.grade))].join('/')}`,
      });
    });

    return { count: rows.length, ids: rows.map((r) => r.id), dataOrigin: 'IMPORTED_UNVERIFIED' };
  }

  importSubjects(principal: Principal, list: readonly SubjectInput[]): BaseImportResult {
    this.auth.requireAction(principal, 'IMPORT_ROSTER');
    if (list.length === 0) throw new BaseImportError('EMPTY_LIST', '科目名单为空');

    const seen = new Map<string, string>();
    const rows = list.map((s, i) => {
      const name = s.name.trim();
      if (name === '') throw new BaseImportError('EMPTY_NAME', `第 ${i + 1} 行科目名称为空`);
      if (name.length > MAX_NAME) throw new BaseImportError('NAME_TOO_LONG', `第 ${i + 1} 行科目名称过长：${name}`);
      const prev = seen.get(name);
      if (prev !== undefined) throw new BaseImportError('DUPLICATE_NAME', `科目名称重复：「${name}」出现在第 ${prev} 行与第 ${i + 1} 行`);
      seen.set(name, String(i + 1));
      return { id: `S-${name}`, name, dataOrigin: 'IMPORTED_UNVERIFIED' as DataOrigin };
    });

    if (this.db.countSubjects() > 0) {
      throw new BaseImportError('SUBJECTS_EXIST', '库中已有科目。科目被课表引用后不能覆盖，需另建库或先做显式迁移');
    }

    const at = this.now();
    this.db.transaction(() => {
      this.db.insertSubjects(rows);
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'IMPORT_SUBJECTS',
        objectType: 'SUBJECT',
        objectId: `${rows.length} 条`,
        afterState: 'IMPORTED_UNVERIFIED',
        reason: `真实科目导入：${rows.length} 个科目`,
      });
    });

    return { count: rows.length, ids: rows.map((r) => r.id), dataOrigin: 'IMPORTED_UNVERIFIED' };
  }
}
