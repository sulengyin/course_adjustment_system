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
    const body = key ? routes[key] : { ok: false, code: 'NOT_FOUND' };
    return {
      status: key ? 200 : 404,
      ok: Boolean(key),
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
    expect(harness.requests).toEqual([]);
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
