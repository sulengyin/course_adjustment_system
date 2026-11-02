/**
 * 在最小 DOM 替身上真实执行 web/app.js，检查页面能否渲染出关键区域。
 *
 * 这不是浏览器，也无法替代真实浏览器验收；它能挡住的是：
 * 改 JS 时引用未定义变量、DOM 结构与预期不符、渲染函数抛错——
 * 这些问题在纯静态检查里看不出来，却会让用户打开页面看到白屏。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../../web/app.js', import.meta.url)), 'utf8');

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  className: string;
  hidden: boolean;
  value: string;
  disabled: boolean;
  dataset: Record<string, string>;
  firstChild: FakeNode | null;
  textContent: string;
  append(...kids: unknown[]): void;
  removeChild(child: FakeNode): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  dispatch(type: string): unknown;
  scrollIntoView(): void;
  focus(): void;
}

interface Harness {
  document: { getElementById(id: string): FakeNode | null; createElement(tag: string): FakeNode };
  storage: Map<string, string>;
  requests: string[];
  flush(times?: number): Promise<void>;
}

function createHarness(routes: Record<string, unknown>, token: string | null): Harness {
  const registry = new Map<string, FakeNode>();
  const storage = new Map<string, string>();
  if (token) storage.set('ca.token', token);
  const requests: string[] = [];

  class Node {
    tagName: string;
    children: FakeNode[] = [];
    className = '';
    hidden = false;
    value = '';
    disabled = false;
    dataset: Record<string, string> = {};
    private attrs: Record<string, string> = {};
    private listeners: Record<string, Array<(event: unknown) => unknown>> = {};
    private text = '';

    constructor(tag: string) {
      this.tagName = tag;
    }

    get firstChild(): FakeNode | null {
      return this.children[0] ?? null;
    }

    get textContent(): string {
      return this.text + this.children.map((c) => c.textContent).join('');
    }

    set textContent(value: string) {
      this.text = String(value);
      this.children = [];
    }

    append(...kids: unknown[]): void {
      for (const kid of kids) {
        if (kid === null || kid === undefined || kid === false) continue;
        if (kid instanceof Node) {
          this.children.push(kid as FakeNode);
        } else {
          const textNode = new Node('#text') as unknown as FakeNode;
          textNode.textContent = String(kid);
          this.children.push(textNode);
        }
      }
    }

    removeChild(child: FakeNode): void {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    }

    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
      if (name === 'id') registry.set(value, this as unknown as FakeNode);
      if (name === 'class') this.className = value;
      if (name === 'hidden') this.hidden = true;
    }

    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }

    addEventListener(type: string, fn: (event: unknown) => unknown): void {
      (this.listeners[type] ??= []).push(fn);
    }

    dispatch(type: string): unknown {
      let result: unknown;
      for (const fn of this.listeners[type] ?? []) result = fn({ target: this, preventDefault() {} });
      return result;
    }

    scrollIntoView(): void {}
    focus(): void {}
  }

  const root = new Node('div');
  root.setAttribute('id', 'app');
  registry.set('app', root as unknown as FakeNode);
  const toast = new Node('div');
  toast.setAttribute('id', 'toast');
  registry.set('toast', toast as unknown as FakeNode);
  const envBanner = new Node('div');
  envBanner.setAttribute('id', 'env-banner');
  envBanner.hidden = true;
  registry.set('env-banner', envBanner as unknown as FakeNode);

  const document = {
    getElementById: (id: string): FakeNode | null => registry.get(id) ?? null,
    createElement: (tag: string): FakeNode => new Node(tag) as unknown as FakeNode,
    createTextNode: (text: string): FakeNode => {
      const node = new Node('#text') as unknown as FakeNode;
      node.textContent = text;
      return node;
    },
  };

  const fetchMock = async (input: string): Promise<unknown> => {
    const path = input.startsWith('http') ? new URL(input).pathname : (input.split('?')[0] ?? input);
    const key = Object.keys(routes).find((route) => path === route || path.startsWith(`${route.replace(/\/$/, '')}/`));
    requests.push(input);
    const entry = key ? routes[key] : undefined;
    // 路由值默认按 200 返回；写成 { status, body } 可模拟 401 等失败响应。
    const wrapped =
      entry !== null && typeof entry === 'object' && 'status' in entry && 'body' in entry;
    const status = wrapped ? (entry as { status: number }).status : key ? 200 : 404;
    const body = wrapped ? (entry as { body: unknown }).body : key ? entry : { ok: false, code: 'NOT_FOUND' };
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };

  const sandbox = {
    document,
    window: {
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      scrollTo: () => undefined,
    },
    fetch: fetchMock,
    Node,
    console,
    crypto: globalThis.crypto,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };

  vm.runInNewContext(source, sandbox, { filename: 'web/app.js' });

  return {
    document,
    storage,
    requests,
    flush: async (times = 12) => {
      for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function walk(node: FakeNode, visit: (n: FakeNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function textOf(node: FakeNode): string {
  let text = '';
  walk(node, (n) => {
    text += n.textContent;
  });
  return text;
}

function changePasswordInputs(app: FakeNode): [FakeNode, FakeNode, FakeNode] {
  const inputs = findAllTag(app, 'input');
  const [oldInput, newInput, againInput] = inputs;
  if (inputs.length !== 3 || !oldInput || !newInput || !againInput) {
    throw new Error(`改密页应有 3 个输入框，实际 ${inputs.length} 个`);
  }
  return [oldInput, newInput, againInput];
}

function findAllTag(root: FakeNode, tag: string): FakeNode[] {
  const found: FakeNode[] = [];
  walk(root, (n) => {
    if (n.tagName === tag) found.push(n);
  });
  return found;
}

function findTag(root: FakeNode, tag: string): FakeNode | null {
  let found: FakeNode | null = null;
  walk(root, (n) => {
    if (!found && n.tagName === tag) found = n;
  });
  return found;
}

function findByClass(root: FakeNode, className: string): FakeNode | null {
  let found: FakeNode | null = null;
  walk(root, (n) => {
    if (!found && n.className.split(' ').includes(className)) found = n;
  });
  return found;
}

function findByText(root: FakeNode, label: string): FakeNode | null {
  let found: FakeNode | null = null;
  walk(root, (n) => {
    if (!found && n.tagName === 'button' && n.textContent.trim() === label) found = n;
  });
  return found;
}

const PRINCIPAL = {
  userId: 'U-1',
  teacherId: 'T01',
  displayName: '示例教师甲',
  roles: ['T'],
  actingRole: 'T',
  mustChangePassword: false,
};

const TERM = {
  id: 'TERM-2026-FALL',
  label: '2026 学年第一学期（虚构）',
  startMonday: '2026-08-31',
  endDate: '2026-12-31',
  dataOrigin: 'SIMULATED',
};

const META = {
  ok: true,
  serverTime: '2026-11-01T00:00:00.000Z',
  schemaVersion: 'p6-1',
  terms: [TERM],
  capabilities: [
    { action: 'CREATE_OWN_CHANGE', label: '发起本人调课方案', verdict: 'ALLOWED' },
    { action: 'DECIDE_OWN_CONFIRMATION', label: '确认本人课务', verdict: 'ALLOWED' },
    { action: 'REQUEST_HELP', label: '发起求助', verdict: 'ALLOWED' },
    { action: 'VIEW_SCHOOL_AUDIT', label: '查看全校审计', verdict: 'FORBIDDEN' },
  ],
};

const VIEW = {
  ok: true,
  view: {
    complete: false,
    unknownDays: [{ date: '2026-12-02', reason: 'UNKNOWN_CALENDAR' }],
    unresolved: [],
    rows: [
      {
        occurrenceId: 'OCC-1',
        date: '2026-10-26',
        period: 1,
        startsAt: '08:00',
        endsAt: '08:40',
        certainty: 'KNOWN',
        unknownReason: null,
        classId: 'C1',
        className: '虚构一年一班',
        teacherId: 'T01',
        teacherName: '示例教师甲',
        subjectId: 'S-YW',
        subjectName: '语文',
        dataOrigin: 'SIMULATED',
        cancelled: false,
      },
    ],
  },
};

describe('页面渲染（最小 DOM）', () => {
  it('未登录时渲染登录表单，不请求业务接口', async () => {
    const harness = createHarness({}, null);
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const text = textOf(app);
    expect(text).toContain('校内课务协同系统');
    expect(text).toContain('登录');
    // /api/env 只是环境标识，不含任何业务数据，未登录时取它不算请求业务接口
    expect(harness.requests).toEqual(['/api/env']);
  });

  it('演示环境横幅在登录前就常驻显示，标明库内全是虚构数据', async () => {
    const harness = createHarness({ '/api/env': { ok: true, deploymentMode: 'DEMO' } }, null);
    await harness.flush();
    const banner = harness.document.getElementById('env-banner') as FakeNode;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('演示');
    expect(banner.textContent).toContain('虚构数据');
  });

  it('正式环境横幅标明是真实业务数据', async () => {
    const harness = createHarness({ '/api/env': { ok: true, deploymentMode: 'PRODUCTION' } }, null);
    await harness.flush();
    const banner = harness.document.getElementById('env-banner') as FakeNode;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('正式业务环境');
    expect(banner.textContent).toContain('真实业务数据');
    // 演示横幅才有"库内全部为虚构数据"这句话，两种环境的说法不能串
    expect(banner.textContent).not.toContain('库内全部为虚构数据');
  });

  it('拿不到环境标识时横幅保持隐藏，不猜一种环境', async () => {
    const harness = createHarness({}, null);
    await harness.flush();
    const banner = harness.document.getElementById('env-banner') as FakeNode;
    expect(banner.hidden).toBe(true);
    expect(banner.textContent).toBe('');
  });

  it('登录接口返回 401 时按凭据错误提示，不误报"登录已失效"', async () => {
    const harness = createHarness(
      { '/api/auth/login': { status: 401, body: { ok: false, code: 'INVALID_CREDENTIALS' } } },
      null,
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const nameInput = harness.document.getElementById('login-name');
    const passwordInput = harness.document.getElementById('login-password');
    if (!nameInput || !passwordInput) throw new Error('登录表单缺少账号或口令输入框');
    nameInput.value = 'teacher01';
    passwordInput.value = '输错的口令';
    findTag(app, 'form')?.dispatch('submit');
    await harness.flush();

    const text = textOf(app);
    expect(text).toContain('账号或口令不正确');
    expect(text).not.toContain('登录已失效');
  });

  it('业务接口 401 仍按会话失效处理', async () => {
    const harness = createHarness({ '/api/me': { status: 401, body: { ok: false, code: 'UNAUTHENTICATED' } } }, 'token-1');
    await harness.flush();
    expect(textOf(harness.document.getElementById('app') as FakeNode)).toContain('登录已失效');
  });

  it('改密被服务端拒绝时留在改密页并说明原因，不能当作成功', async () => {
    // 服务端以 400 WEAK_PASSWORD 拒绝：曾经前端不看状态码，一律提示"口令已修改"，
    // 用户随后拿没生效的新口令登录，看到的却是"登录已失效"。
    const harness = createHarness(
      {
        '/api/me/password': { status: 400, body: { ok: false, code: 'WEAK_PASSWORD', message: '口令不符合最低要求：ONLY_ONE_CHARACTER_CLASS' } },
        '/api/me': { ok: true, principal: { ...PRINCIPAL, mustChangePassword: true } },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const [oldInput, newInput, againInput] = changePasswordInputs(app);
    oldInput.value = '9732EVNPA5DT';
    newInput.value = '12345678901234';
    againInput.value = '12345678901234';
    findTag(app, 'form')?.dispatch('submit');
    await harness.flush();

    const text = textOf(app);
    expect(text).toContain('口令不符合最低要求');
    expect(text).toContain('至少 12 位');
    expect(text).not.toContain('请用新口令重新登录');
    expect(text).toContain('首次登录需修改口令');
  });

  it('改密时原口令错误提示"原口令不正确"，不按会话失效处理', async () => {
    const harness = createHarness(
      {
        '/api/me/password': { status: 401, body: { ok: false, code: 'INVALID_CREDENTIALS' } },
        '/api/me': { ok: true, principal: { ...PRINCIPAL, mustChangePassword: true } },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const [oldInput, newInput, againInput] = changePasswordInputs(app);
    oldInput.value = '错的旧口令';
    newInput.value = 'New1234567890';
    againInput.value = 'New1234567890';
    findTag(app, 'form')?.dispatch('submit');
    await harness.flush();

    const text = textOf(app);
    expect(text).toContain('原口令不正确');
    expect(text).not.toContain('登录已失效');
  });

  it('改密成功后提示用新口令重新登录', async () => {
    const harness = createHarness(
      {
        '/api/me/password': { status: 200, body: { ok: true, reauthRequired: true } },
        '/api/me': { ok: true, principal: { ...PRINCIPAL, mustChangePassword: true } },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const [oldInput, newInput, againInput] = changePasswordInputs(app);
    oldInput.value = '9732EVNPA5DT';
    newInput.value = 'New1234567890';
    againInput.value = 'New1234567890';
    findTag(app, 'form')?.dispatch('submit');
    await harness.flush();

    expect(textOf(app)).toContain('请用新口令重新登录');
  });

  it('已登录时渲染外壳与课表，未决日期显式提示', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const text = textOf(app);
    expect(text).toContain('我的课表');
    expect(text).toContain('语文');
    expect(text).toContain('本视图不完整');
    expect(text).toContain('待核验事项');
  });

  it('切换到调课页会拉取方案列表，并显示三个页签', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [], classes: [], subjects: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const navButton = findByText(app, '调课');
    expect(navButton).not.toBeNull();
    navButton?.dispatch('click');
    await harness.flush();
    const text = textOf(app);
    expect(text).toContain('新建方案');
    expect(text).toContain('待我确认');
  });

  it('改派对象是页面内可滚动名单，不依赖浏览器原生下拉弹层', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/candidates/preview': {
          ok: true,
          candidates: [
            {
              teacherId: 'T02',
              teacherName: '示例教师乙',
              tier: 'SAME_CLASS',
              freeAtSlot: true,
              teachesSubject: true,
              reasons: ['本学期任教同一科目'],
              hints: [],
            },
          ],
          excluded: [],
        },
        '/api/changes': { ok: true, caseId: 'CASE-1', status: 'PENDING', required: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    findByText(app, '调课')?.dispatch('click');
    await harness.flush();
    findByText(app, '新建方案')?.dispatch('click');
    await harness.flush();

    const trigger = findByText(app, '选择教师…');
    expect(trigger).not.toBeNull();
    trigger?.dispatch('click');
    await harness.flush();

    const list = findByClass(app, 'picker-list');
    expect(list).not.toBeNull();
    expect(textOf(list as FakeNode)).toContain('示例教师乙');
    // 名单里不能有原生 select：它的弹层在点滚动条时会被浏览器整层关掉
    expect(findAllTag(list as FakeNode, 'select').length).toBe(0);

    // 还没选人就提交：不发起请求，只如实提示
    const form = findAllTag(app, 'form').find((f) => textOf(f).includes('新建调课方案'));
    form?.dispatch('submit');
    await harness.flush();
    expect(harness.requests).not.toContain('/api/changes');
    expect(textOf(app)).toContain('请先选择要改派给的教师');

    const row = findAllTag(list as FakeNode, 'button')[0];
    row?.dispatch('click');
    await harness.flush();
    expect(textOf(app)).toContain('已选：示例教师乙');

    form?.dispatch('submit');
    await harness.flush();
    expect(harness.requests).toContain('/api/changes');
  });

  it('管理员可见系统状态入口，教师不可见', async () => {
    const teacher = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
      },
      'token-1',
    );
    await teacher.flush();
    expect(textOf(teacher.document.getElementById('app') as FakeNode)).not.toContain('系统状态');

    const admin = createHarness(
      {
        '/api/me': { ok: true, principal: { ...PRINCIPAL, teacherId: null, displayName: '管理员', actingRole: 'A' } },
        '/api/meta': {
          ...META,
          capabilities: [{ action: 'VIEW_SCHOOL_AUDIT', label: '查看全校审计', verdict: 'ALLOWED' }],
        },
      },
      'token-1',
    );
    await admin.flush();
    expect(textOf(admin.document.getElementById('app') as FakeNode)).toContain('系统状态');
  });
});
