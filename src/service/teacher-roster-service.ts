/**
 * 教师名单导入。
 *
 * 四条约束（沿用项目既有原则，不是新发明）：
 *  1. 整批预检、整批生效：任何一行有问题就一个都不写。教师编号一旦落库
 *     就会被课表与账号引用，半批写入比整批拒绝更难收拾。
 *  2. 姓名必须唯一：课表导入是按"教师姓名或工号"匹配的（docs/04 §1），
 *     名单里有重名，后续课表必然"同名无法区分"整批被拒。这里提前拦下。
 *  3. 编号可自带、可生成。校方有正式工号的应填在"教师编号"列；留空时
 *     系统生成 T###。**生成出来的编号只是占位**——一旦校方给出正式工号，
 *     需要走一次显式迁移，不允许就地改写（改写会断掉已建的课表与账号引用）。
 *  4. 真实名单的数据来源是 IMPORTED_UNVERIFIED，不是 SIMULATED，更不能是
 *     OFFICIAL：它未经校方核对，系统不得据此认定"官方课表"。
 */

import type { CourseDatabase } from '../store/database.js';
import type { AuthService } from '../auth/service.js';
import type { Principal } from '../auth/principal.js';

export interface RosterRow {
  /** 教师编号；留空则由系统生成（生成结果会标记为 generated，见 ImportedTeacher） */
  readonly teacherId: string | null;
  readonly displayName: string;
}

export interface RosterSource {
  readonly fileName: string;
  readonly sha256: string;
}

export type RosterRejectCode =
  | 'EMPTY_NAME'
  | 'DUPLICATE_NAME_IN_FILE'
  | 'DUPLICATE_ID_IN_FILE'
  | 'BAD_ID_FORMAT'
  | 'NAME_ALREADY_EXISTS'
  | 'ID_ALREADY_EXISTS';

export interface RosterRejection {
  /** 名单里的行号（1 起算，含表头），便于直接改文件 */
  readonly line: number;
  readonly name: string;
  readonly code: RosterRejectCode;
  readonly message: string;
}

export interface ImportedTeacher {
  readonly teacherId: string;
  readonly displayName: string;
  /** true = 编号由系统生成（占位），待校方给出正式工号后需显式迁移 */
  readonly generated: boolean;
}

export interface RosterResult {
  readonly imported: readonly ImportedTeacher[];
  readonly rejected: readonly RosterRejection[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 从现有编号里找出 T### 序列的最大值，作为自动编号的起点 */
function maxGeneratedSeq(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const m = /^T(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export class TeacherRosterService {
  private readonly db: CourseDatabase;
  private readonly auth: AuthService;
  private readonly now: () => string;

  constructor(db: CourseDatabase, auth: AuthService, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.auth = auth;
    this.now = now;
  }

  import(principal: Principal, rows: readonly RosterRow[], source?: RosterSource): RosterResult {
    // 先过权限闸门：无权的人连预检细节都不该拿到。
    this.auth.requireAction(principal, 'IMPORT_ROSTER');

    const existing = this.db.refs().teachers;
    const existingIds = new Set(existing.map((t) => t.id));
    const existingNames = new Set(existing.map((t) => t.name));

    const rejected: RosterRejection[] = [];
    const nameInFile = new Set<string>();
    const idInFile = new Set<string>();

    rows.forEach((raw, index) => {
      const line = index + 2; // 第 1 行是表头
      const name = (raw.displayName ?? '').trim();
      const id = (raw.teacherId ?? '').trim();

      if (name === '') {
        rejected.push({ line, name: '', code: 'EMPTY_NAME', message: '姓名为空' });
        return;
      }
      if (nameInFile.has(name)) {
        rejected.push({
          line,
          name,
          code: 'DUPLICATE_NAME_IN_FILE',
          message: '同一份名单里姓名重复；课表按姓名匹配，重名会导致后续导入无法区分，请加区分标记',
        });
        return;
      }
      nameInFile.add(name);
      if (existingNames.has(name)) {
        rejected.push({
          line,
          name,
          code: 'NAME_ALREADY_EXISTS',
          message: '该姓名已在教师档案中，重复导入被拒绝；如需改名请走显式变更，不要重导',
        });
        return;
      }

      if (id === '') return; // 编号留空，稍后生成
      if (!ID_RE.test(id)) {
        rejected.push({
          line,
          name,
          code: 'BAD_ID_FORMAT',
          message: `教师编号不合规：${id}（1–32 位字母、数字、下划线或连字符，且以字母或数字开头）`,
        });
        return;
      }
      if (idInFile.has(id)) {
        rejected.push({ line, name, code: 'DUPLICATE_ID_IN_FILE', message: `教师编号 ${id} 在本名单里重复` });
        return;
      }
      idInFile.add(id);
      if (existingIds.has(id)) {
        rejected.push({ line, name, code: 'ID_ALREADY_EXISTS', message: `教师编号 ${id} 已被他人占用` });
        return;
      }
    });

    if (rejected.length > 0) {
      return { imported: [], rejected };
    }

    // 预检通过，开始分配编号。已占用的集合要同时避开库里和本批已发出的。
    const taken = new Set<string>([...existingIds, ...idInFile]);
    let seq = maxGeneratedSeq([...taken]);
    const imported: ImportedTeacher[] = [];

    for (const raw of rows) {
      const name = (raw.displayName ?? '').trim();
      const provided = (raw.teacherId ?? '').trim();
      if (provided !== '') {
        imported.push({ teacherId: provided, displayName: name, generated: false });
        continue;
      }
      let generated = '';
      do {
        seq += 1;
        generated = `T${String(seq).padStart(3, '0')}`;
      } while (taken.has(generated));
      taken.add(generated);
      imported.push({ teacherId: generated, displayName: name, generated: true });
    }

    const at = this.now();
    const generatedCount = imported.filter((t) => t.generated).length;

    this.db.transaction(() => {
      this.db.insertTeachers(
        imported.map((t) => ({ id: t.teacherId, displayName: t.displayName, dataOrigin: 'IMPORTED_UNVERIFIED' as const })),
      );
      this.db.auditLog.append({
        at,
        actor: principal.userId,
        action: 'IMPORT_ROSTER',
        objectType: 'TEACHER_ROSTER',
        objectId: source?.sha256 ?? at,
        beforeState: null,
        // 审计只记数量与来源指纹，不复制整份姓名清单：
        // 名单是个人信息，扩散到审计里只会增加暴露面。
        afterState: JSON.stringify({
          count: imported.length,
          generatedIds: generatedCount,
          providedIds: imported.length - generatedCount,
          dataOrigin: 'IMPORTED_UNVERIFIED',
          fileName: source?.fileName ?? null,
        }),
        reason: generatedCount > 0 ? 'IDS_GENERATED_PENDING_OFFICIAL' : null,
      });
    });

    return { imported, rejected: [] };
  }
}
