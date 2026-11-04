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
  /** 请求体（已解析），用于断言提交出去的是两条还是一条件 */
  bodies: Array<{ path: string; body: unknown }>;
  flush(times?: number): Promise<void>;
}

function createHarness(routes: Record<string, unknown>, token: string | null): Harness {
  const registry = new Map<string, FakeNode>();
  const storage = new Map<string, string>();
  if (token) storage.set('ca.token', token);
  const requests: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];

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
          // 真实浏览器里 select 默认选中第一个 option。替身必须保持同一行为，
          // 否则"按当前选中的课次取候选"这类逻辑在测试里永远走不到（value 恒为空）。
          if (this.tagName === 'select' && this.value === '' && kid.tagName === 'option') {
            this.value = kid.getAttribute('value') ?? '';
          }
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
      // 浏览器里 disabled 属性会反映到同名属性上；替身必须一致，否则测不出"不可点"
      if (name === 'disabled') this.disabled = true;
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

  const fetchMock = async (input: string, init?: { body?: unknown }): Promise<unknown> => {
    const path = input.startsWith('http') ? new URL(input).pathname : (input.split('?')[0] ?? input);
    const key = Object.keys(routes).find((route) => path === route || path.startsWith(`${route.replace(/\/$/, '')}/`));
    requests.push(input);
    if (typeof init?.body === 'string') {
      try {
        bodies.push({ path: path, body: JSON.parse(init.body) });
      } catch {
        bodies.push({ path: path, body: init.body });
      }
    }
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
    bodies,
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

/** 新建方案默认是"对调"；要测代课流程必须显式切一次，别让默认值替测试做主。 */
function switchChangeKind(app: FakeNode, value: 'REASSIGN' | 'SWAP' | 'MOVE' | 'CANCEL'): void {
  const select = findAllTag(app, 'select').find((s) => textOf(s).includes('调整时间（换日期/节次）'));
  if (!select) throw new Error('没有找到"变更方式"下拉');
  select.value = value;
  select.dispatch('change');
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
    { action: 'CREATE_OWN_CHANGE', label: '发起本人调课方案（代课／对调／调整时间／停课）', verdict: 'ALLOWED' },
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

  it('页签切换只换内容，不重建 tabs 本身——滑块要靠同一批节点才滑得起来', async () => {
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
    findByText(app, '调课')?.dispatch('click');
    await harness.flush();

    const tabs = findAllTag(app, 'div').find((n) => n.className.split(' ').includes('tabs')) as FakeNode;
    expect(tabs).toBeDefined();
    // 滑块是纯装饰：读屏不该念它，指针也不该被它挡住
    const pill = findAllTag(tabs, 'span').find((n) => n.className.split(' ').includes('pill'));
    expect(pill).toBeDefined();
    expect(pill?.getAttribute('aria-hidden')).toBe('true');

    const submitted = findByText(tabs, '我发起的（0）');
    expect(submitted?.getAttribute('aria-selected')).toBe('false');
    submitted?.dispatch('click');
    await harness.flush();

    const tabsAfter = findAllTag(app, 'div').find((n) => n.className.split(' ').includes('tabs')) as FakeNode;
    expect(tabsAfter).toBe(tabs);
    expect(submitted?.getAttribute('aria-selected')).toBe('true');
  });

  it('导航切换后滑块不累积：每个导航容器里只有一颗', async () => {
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
    findByText(app, '调课')?.dispatch('click');
    await harness.flush();

    const nav = findTag(app, 'nav') as FakeNode;
    const pills = findAllTag(nav, 'span').filter((n) => n.className.split(' ').includes('pill'));
    expect(pills.length).toBe(1);
    expect(findByText(nav, '调课')?.getAttribute('aria-current')).toBe('page');
  });

  it('课表标出今日列：用服务端时间判断，周六周日不在五天表头里就不标', async () => {
    const today = new Date();
    const term = {
      id: 'TERM-WIDE',
      label: '宽范围学期',
      startMonday: '2000-01-03',
      endDate: '2099-12-31',
      dataOrigin: 'SIMULATED',
    };
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': { ...META, terms: [term], serverTime: today.toISOString() },
        '/api/timetable/me': { ...VIEW, view: { ...VIEW.view, rows: [] } },
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    const marked = findAllTag(app, 'th').filter((n) => n.className.split(' ').includes('is-today'));
    const weekday = today.getDay();
    expect(marked.length).toBe(weekday >= 1 && weekday <= 5 ? 1 : 0);
  });

  it('代课对象是页面内可滚动名单，不依赖浏览器原生下拉弹层', async () => {
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
    switchChangeKind(app, 'REASSIGN');
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
    expect(textOf(app)).toContain('请先选择由哪位教师代课');

    const row = findAllTag(list as FakeNode, 'button')[0];
    row?.dispatch('click');
    await harness.flush();
    expect(textOf(app)).toContain('已选：示例教师乙');

    form?.dispatch('submit');
    await harness.flush();
    expect(harness.requests).toContain('/api/changes');
  });

  it('变更方式用统一术语：代课／调整时间／停课，"调课"只作总称', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/candidates/preview': { ok: true, candidates: [], excluded: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    findByText(app, '调课')?.dispatch('click');
    await harness.flush();
    findByText(app, '新建方案')?.dispatch('click');
    await harness.flush();

    const text = textOf(app);
    expect(text).toContain('代课（请另一位教师上这节课）');
    expect(text).toContain('调整时间（换日期/节次）');
    expect(text).toContain('代课教师');
    // 旧的含糊说法不得回潮：它把"代课"和"调课"混成了一件事
    expect(text).not.toContain('调课（换授课教师）');
    expect(text).not.toContain('调课给');
  });

  it('对调：只推同班教师、落到具体课次，提交时生成两条代课', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/swap-candidates': {
          ok: true,
          recommended: [
            {
              teacherId: 'T02',
              teacherName: '示例教师乙',
              tier: 'SAME_CLASS',
              viableCount: 2,
              sampleOptions: [
                { occurrenceId: 'OCC-2', date: '2026-11-05', period: 3 },
              ],
              reasons: ['本学期任教该班', '对调后当天 2 节'],
              hints: [],
            },
          ],
          notRecommended: [
            {
              teacherId: 'T09',
              teacherName: '示例教师壬',
              tier: 'CROSS_GRADE',
              viableCount: 0,
              sampleOptions: [],
              reasons: ['本学期不任教该班（跨年级）'],
              hints: [],
            },
          ],
        },
        '/api/changes/swap-options': {
          ok: true,
          options: [
            {
              occurrenceId: 'OCC-2',
              date: '2026-11-05',
              period: 3,
              classId: 'C1',
              className: '虚构一年一班',
              subjectId: 'S-SX',
              subjectName: '数学',
              remainingCount: 1,
              hints: [],
              blockedReasons: [],
              reasons: ['本学期任教该班'],
              score: 70,
            },
            {
              occurrenceId: 'OCC-3',
              date: '2026-11-06',
              period: 2,
              classId: 'C1',
              className: '虚构一年一班',
              subjectId: 'S-YY',
              subjectName: '英语',
              remainingCount: 1,
              hints: [],
              blockedReasons: ['你在该时段已有课（第2节）'],
              reasons: [],
              score: 60,
            },
          ],
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

    const selects = findAllTag(app, 'select');
    const kindSelect = selects[1];
    expect(kindSelect).toBeDefined();
    kindSelect!.value = 'SWAP';
    kindSelect!.dispatch('change');
    await harness.flush();

    findByText(app, '选择对调对象…')?.dispatch('click');
    await harness.flush();

    const listText = textOf(app);
    // 推荐组只写同班教师；不推荐组必须说明理由，不能悄悄消失
    expect(listText).toContain('推荐（本学期任教该班，共 1 位）');
    expect(listText).toContain('不推荐（共 1 位，仍可选）');
    expect(listText).toContain('本学期不任教该班（跨年级）');
    expect(listText).toContain('2 节可换｜如 2026-11-05 第3节');

    const teacherRow = findAllTag(app, 'button').find((b) => textOf(b).includes('示例教师乙'));
    teacherRow?.dispatch('click');
    await harness.flush();

    // 课次必须具体到日期 + 第几节；冲突项不可点且写明原因
    const lessonText = textOf(app);
    expect(lessonText).toContain('2026-11-05 第3节');
    expect(lessonText).toContain('虚构一年一班 数学');
    const blockedRow = findAllTag(app, 'button').find((b) => textOf(b).includes('2026-11-06 第2节'));
    expect(blockedRow?.disabled).toBe(true);

    // 只认"以课次开头"的行：教师的推荐摘要里也会出现同一日期，不能用 includes
    const lessonRow = findAllTag(app, 'button').find(
      (b) => textOf(b).trim().startsWith('2026-11-05 第3节') && !b.disabled,
    );
    lessonRow?.dispatch('click');
    await harness.flush();
    expect(textOf(app)).toContain('已选：2026-11-05 第3节');

    const form = findAllTag(app, 'form').find((f) => textOf(f).includes('新建调课方案'));
    form?.dispatch('submit');
    await harness.flush();

    const submit = harness.bodies.find((b) => b.path === '/api/changes');
    expect(submit).toBeDefined();
    const items = (submit!.body as {
      items: Array<{ occurrenceId: string; kind: string; toTeacherId: string | null }>;
    }).items;
    expect(items).toHaveLength(2);
    expect(items[0]?.occurrenceId).not.toBe(items[1]?.occurrenceId);
    expect(items.every((i) => i.kind === 'REASSIGN')).toBe(true);
    expect(items.map((i) => i.toTeacherId).sort()).toEqual(['T01', 'T02']);
  });

  it('候选拿不到时不回落全校名单：说明原因、禁止提交', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        // 未改密的账号拿不到候选：这正是最容易退化成"全校名单平铺"的场景
        '/api/changes/candidates/preview': {
          status: 403,
          body: { ok: false, code: 'PASSWORD_CHANGE_REQUIRED' },
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
    switchChangeKind(app, 'REASSIGN');
    await harness.flush();

    const trigger = findByText(app, '候选不可用');
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(true);
    trigger?.dispatch('click');
    await harness.flush();

    const list = findByClass(app, 'picker-list') as FakeNode;
    expect(textOf(list)).toContain('请先修改初始口令');
    // 全校名单绝不能在这种时候被铺出来
    expect(textOf(list)).not.toContain('示例教师乙');

    const form = findAllTag(app, 'form').find((f) => textOf(f).includes('新建调课方案'));
    form?.dispatch('submit');
    await harness.flush();
    expect(harness.requests).not.toContain('/api/changes');
  });

  it('筛选偏好只放在设置页：调课页不出现代课筛选开关，点顶栏"设置"才进得去', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/candidates/preview': { ok: true, candidates: [], excluded: [] },
        '/api/preferences/change': {
          ok: true,
          source: 'NEUTRAL',
          preference: {
            consider: { sameClass: true, sameGrade: true, sameSubject: true, lightLoad: true },
            exclude: { busyAtSlot: false, consecutive: false, consecutiveLimit: 3, dayTotal: false, dayTotalLimit: 6 },
            hint: { classSubjectDay: true, classSubjectDayLimit: 2 },
          },
          canEditSchool: false,
        },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;

    findByText(app, '调课')?.dispatch('click');
    await harness.flush();
    findByText(app, '新建方案')?.dispatch('click');
    await harness.flush();
    // 发起调课的屏幕上只有"这节课、改成什么、给谁"
    expect(textOf(app)).not.toContain('代课候选筛选');
    expect(textOf(app)).not.toContain('保存为我的偏好');

    findByText(app, '设置')?.dispatch('click');
    await harness.flush();
    expect(textOf(app)).toContain('代课候选筛选');
    expect(textOf(app)).toContain('保存为我的偏好');
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

describe('手机布局的结构前提', () => {
  // 样式本身没法在最小 DOM 里断言，但"表格必须被滚动容器包住"这一结构可以。
  // 少了这层容器，窄屏会把五个格子压到 45px 宽，出现逐字竖排——改 CSS 也救不回来。
  it('课表外面套了横向滚动容器，并给出滑动提示', async () => {
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

    const scroller = findByClass(app, 'board-scroll');
    expect(scroller).not.toBeNull();
    expect(findTag(scroller as FakeNode, 'table')).not.toBeNull();
    expect(textOf(app)).toContain('左右滑动查看整周');
  });
});

describe('变更方式默认值', () => {
  // 老师之间最常见的是互换，默认落在"代课"等于每次都要多点一次；
  // 这条测试盯住两件事：下拉初值是 SWAP、进页面就按对调算对象。
  it('新建方案默认对调，不请求代课候选', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/swap-candidates': {
          ok: true,
          recommended: [],
          notRecommended: [],
          preferenceSource: 'NEUTRAL',
        },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;
    findByText(app, '调课')?.dispatch('click');
    await harness.flush();
    findByText(app, '新建方案')?.dispatch('click');
    await harness.flush();

    const kind = findAllTag(app, 'select').find((s) => textOf(s).includes('调整时间（换日期/节次）'));
    expect(kind).not.toBeUndefined();
    expect(kind?.value).toBe('SWAP');
    expect(harness.requests.some((r) => r.startsWith('/api/changes/swap-candidates'))).toBe(true);
    expect(harness.requests.some((r) => r.startsWith('/api/changes/candidates/preview'))).toBe(false);
  });
});

describe('查看他人课表与代发起入口', () => {
  it('课表页有"查看其他老师课表"，默认不铺全校名单', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/refs': {
          ok: true,
          teachers: [
            { id: 'T01', name: '示例教师甲' },
            { id: 'T02', name: '示例教师乙' },
          ],
          classes: [],
          subjects: [],
        },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;

    expect(textOf(app)).toContain('查看其他老师课表');
    // 点开也不铺名单：先让人输入
    findByText(app, '选择教师…')?.dispatch('click');
    expect(textOf(app)).toContain('输入姓名或工号后显示匹配的教师。');
    expect(textOf(app)).not.toContain('示例教师乙');
  });

  it('课表页不预载 refs 时，选择器自己补一次名单再搜索', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/refs': {
          ok: true,
          teachers: [
            { id: 'T01', name: '示例教师甲' },
            { id: 'T02', name: '示例教师乙' },
          ],
          classes: [],
          subjects: [],
        },
      },
      'token-1',
    );
    await harness.flush();
    const app = harness.document.getElementById('app') as FakeNode;

    // 课表页不会主动拉 /api/refs，名单只能由选择器在打开时补
    expect(harness.requests.filter((r) => r.startsWith('/api/refs'))).toHaveLength(0);
    findByText(app, '选择教师…')?.dispatch('click');
    await harness.flush();

    const search = findByClass(app, 'picker-search');
    expect(search).not.toBeNull();
    search!.value = '乙';
    search!.dispatch('input');

    expect(textOf(app)).toContain('示例教师乙');
    expect(textOf(app)).not.toContain('没有匹配的教师。');
  });

  it('只有具备代发起能力，调课页才显示"代其他老师发起"', async () => {
    const common = {
      '/api/me': { ok: true, principal: PRINCIPAL },
      '/api/timetable/me': VIEW,
      '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
      '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
      '/api/changes/swap-candidates': { ok: true, recommended: [], notRecommended: [], preferenceSource: 'NEUTRAL' },
    };

    const plain = createHarness({ ...common, '/api/meta': META }, 'token-1');
    await plain.flush();
    const plainApp = plain.document.getElementById('app') as FakeNode;
    findByText(plainApp, '调课')?.dispatch('click');
    await plain.flush();
    findByText(plainApp, '新建方案')?.dispatch('click');
    await plain.flush();
    expect(textOf(plainApp)).not.toContain('代其他老师发起');

    const allowed = createHarness(
      {
        ...common,
        '/api/meta': {
          ...META,
          capabilities: [
            ...META.capabilities,
            { action: 'CREATE_CHANGE_ON_BEHALF', label: '代他人发起调课方案', verdict: 'ALLOWED' },
          ],
        },
      },
      'token-1',
    );
    await allowed.flush();
    const allowedApp = allowed.document.getElementById('app') as FakeNode;
    findByText(allowedApp, '调课')?.dispatch('click');
    await allowed.flush();
    findByText(allowedApp, '新建方案')?.dispatch('click');
    await allowed.flush();
    expect(textOf(allowedApp)).toContain('代其他老师发起');
  });

  const OTHER_VIEW = {
    ok: true,
    view: {
      complete: true,
      unknownDays: [],
      unresolved: [],
      rows: [
        {
          ...VIEW.view.rows[0],
          occurrenceId: 'OCC-T2-0',
          period: 1,
          teacherId: 'T02',
          teacherName: '示例教师乙',
        },
        {
          ...VIEW.view.rows[0],
          occurrenceId: 'OCC-T2-1',
          period: 2,
          teacherId: 'T02',
          teacherName: '示例教师乙',
        },
      ],
    },
  };

  async function openOtherBoard(harness: ReturnType<typeof createHarness>) {
    const app = harness.document.getElementById('app') as FakeNode;
    findByText(app, '选择教师…')?.dispatch('click');
    await harness.flush();
    const search = findByClass(app, 'picker-search') as FakeNode;
    search.value = '乙';
    search.dispatch('input');
    findAllTag(app, 'button')
      .find((b) => textOf(b).includes('示例教师乙'))
      ?.dispatch('click');
    await harness.flush();
    return app;
  }

  it('打开他人课表后，本人课表收起，只留对方那张', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/timetable/teacher/T02': OTHER_VIEW,
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = await openOtherBoard(harness);

    expect(harness.document.getElementById('timetable-mine')?.hidden).toBe(true);
    expect(harness.document.getElementById('timetable-other')?.hidden).toBe(false);
    expect(textOf(app)).toContain('示例教师乙 的课表');
    expect(findByText(app, '返回我的课表')).not.toBeNull();

    findByText(app, '返回我的课表')?.dispatch('click');
    expect(harness.document.getElementById('timetable-mine')?.hidden).toBe(false);
    expect(harness.document.getElementById('timetable-other')?.hidden).toBe(true);
  });

  it('没有代发起能力：他人课表格子不可点', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': META,
        '/api/timetable/me': VIEW,
        '/api/timetable/teacher/T02': OTHER_VIEW,
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
      },
      'token-1',
    );
    await harness.flush();
    const app = await openOtherBoard(harness);

    const other = harness.document.getElementById('timetable-other') as FakeNode;
    const clickableSlots = findAllTag(other, 'button').filter((b) => b.className.split(' ').includes('slot'));
    expect(clickableSlots).toHaveLength(0);
    expect(textOf(other)).toContain('只读视图，不能在此发起任何操作。');
  });

  it('有代发起能力：点对方一节课，直接带着这节课进入代发起', async () => {
    const harness = createHarness(
      {
        '/api/me': { ok: true, principal: PRINCIPAL },
        '/api/meta': {
          ...META,
          capabilities: [
            ...META.capabilities,
            { action: 'CREATE_CHANGE_ON_BEHALF', label: '代他人发起调课方案', verdict: 'ALLOWED' },
          ],
        },
        '/api/timetable/me': VIEW,
        '/api/timetable/teacher/T02': OTHER_VIEW,
        '/api/refs': { ok: true, teachers: [{ id: 'T02', name: '示例教师乙' }], classes: [], subjects: [] },
        '/api/changes/mine': { ok: true, submitted: [], awaiting: [] },
        '/api/changes/swap-candidates': { ok: true, recommended: [], notRecommended: [], preferenceSource: 'NEUTRAL' },
      },
      'token-1',
    );
    await harness.flush();
    const app = await openOtherBoard(harness);

    const other = harness.document.getElementById('timetable-other') as FakeNode;
    // 点第二节（OCC-T2-1），而不是第一节：验证带过来的是被点的那节
    const slot = findAllTag(other, 'button').filter((b) => b.className.split(' ').includes('slot'))[1];
    expect(slot).not.toBeUndefined();
    slot?.dispatch('click');
    await harness.flush();

    // 已切到调课页，并且自动进入代发起、选中了刚才那一节
    expect(textOf(app)).toContain('取消代发起');
    expect(textOf(app)).toContain('已选：示例教师乙');
    const occurrence = findAllTag(app, 'select').find((s) =>
      findAllTag(s, 'option').some((o) => o.getAttribute('value') === 'OCC-T2-1'),
    );
    const chosen = findAllTag(occurrence as FakeNode, 'option').find(
      (o) => o.getAttribute('value') === 'OCC-T2-1',
    );
    expect(chosen?.getAttribute('selected')).toBe('');
  });
});
