'use strict';

/**
 * 校内课务协同系统 · 内网界面
 *
 * 约束（与 docs/02、docs/permission-matrix.md 一致）：
 *  1. 页面只呈现服务端返回的事实与判定，不自行推断"应该可以"。
 *  2. 任何"待校方确认"的能力都显示为禁用 + 原因，而不是隐藏按钮装作没有。
 *  3. 不拼接 HTML：所有动态内容一律走 textContent / DOM API。
 */

const ROLE_LABEL = { T: '教师', S: '课务管理人员', C: '协调者', R: '记录者', J: '争议裁决者', A: '系统管理员' };
const STATUS_LABEL = {
  DRAFT: '草稿',
  PENDING_CONFIRMATION: '待确认',
  BLOCKED_CONFLICT: '需要补全',
  APPLYING: '生效中',
  EFFECTIVE: '已生效',
  REJECTED: '已拒绝',
  WITHDRAWN: '已撤回',
};
const KIND_LABEL = { REASSIGN: '代课', MOVE: '调整时间', CANCEL: '停课' };
const VERDICT_LABEL = { ALLOWED: '可用', FORBIDDEN: '无此权限', ROLE_NOT_ASSIGNED: '待校方确认' };
const EMERGENCY_STATUS = {
  REQUESTED: '已求助',
  COORDINATING: '协调中',
  CLOSED: '已结案',
};
const EMERGENCY_ACTIONS = [
  ['notify', '标记已通知'],
  ['oral-accept', '登记口头接受'],
  ['claim', '接单'],
  ['transfer', '移交协调'],
  ['closure', '提交结案'],
  ['closure-confirm', '批准结案'],
  ['execution', '录入执行事实'],
  ['overdue', '逾期判定'],
];

const ENV_TEXT = {
  DEMO: '演示 / 联调环境　库内全部为虚构数据　不得导入真实名单与真实课表',
  PRODUCTION: '正式业务环境　库内为真实业务数据　不得载入虚构演示数据',
};

const state = {
  token: '',
  principal: null,
  meta: null,
  envMode: null,
  section: 'timetable',
  termId: null,
  weekStart: null,
  changeTab: 'awaiting',
  pendingOccurrence: null,
  /** 从"他人课表"点某一节跳过来时带的上下文；由调课页消费一次后清空。 */
  pendingBehalf: null,
  /** 导航切换会重建整个 shell，旧滑块的几何先存这里，新 DOM 从它出发补一段滑动。 */
  navPillFrom: null,
  selectedSlot: null,
  selectedCase: null,
  emergencyPicked: null,
  renderToken: 0,
};

const app = document.getElementById('app');
const toastBox = document.getElementById('toast');
const envBanner = document.getElementById('env-banner');
let toastTimer = 0;

/**
 * 环境横幅在登录前就要显示：等到登录后才提示，用户已经把演示数据看过一轮了。
 * 拿不到就保持隐藏——不猜，也不写死一种环境。
 */
async function loadEnv() {
  try {
    const res = await fetch('/api/env');
    if (!res.ok) return;
    const body = await res.json();
    state.envMode = typeof body.deploymentMode === 'string' ? body.deploymentMode : null;
  } catch {
    state.envMode = null;
  }
  if (!envBanner) return;
  const text = ENV_TEXT[state.envMode];
  if (!text) {
    envBanner.hidden = true;
    return;
  }
  envBanner.textContent = text;
  envBanner.className = `env-banner ${state.envMode === 'DEMO' ? 'demo' : 'production'}`;
  envBanner.hidden = false;
}

/* ------------------------------------------------------------------ 基础工具 */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 搜索式教师选择器：默认不铺名单，输入姓名或工号才出结果。
 *
 * 全校一百多位老师平铺出来，"选人"就变成了翻名单；
 * 输入两个字就能定位，是选人而不是找人。
 */
function createTeacherPicker(options = {}) {
  const placeholder = options.placeholder ?? '输入姓名或工号';
  const excludeTeacherId = options.excludeTeacherId ?? null;
  const onPick = options.onPick ?? null;

  const search = el('input', { type: 'search', class: 'picker-search', placeholder });
  const list = el('div', { class: 'picker-list' });
  const trigger = el('button', { type: 'button', class: 'btn picker-trigger' }, '选择教师…');
  const close = el('button', { type: 'button', class: 'btn ghost' }, '收起');
  const panel = el('div', { class: 'picker', hidden: true }, el('div', { class: 'row tight' }, search, close), list);
  let picked = null;
  let loading = false;
  let loadError = false;

  /**
   * 课表页不预载 refs（只有调课页会），所以这里得自己补一次。
   * 否则名单是空的，输什么都会落到“没有匹配的教师”，看起来像查无此人。
   */
  async function ensureTeachers() {
    if ((state.refs?.teachers ?? []).length > 0) return;
    loading = true;
    loadError = false;
    renderList();
    const r = await api('/api/refs');
    loading = false;
    if (r.data?.ok) state.refs = r.data;
    else loadError = true;
    renderList();
  }

  function renderList() {
    clear(list);
    const query = search.value.trim().toLowerCase();
    if (query === '') {
      list.append(el('p', { class: 'hint' }, '输入姓名或工号后显示匹配的教师。'));
      return;
    }
    if (loading) {
      list.append(el('p', { class: 'hint' }, '正在读取教师名单…'));
      return;
    }
    if (loadError) {
      list.append(el('p', { class: 'hint' }, '教师名单读取失败，请收起后重新打开。'));
      return;
    }
    const matched = (state.refs?.teachers ?? []).filter(
      (t) =>
        t.id !== excludeTeacherId &&
        (t.name.toLowerCase().includes(query) || t.id.toLowerCase().includes(query)),
    );
    if (matched.length === 0) {
      list.append(el('p', { class: 'hint' }, '没有匹配的教师。'));
      return;
    }
    for (const t of matched.slice(0, 30)) {
      list.append(
        el(
          'button',
          {
            class: 'picker-row',
            type: 'button',
            onclick: () => {
              picked = t;
              trigger.textContent = `已选：${t.name}`;
              panel.hidden = true;
              if (onPick) onPick(t);
            },
          },
          el('span', { class: 'grow' }, t.name),
          el('span', { class: 'hint' }, t.id),
        ),
      );
    }
    if (matched.length > 30) {
      list.append(el('p', { class: 'hint' }, `还有 ${matched.length - 30} 位，继续输入以缩小范围`));
    }
  }

  search.addEventListener('input', renderList);
  trigger.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      if ((state.refs?.teachers ?? []).length === 0) ensureTeachers();
      else renderList();
      search.focus();
    }
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
  });

  return {
    root: el('div', { class: 'field' }, trigger, panel),
    get picked() {
      return picked;
    },
    reset(label = '选择教师…') {
      picked = null;
      trigger.textContent = label;
      panel.hidden = true;
      search.value = '';
      clear(list);
    },
    /** 由外部指定选中的人（例如从他人课表点某一节跳过来），不触发 onPick。 */
    setPicked(teacher) {
      picked = teacher;
      trigger.textContent = `已选：${teacher.name}`;
      panel.hidden = true;
    },
  };
}

function toast(message, isError) {
  if (!toastBox) return;
  toastBox.textContent = message;
  toastBox.className = `toast show${isError ? ' error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBox.className = 'toast';
  }, 3600);
}

function badge(text, kind) {
  return el('span', { class: `badge${kind ? ` ${kind}` : ''}` }, text);
}

function notice(text, kind) {
  return el('div', { class: `notice${kind ? ` ${kind}` : ''}` }, text);
}

function dateInputValue(iso) {
  return iso || '';
}

function parseISO(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

function mondayOf(iso) {
  const d = parseISO(iso);
  const day = d.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return addDays(iso, delta);
}

function todayISO() {
  return toISO(new Date());
}

function fmtDate(iso) {
  const d = parseISO(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五'];

function weekNumber(term, monday) {
  const diff = Math.round((parseISO(monday).getTime() - parseISO(term.startMonday).getTime()) / 86400000);
  return Math.floor(diff / 7) + 1;
}

function weekLabel(term, monday) {
  const n = weekNumber(term, monday);
  let parity = '';
  if (term.firstWeekParity === 'ODD') parity = n % 2 === 1 ? '单周' : '双周';
  else if (term.firstWeekParity === 'EVEN') parity = n % 2 === 0 ? '单周' : '双周';
  else parity = '单双周基准未配置';
  return `第 ${n} 周 · ${parity}`;
}

function defaultWeekStart(term) {
  const today = todayISO();
  if (today < term.startMonday) return term.startMonday;
  if (today > term.endDate) return mondayOf(term.endDate);
  return mondayOf(today);
}

function currentTerm() {
  const terms = state.meta?.terms ?? [];
  return terms.find((t) => t.id === state.termId) ?? terms[0] ?? null;
}

function newIdempotencyKey() {
  // 内网多为明文 HTTP，crypto.randomUUID 只在安全上下文存在，必须留退路。
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadToken() {
  try {
    return window.sessionStorage.getItem('ca.token') ?? '';
  } catch {
    return '';
  }
}

function saveToken(token) {
  try {
    if (token) window.sessionStorage.setItem('ca.token', token);
    else window.sessionStorage.removeItem('ca.token');
  } catch {
    /* 隐私模式下不可写：退化为仅内存保存 */
  }
  state.token = token;
}

/* ------------------------------------------------------------------ 网络 */

async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  // 401 只在"身份未通过"（UNAUTHENTICATED）时才是会话失效。
  // 登录接口的 401 是"账号或口令不对"，改密接口的 401 是"原口令不对"——
  // 两者都是表单要处理的业务错误，若按会话失效处理，会清空已填内容并弹回登录页，
  // 把用户引向"会话/网络有问题"的错误方向。
  if (res.status === 401 && data.code === 'UNAUTHENTICATED') {
    saveToken('');
    state.principal = null;
    renderLogin('登录已失效，请重新登录');
    throw new Error('UNAUTHENTICATED');
  }
  return { status: res.status, ok: res.ok, data };
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  await loadEnv();
  saveToken(loadToken());
  if (!state.token) return renderLogin();
  try {
    const me = await api('/api/me');
    state.principal = me.data.principal ?? null;
  } catch {
    return undefined;
  }
  if (!state.principal) return renderLogin();
  if (state.principal.mustChangePassword) return renderChangePassword(true);
  await loadMeta();
  renderShell();
  return undefined;
}

async function loadMeta() {
  const meta = await api('/api/meta');
  state.meta = meta.data;
  state.termId = state.termId ?? state.meta?.terms?.[0]?.id ?? null;
}

function capability(action) {
  const list = state.meta?.capabilities ?? [];
  return list.find((c) => c.action === action)?.verdict ?? 'FORBIDDEN';
}

/* ------------------------------------------------------------------ 登录 */

function renderLogin(message) {
  clear(app);
  const loginName = el('input', { id: 'login-name', autocomplete: 'username', required: true });
  const password = el('input', { id: 'login-password', type: 'password', autocomplete: 'current-password', required: true });
  const roleSelect = el('select', { id: 'login-role' });
  const roleField = el('label', { class: 'field', hidden: true }, el('span', {}, '以哪个身份登录'), roleSelect);
  const msg = el('div', { class: 'msg' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, '登录');

  const form = el(
    'form',
    {
      class: 'login',
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        msg.className = 'msg';
        msg.textContent = '正在校验…';
        try {
          const body = { loginName: loginName.value.trim(), password: password.value };
          if (!roleField.hidden && roleSelect.value) body.actingRole = roleSelect.value;
          const res = await api('/api/auth/login', { method: 'POST', body });
          if (res.ok) {
            saveToken(String(res.data.token));
            state.principal = res.data.principal;
            if (state.principal.mustChangePassword) return renderChangePassword(true);
            await loadMeta();
            return renderShell();
          }
          if (res.data.code === 'AMBIGUOUS_ROLE' && Array.isArray(res.data.roles)) {
            roleField.hidden = false;
            clear(roleSelect);
            for (const role of res.data.roles) {
              roleSelect.append(el('option', { value: role }, `${ROLE_LABEL[role] ?? role}（${role}）`));
            }
            msg.className = 'msg error';
            msg.textContent = '该账号有多个身份，请选择本次以哪个身份登录。';
            return undefined;
          }
          msg.className = 'msg error';
          msg.textContent = loginErrorText(res.data.code);
          return undefined;
        } catch (error) {
          msg.className = 'msg error';
          msg.textContent = '无法连接服务，请确认已接入校内网络。';
          return undefined;
        } finally {
          submit.disabled = false;
        }
      },
    },
    el('h1', {}, '校内课务协同系统'),
    el('p', { class: 'sub' }, '第一版仅限校内网络访问。账号由学校统一开通，不提供自助注册。'),
    el('label', { class: 'field' }, el('span', {}, '账号'), loginName),
    el('label', { class: 'field' }, el('span', {}, '口令'), password),
    roleField,
    submit,
    msg,
    message ? notice(message, 'warn') : null,
  );

  app.append(el('div', { class: 'login-wrap' }, form));
  loginName.focus();
}

function loginErrorText(code) {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return '账号或口令不正确。';
    case 'ACCOUNT_DISABLED':
      return '账号已停用，请联系课务管理人员或系统管理员。';
    case 'ROLE_NOT_GRANTED':
      return '该账号没有此身份。';
    case 'NO_ROLE':
      return '该账号尚未分配身份，请联系系统管理员。';
    case 'BAD_INPUT':
      return '请填写账号与口令。';
    default:
      return `登录失败（${code ?? '未知原因'}）。`;
  }
}

/* ------------------------------------------------------------------ 改密 */

function renderChangePassword(forced) {
  clear(app);
  const oldPassword = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPassword = el('input', { type: 'password', autocomplete: 'new-password' });
  const again = el('input', { type: 'password', autocomplete: 'new-password' });
  const msg = el('div', { class: 'msg' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, '修改口令');

  const form = el(
    'form',
    {
      class: 'login',
      onsubmit: async (event) => {
        event.preventDefault();
        msg.className = 'msg';
        if (newPassword.value !== again.value) {
          msg.className = 'msg error';
          msg.textContent = '两次输入的新口令不一致。';
          return;
        }
        submit.disabled = true;
        try {
          const res = await api('/api/me/password', {
            method: 'POST',
            body: { oldPassword: oldPassword.value, newPassword: newPassword.value },
          });
          // 必须按状态码判断：改密被拒绝时服务端返回 400/401，
          // 若一律当作成功，用户会拿着没生效的新口令去登录，且不知道改密其实失败了。
          if (!res.ok) {
            msg.className = 'msg error';
            msg.textContent = passwordErrorText(res.data.code, res.data.message);
            return;
          }
          saveToken('');
          state.principal = null;
          renderLogin('口令已修改，请用新口令重新登录。');
        } catch {
          msg.className = 'msg error';
          msg.textContent = '修改失败：无法连接服务，请确认已接入校内网络。';
        } finally {
          submit.disabled = false;
        }
      },
    },
    el('h1', {}, forced ? '首次登录需修改口令' : '修改口令'),
    el('p', { class: 'sub' }, '系统不采集手机号，无法自助找回。忘记口令请联系系统管理员重置。'),
    el('label', { class: 'field' }, el('span', {}, '原口令'), oldPassword),
    el('label', { class: 'field' }, el('span', {}, '新口令'), newPassword),
    el('label', { class: 'field' }, el('span', {}, '再次输入新口令'), again),
    submit,
    msg,
  );

  app.append(el('div', { class: 'login-wrap' }, form));
  oldPassword.focus();
}

/* ------------------------------------------------------------------ 改密失败文案 */

function passwordErrorText(code, serverMessage) {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return '原口令不正确。';
    case 'WEAK_PASSWORD': {
      const rule = '至少 12 位，含字母、数字、符号中的两类，且不能与原口令相同';
      return typeof serverMessage === 'string' && serverMessage
        ? `${serverMessage}（${rule}）`
        : `新口令不符合要求：${rule}。`;
    }
    case 'BAD_INPUT':
      return '请完整填写原口令与新口令。';
    default:
      return `修改失败（${code ?? '未知原因'}）。`;
  }
}

/* ------------------------------------------------------------------ 外壳 */

function logoutLocal() {
  saveToken('');
  state.principal = null;
  state.meta = null;
  state.weekStart = null;
}

/**
 * 切换当前会话身份。服务端会作废旧会话并签发新令牌，
 * 因此必须立刻替换本地 token，否则接下来的请求都按"会话失效"处理。
 */
async function switchIdentity(role) {
  if (!state.principal || role === state.principal.actingRole) return;
  try {
    const res = await api('/api/auth/switch-role', { method: 'POST', body: { actingRole: role } });
    if (!res.ok) {
      toast(res.data.message || '身份切换失败', true);
      return;
    }
    saveToken(res.data.token);
    state.principal = res.data.principal;
    await loadMeta();
    toast(`已切换为${ROLE_LABEL[role] ?? role}`);
    go('access');
  } catch (error) {
    if (String(error?.message) === 'UNAUTHENTICATED') return;
    toast(`身份切换失败：${error?.message ?? error}`, true);
  }
}

function renderShell() {
  clear(app);
  const p = state.principal;
  const nav = el('nav', { class: 'nav' });

  const items = [];
  // 没有教师档案的身份没有"本人课表/本人调课/本人求助"，不显示空壳入口。
  if (p.teacherId) {
    items.push(['timetable', '我的课表'], ['changes', '调课'], ['emergency', '应急求助']);
  }
  items.push(['access', '权限与审计']);
  if (capability('VIEW_SCHOOL_AUDIT') === 'ALLOWED') items.push(['school', '系统状态']);
  // 设置不是导航里的一个区，而是顶栏的全局入口；别把它挤回主导航第一项。
  if (state.section !== 'settings' && !items.some(([key]) => key === state.section)) {
    state.section = items[0][0];
  }

  // 导航滑块要在 nav 进文档之后才能量到尺寸，所以这里只建节点，末尾再定位。
  let navPill = null;

  for (const [key, label] of items) {
    nav.append(
      el(
        'button',
        {
          type: 'button',
          'aria-current': state.section === key ? 'page' : null,
          onclick: () => {
            // renderShell 会把整个导航换掉，先把滑块当前位置带走
            state.navPillFrom = navPill ? navPill.snapshot() : null;
            go(key);
          },
        },
        label,
      ),
    );
  }
  navPill = mountPill(nav, { activeSelector: '[aria-current="page"]', baseClass: 'nav' });

  // 一人多角色：换身份不等于换人。旧会话作废、新会话签发，审计里记 SWITCH_ROLE。
  const roleSelect =
    p.roles.length > 1
      ? el(
          'select',
          {
            class: 'role-select',
            title: '切换身份（同一账号的多重职责，不是换人）',
            onchange: (event) => {
              const next = event.target.value;
              event.target.value = p.actingRole;
              switchIdentity(next);
            },
          },
          ...p.roles.map((role) =>
            el('option', { value: role, selected: role === p.actingRole }, ROLE_LABEL[role] ?? role),
          ),
        )
      : null;

  const header = el(
    'header',
    { class: 'topbar' },
    el('div', { class: 'brand' }, '校内课务协同系统'),
    badge('纯内网', 'brand'),
    el('div', { class: 'spacer' }),
    el(
      'div',
      { class: 'who' },
      el('span', {}, `${p.displayName}${roleSelect ? '' : `　${ROLE_LABEL[p.actingRole] ?? p.actingRole}`}`),
      roleSelect,

      el(
        'button',
        {
          class: 'btn ghost',
          type: 'button',
          title: '偏好与筛选口径',
          onclick: () => go('settings'),
        },
        '设置',
      ),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => renderChangePassword(false) }, '改密'),
      el(
        'button',
        {
          class: 'btn ghost',
          type: 'button',
          onclick: async () => {
            try {
              await api('/api/auth/logout', { method: 'POST' });
            } catch {
              /* 会话可能已过期，本地清理即可 */
            }
            logoutLocal();
            renderLogin('已退出登录。');
          },
        },
        '退出',
      ),
    ),
  );

  const main = el('main', { id: 'view' });
  const foot = el(
    'div',
    { class: 'foot' },
    '本系统不代替学校决定制度：标有"待校方确认"的职责在获得书面依据前一律不可用。界面数据来源见各页标注。',
  );

  app.append(header, nav, main, foot);
  bindTopbarScroll();
  // nav 已经进文档，这时候量 offsetLeft 才有意义
  navPill.move({ from: state.navPillFrom });
  state.navPillFrom = null;
  renderSection(main);
}

/**
 * 顶栏滚动后加一道投影：内容从它下面穿过去时，边界需要一点重量。
 * 只绑一次监听（renderShell 会反复重建顶栏，绑多次就会越积越多）。
 */
let topbarScrollBound = false;
function bindTopbarScroll() {
  if (topbarScrollBound) return;
  if (typeof window.addEventListener !== 'function' || typeof document.querySelector !== 'function') return;
  topbarScrollBound = true;
  const sync = () => {
    const bar = document.querySelector('.topbar');
    if (bar) bar.classList.toggle('is-scrolled', (window.scrollY || 0) > 4);
  };
  window.addEventListener('scroll', sync, { passive: true });
  sync();
}

function go(section) {
  state.section = section;
  state.selectedSlot = null;
  state.selectedCase = null;
  renderShell();
  window.scrollTo(0, 0);
}

/**
 * 分段控件的滑块，导航与页签共用。
 *
 * 位置不按等分算：导航项和页签的文字长短都不一样（"待我确认（3）" vs "新建方案"），
 * 用 (100% / n) * i 一定会越走越偏。这里直接量选中项的 offsetLeft/offsetWidth，
 * 位移和宽度一起变，长短项都对得上。
 *
 * 三种时机要分开：
 * - 首次定位：直接落位，不能滑——否则一进页面就看见方块从左上角飞过来；
 * - 同一 DOM 内切换：CSS 过渡自己会滑，这是唯一"真动画"的路径；
 * - 跨 DOM 重建（导航换区会重建整个 shell）：新节点先落在旧几何上，下一帧再动。
 */
function mountPill(container, options = {}) {
  const selector = options.activeSelector ?? '[aria-selected="true"]';
  const baseClass = options.baseClass ?? String(container.className || '').trim();

  const pill = el('span', { class: 'pill', 'aria-hidden': 'true' });
  container.append(pill);

  let last = null;
  let broken = null;

  function mark(noPill) {
    if (broken === noPill) return;
    broken = noPill;
    container.className = noPill ? `${baseClass} no-pill` : baseClass;
  }

  function measure() {
    if (typeof container.querySelector !== 'function') return null;
    const active = container.querySelector(selector);
    if (!active) return null;
    const geo = {
      x: active.offsetLeft,
      y: active.offsetTop,
      w: active.offsetWidth,
      h: active.offsetHeight,
    };
    if (![geo.x, geo.y, geo.w, geo.h].every((n) => Number.isFinite(n))) return null;
    if (geo.w <= 0 || geo.h <= 0) return null;
    // 页签在窄屏会折行：一颗胶囊跨不了两行，宁可不画，让按钮自己带底
    const items = typeof container.querySelectorAll === 'function' ? container.querySelectorAll('button') : [];
    for (const item of items) if (item.offsetTop !== geo.y) return null;
    return geo;
  }

  function paint(geo, instant) {
    if (!pill.style || typeof pill.style.setProperty !== 'function') return;
    pill.style.setProperty('--pill-x', `${geo.x}px`);
    pill.style.setProperty('--pill-y', `${geo.y}px`);
    pill.style.setProperty('--pill-w', `${geo.w}px`);
    pill.style.setProperty('--pill-h', `${geo.h}px`);
    pill.className = instant ? 'pill is-on is-instant' : 'pill is-on';
  }

  function move(opts = {}) {
    const target = measure();
    if (!target) {
      pill.className = 'pill';
      last = null;
      mark(true);
      return;
    }
    mark(false);

    const from = opts.from && last === null ? opts.from : null;
    if (from) {
      paint(from, true);
      // 强制一次样式计算，把"旧位置"钉成过渡起点；
      // 少了这一步，两次赋值会被合并，看到的还是瞬移。
      if (typeof pill.offsetWidth === 'number') void pill.offsetWidth;
      pill.className = 'pill is-on';
      const step = () => paint(target, false);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
      else step();
    } else if (last === null) {
      paint(target, true);
      pill.className = 'pill is-on';
    } else {
      paint(target, false);
    }
    last = target;
  }

  return {
    move,
    /** 换 DOM 之前先记下现在停在哪，供新节点接着滑 */
    snapshot: () => last ?? measure(),
  };
}

async function renderSection(main) {
  const token = ++state.renderToken;
  const view = el('div');
  main.append(view);
  try {
    if (state.section === 'timetable') await sectionTimetable(view, token);
    else if (state.section === 'changes') await sectionChanges(view, token);
    else if (state.section === 'emergency') await sectionEmergency(view, token);
    else if (state.section === 'access') await sectionAccess(view, token);
    else if (state.section === 'school') await sectionSchool(view, token);
    else if (state.section === 'settings') await renderSettings(view, token);
  } catch (error) {
    if (String(error?.message) === 'UNAUTHENTICATED') return;
    if (token !== state.renderToken) return;
    view.append(notice(`页面加载失败：${error?.message ?? error}`, 'danger'));
  }
}

/* ------------------------------------------------------------------ 课表 */

function termToolbar(onChange) {
  const terms = state.meta?.terms ?? [];
  const select = el(
    'select',
    {
      onchange: (event) => {
        state.termId = event.target.value;
        state.weekStart = null;
        onChange();
      },
    },
    ...terms.map((t) => el('option', { value: t.id, selected: t.id === currentTerm()?.id }, t.label)),
  );
  return select;
}

function sourceBadge(origin) {
  if (origin === 'SIMULATED') return badge('模拟数据', 'warn');
  if (origin === 'IMPORTED_UNVERIFIED') return badge('导入未核验', 'warn');
  if (origin === 'OFFICIAL') return badge('学校正式', 'ok');
  return badge(String(origin ?? '来源未知'));
}

async function sectionTimetable(view, token) {
  const term = currentTerm();
  if (!term) {
    view.append(notice('数据库中没有学期数据。请先导入课表，或在测试环境运行 npm run seed:demo。', 'warn'));
    return;
  }
  if (!state.weekStart) state.weekStart = defaultWeekStart(term);
  const from = state.weekStart;
  const to = addDays(from, 6);

  // 周切换在窄屏占满一行等分三段：三个按钮各自宽度不同会显得散，且"本周"容易被挤到下一行孤零零一行。
  const toolbar = el(
    'div',
    { class: 'row week-bar' },
    el('label', { class: 'field' }, el('span', {}, '学期'), termToolbar(() => renderSectionRefresh())),
    el('div', { class: 'spacer grow' }),
    el(
      'div',
      { class: 'week-nav' },
      el('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(-1) }, '上一周'),
      el(
        'button',
        { class: 'btn', type: 'button', onclick: () => { state.weekStart = defaultWeekStart(term); renderSectionRefresh(); } },
        '本周',
      ),
      el('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(1) }, '下一周'),
    ),
  );

  const headCard = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'row' },
      el('h2', { class: 'grow' }, `${term.label} · ${weekLabel(term, from)}`),
      sourceBadge(term.dataOrigin),
    ),
    el('p', { class: 'hint' }, `${from} ~ ${to}　（只显示本人承担的课次；已生效调课已叠加）`),
    toolbar,
  );

  // 两张课表不同时出现：看别人的课时先把自己的收起来，
  // 否则上下两块格子长得一样，点错一格就是以别人的名义建了单。
  const mineBox = el('div', { id: 'timetable-mine' });
  const otherBox = el('div', { id: 'timetable-other', hidden: true });
  mineBox.append(headCard);
  view.append(mineBox, otherBox);

  function backToMine() {
    otherBox.hidden = true;
    clear(otherBox);
    mineBox.hidden = false;
  }

  function showOther(teacher, list, otherFrom) {
    const canBehalf = capability('CREATE_CHANGE_ON_BEHALF') === 'ALLOWED';
    clear(otherBox);
    mineBox.hidden = true;
    otherBox.hidden = false;
    otherBox.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row' },
          el('h2', { class: 'grow' }, `${teacher.name} 的课表`),
          el('button', { class: 'btn', type: 'button', onclick: backToMine }, '返回我的课表'),
        ),
        el(
          'p',
          { class: 'hint' },
          `${otherFrom} ~ ${addDays(otherFrom, 6)}　${
            canBehalf
              ? '点一节课可直接代他发起调课；提交后仍要他本人确认。'
              : '只读视图，不能在此发起任何操作。'
          }`,
        ),
      ),
    );
    otherBox.append(
      renderBoard(list, otherFrom, {
        readOnly: !canBehalf,
        // 持有代发起能力时，点格子＝以对方名义发起；没有能力时格子是死的。
        onSlotClick: canBehalf
          ? (row) => {
              if (row.cancelled) {
                toast('这节课已由生效方案停课，不能再发起调课。', true);
                return;
              }
              state.pendingBehalf = {
                teacherId: teacher.id,
                teacherName: teacher.name,
                occurrenceId: row.occurrenceId,
              };
              state.pendingOccurrence = null;
              state.changeTab = 'new';
              go('changes');
            }
          : null,
      }),
    );
  }

  const res = await api(`/api/timetable/me?termId=${encodeURIComponent(term.id)}&from=${from}&to=${to}`);
  if (token !== state.renderToken) return;
  if (!res.data.ok) {
    const code = res.data.code ?? String(res.status);
    const text =
      code === 'NOT_A_TEACHER'
        ? '当前身份未绑定教师档案，因此没有"本人课表"。课务管理请使用导入预览与系统状态页。'
        : `无法读取课表（${code}）。`;
    mineBox.append(notice(text, 'warn'));
    return;
  }

  const v = res.data.view ?? {};
  const rows = Array.isArray(v.rows) ? v.rows : [];

  if (!v.complete) {
    mineBox.append(
      notice(
        '本视图不完整：存在无法判定的日期或课次。缺时间不等于没课，系统不会替你推断。',
        'warn',
      ),
    );
  }

  mineBox.append(renderBoard(rows, from));
  mineBox.append(renderOtherTimetableCard(term, { onEnter: showOther }));

  const pending = el('div', { id: 'slot-detail' });
  mineBox.append(pending);
  if (state.selectedSlot) renderSlotDetail(pending, state.selectedSlot, term);

  const issues = [];
  for (const d of v.unknownDays ?? []) issues.push(`${d.date}：${d.reason}`);
  for (const u of v.unresolved ?? []) issues.push(`${u.date ?? ''} ${u.templateId ?? ''}：${u.reason ?? 'UNRESOLVED'}`);
  if (issues.length > 0) {
    mineBox.append(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, `待核验事项（${issues.length}）`),
        el('p', { class: 'hint' }, '这些日期/课次的原因未确认，不参与"有没有课"的判断。'),
        el('ul', {}, ...issues.slice(0, 30).map((line) => el('li', {}, line))),
      ),
    );
  }
}

function renderSectionRefresh() {
  const main = document.getElementById('view');
  if (!main) return;
  clear(main);
  renderSection(main);
}

function shiftWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  renderSectionRefresh();
}

/** 今天：优先用服务端时间，避免老师电脑时钟不准导致高亮错列。 */
function todayIso() {
  const raw = state.meta?.serverTime;
  const parsed = typeof raw === 'string' ? new Date(raw) : null;
  const d = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderBoard(rows, from, options = {}) {
  const readOnly = options.readOnly === true;
  const bare = options.bare === true;
  /** 点格子时做什么：默认是展开本页详情，他人课表则由调用方决定（如直接代发起）。 */
  const onSlotClick = options.onSlotClick ?? null;
  const dates = WEEKDAYS.map((_, i) => addDays(from, i));
  const today = todayIso();
  const periods = [...new Set(rows.map((r) => r.period))].sort((a, b) => a - b);
  const maxPeriod = periods.length > 0 ? Math.max(...periods) : 8;
  const list = [];
  for (let p = 1; p <= maxPeriod; p++) list.push(p);

  const head = el(
    'tr',
    {},
    el('th', { class: 'period-head' }, '节次'),
    ...dates.map((d, i) =>
      el(
        'th',
        d === today ? { class: 'is-today' } : {},
        WEEKDAYS[i],
        el('span', { class: 'date' }, fmtDate(d)),
      ),
    ),
  );

  const body = el('tbody');
  for (const period of list) {
    const tr = el('tr');
    tr.append(el('td', { class: 'period' }, `第${period}节`));
    for (const date of dates) {
      const cell = el('td', date === today ? { class: 'is-today' } : {});
      const items = rows.filter((r) => r.date === date && r.period === period);
      if (items.length === 0) {
        cell.append(el('div', { class: 'slot empty' }));
      } else {
        for (const row of items) cell.append(slotButton(row, readOnly, onSlotClick));
      }
      tr.append(cell);
    }
    body.append(tr);
  }

  const weekend = rows.filter((r) => !dates.includes(r.date));
  // 窄屏放不下五个 60px 的格子：科目、班级、时间会被压缩成逐字竖排。
  // 这里不改变周视图语义，只把表格放进横向滚动容器，格子保住可读宽度。
  const wrap = bare ? el('div') : el('div', { class: 'card' });
  const scroller = el('div', { class: 'board-scroll' });
  scroller.append(el('table', { class: 'board' }, el('thead', {}, head), body));
  wrap.append(scroller);
  // 只在窄屏显示：宽屏能一屏放下，这句提示没有意义
  wrap.append(el('p', { class: 'board-hint' }, '左右滑动查看整周'));
  if (weekend.length > 0) {
    wrap.append(
      el('div', { class: 'divider' }),
      el('h3', {}, '本时段内的非工作日课次'),
      el('div', { class: 'stack' }, ...weekend.map((r) => slotButton(r, readOnly, onSlotClick))),
    );
  }
  return wrap;
}

/**
 * 查看其他老师课表。
 *
 * permission-matrix 里"查看他人课表"对所有角色都是允许的，只显示班级/学科/时间。
 * 能否从对方课表直接发起，取决于账号级能力 CREATE_CHANGE_ON_BEHALF：
 * 没有这个能力的人看到的仍是纯只读视图，服务端也会拒绝代发起请求。
 */
function renderOtherTimetableCard(term, options = {}) {
  const onEnter = options.onEnter ?? null;
  const canBehalf = capability('CREATE_CHANGE_ON_BEHALF') === 'ALLOWED';
  const status = el('p', { class: 'hint' });
  const picker = createTeacherPicker({
    excludeTeacherId: state.principal?.teacherId ?? null,
    onPick: async (t) => {
      const from = state.weekStart ?? defaultWeekStart(term);
      const to = addDays(from, 6);
      status.textContent = `正在读取 ${t.name} 的课表…`;
      const r = await api(
        `/api/timetable/teacher/${encodeURIComponent(t.id)}?termId=${encodeURIComponent(term.id)}&from=${from}&to=${to}`,
      );
      if (!r.data.ok) {
        status.textContent = `无法读取该教师课表（${r.data.code ?? r.status}）。`;
        return;
      }
      status.textContent = '';
      if (onEnter) onEnter(t, r.data.view?.rows ?? [], from);
    },
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, '查看其他老师课表'),
    el(
      'p',
      { class: 'hint' },
      canBehalf
        ? '输入姓名或工号查找。打开后你自己的课表会暂时收起；在对方课表里点一节课，可直接代他发起调课，提交后仍要他本人确认。'
        : '输入姓名或工号查找。只显示班级、学科与时间，不含调课理由；此视图不能发起任何操作。',
    ),
    picker.root,
    status,
  );
}

function slotButton(row, readOnly = false, onSlotClick = null) {
  const cls = `slot${row.certainty === 'UNKNOWN' ? ' is-unknown' : ''}${row.cancelled ? ' is-cancelled' : ''}${readOnly ? ' is-readonly' : ''}`;
  const content = [
    el('span', { class: 'subject' }, row.subjectName),
    el('span', { class: 'meta' }, `${row.className} · ${row.startsAt ?? '时间未配置'}${row.endsAt ? `-${row.endsAt}` : ''}`),
    el(
      'span',
      { class: 'tags' },
      row.certainty === 'UNKNOWN' ? badge('时间待核验', 'warn') : null,
      row.cancelled ? badge('已停课', 'danger') : null,
    ),
  ];
  // 点击行为由调用方决定：他人课表里点一节＝代他发起，本页课表里点一节＝展开详情。
  if (onSlotClick) {
    return el('button', { class: cls, type: 'button', onclick: () => onSlotClick(row) }, ...content);
  }
  // 他人课表只读：能看排课事实，但不能从这里发起任何操作（否则会拿别人的课次去建单）。
  if (readOnly) return el('div', { class: cls }, ...content);
  return el(
    'button',
    {
      class: cls,
      type: 'button',
      onclick: () => {
        state.selectedSlot = row;
        const box = document.getElementById('slot-detail');
        if (!box) return;
        clear(box);
        renderSlotDetail(box, row, currentTerm());
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
    ...content,
  );
}

function renderSlotDetail(box, row, term) {
  const canChange = capability('CREATE_OWN_CHANGE') === 'ALLOWED';
  const canAsk = capability('REQUEST_HELP') === 'ALLOWED';
  box.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el('h3', { class: 'grow' }, `${row.date} 第${row.period}节 · ${row.subjectName}`),
        sourceBadge(row.dataOrigin),
      ),
      el(
        'dl',
        { class: 'kv' },
        el('dt', {}, '班级'),
        el('dd', {}, row.className),
        el('dt', {}, '任课教师'),
        el('dd', {}, row.teacherName),
        el('dt', {}, '时间'),
        el('dd', {}, row.certainty === 'KNOWN' ? `${row.startsAt} - ${row.endsAt}` : '时间待核验（不推断）'),
        el('dt', {}, '课次 ID'),
        el('dd', { class: 'mono' }, row.occurrenceId),
        el('dt', {}, '状态'),
        el('dd', {}, row.cancelled ? '已由生效方案停课' : '正常'),
      ),
      el(
        'div',
        { class: 'row' },
        canChange
          ? el(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => {
                  state.pendingOccurrence = row;
                  state.changeTab = 'new';
                  go('changes');
                },
              },
              '为这节课发起调课',
            )
          : null,
        canAsk
          ? el(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => {
                  state.emergencyPicked = row;
                  go('emergency');
                },
              },
              '为这节课求助',
            )
          : null,
        el('span', { class: 'hint' }, '调课是"授课责任变更"的总称（代课／对调／调整时间／停课），需要受影响教师本人逐人确认。'),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ 调课 */

async function sectionChanges(view, token) {
  const term = currentTerm();
  if (!term) {
    view.append(notice('数据库中没有学期数据，无法发起调课。', 'warn'));
    return;
  }
  const [mine, refs, pref] = await Promise.all([
    api('/api/changes/mine'),
    api('/api/refs'),
    api('/api/preferences/change'),
  ]);
  if (token !== state.renderToken) return;
  if (!mine.data.ok) {
    view.append(notice(`无法读取调课列表（${mine.data.code ?? mine.status}）。`, 'danger'));
    return;
  }
  let submitted = mine.data.submitted ?? [];
  let awaiting = mine.data.awaiting ?? [];
  state.refs = refs.data.ok ? refs.data : { teachers: [], classes: [], subjects: [] };
  state.pref = pref.data.ok ? pref.data : null;

  const tabs = el('div', { class: 'tabs' });
  const panel = el('div');
  const label = {
    awaiting: () => `待我确认（${awaiting.length}）`,
    submitted: () => `我发起的（${submitted.length}）`,
    new: () => '新建方案',
  };
  const buttons = new Map();
  const tabsPill = mountPill(tabs, { activeSelector: '[aria-selected="true"]', baseClass: 'tabs' });

  async function renderTabBody() {
    if (state.changeTab === 'awaiting') renderAwaiting(panel, awaiting);
    else if (state.changeTab === 'submitted') await renderSubmitted(panel, submitted, token);
    else await renderNewChange(panel, term, token);
  }

  /**
   * 页签切换只重建下面的内容，不重建 tabs 本身。
   * 整块重建的话滑块每次都是"消失→在新位置出现"，滑不起来；
   * 同一批 DOM 上改 aria-selected，CSS 过渡才会把胶囊从旧位置带过去。
   */
  let pendingTab = 0;
  async function selectTab(key) {
    if (key === state.changeTab) return;
    state.changeTab = key;
    for (const [k, btn] of buttons) btn.setAttribute('aria-selected', k === key ? 'true' : 'false');
    tabsPill.move();
    const seq = ++pendingTab;
    clear(panel);
    panel.append(el('p', { class: 'hint' }, '正在读取…'));
    // 切页签仍重新拉一次列表：别人的申请随时会进来，只看进页面时那份快照会漏掉。
    const fresh = await api('/api/changes/mine');
    if (seq !== pendingTab || token !== state.renderToken) return;
    if (fresh.data.ok) {
      submitted = fresh.data.submitted ?? [];
      awaiting = fresh.data.awaiting ?? [];
      for (const [k, btn] of buttons) btn.textContent = label[k]();
      // 计数变了按钮就变宽，滑块按新宽度再量一次（从当前位置续着滑）
      tabsPill.move();
    }
    clear(panel);
    if (!fresh.data.ok) {
      panel.append(notice(`列表刷新失败（${fresh.data.code ?? fresh.status}），以下是进入本页时读到的数据。`, 'warn'));
    }
    await renderTabBody();
  }

  for (const key of ['awaiting', 'submitted', 'new']) {
    const btn = el(
      'button',
      {
        type: 'button',
        'aria-selected': state.changeTab === key ? 'true' : 'false',
        onclick: () => void selectTab(key),
      },
      label[key](),
    );
    buttons.set(key, btn);
    tabs.append(btn);
  }
  view.append(tabs, panel);

  tabsPill.move();
  await renderTabBody();
}

function caseHeadLine(item) {
  const cur = item.current;
  const left = cur
    ? `${cur.className} ${cur.subjectName} · ${cur.date} 第${cur.period}节 · ${cur.teacherName}`
    : `${item.occurrenceId}（课次已不存在）`;
  let right = '';
  if (item.kind === 'REASSIGN') right = `请 ${item.toTeacherName ?? item.toTeacherId ?? '未指定'} 代课`;
  else if (item.kind === 'MOVE') right = `调整到 ${item.toDate ?? '未填写'} 第${item.toPeriod ?? '未填写'}节`;
  else right = '停课';
  return el('div', { class: 'item-line' }, el('span', {}, left), el('span', { class: 'arrow' }, '→'), el('span', {}, right));
}

function statusBadge(status) {
  const map = {
    EFFECTIVE: 'ok',
    PENDING_CONFIRMATION: 'brand',
    BLOCKED_CONFLICT: 'warn',
    REJECTED: 'danger',
    WITHDRAWN: '',
    DRAFT: '',
  };
  return badge(STATUS_LABEL[status] ?? status, map[status] ?? '');
}

function renderAwaiting(panel, list) {
  if (list.length === 0) {
    panel.append(el('div', { class: 'card' }, el('p', { class: 'hint' }, '当前没有需要你确认的方案。')));
    return;
  }
  for (const item of list) {
    const card = el('div', { class: 'case-card' });
    card.append(
      el(
        'div',
        { class: 'head' },
        statusBadge(item.status),
        el('span', { class: 'id' }, item.caseId),
        el('span', { class: 'grow' }),
        el('span', { class: 'hint' }, `版本 ${item.revision}`),
      ),
      el('div', { class: 'stack' }, ...item.items.map((it) => caseHeadLine(it))),
      item.reason ? el('p', { class: 'hint' }, `发起说明：${item.reason}`) : null,
      el(
        'div',
        { class: 'row mt8' },
        el(
          'button',
          {
            class: 'btn ok',
            type: 'button',
            onclick: (event) => decide(item.caseId, 'ACCEPT', event.target),
          },
          '接受',
        ),
        el(
          'button',
          {
            class: 'btn danger',
            type: 'button',
            onclick: (event) => decide(item.caseId, 'DECLINE', event.target),
          },
          '拒绝',
        ),
        el('span', { class: 'hint' }, '确认只代表你本人；不能替他人确认，管理员也不能代确认。'),
      ),
    );
    panel.append(card);
  }
}

async function decide(caseId, decision, button) {
  button.disabled = true;
  try {
    const res = await api(`/api/changes/${encodeURIComponent(caseId)}/decisions`, {
      method: 'POST',
      body: { decision },
    });
    const data = res.data ?? {};
    if (data.code === 'EFFECTIVE') toast('全部确认齐备，方案已生效。');
    else if (data.ok) toast(decision === 'ACCEPT' ? '已记录你的确认。' : '已记录你的拒绝。');
    else toast(`未处理：${data.code ?? res.status}`, true);
  } catch {
    toast('提交失败，请检查网络后重试。', true);
  } finally {
    button.disabled = false;
    renderSectionRefresh();
  }
}

async function renderSubmitted(panel, list, token) {
  if (list.length === 0) {
    panel.append(el('div', { class: 'card' }, el('p', { class: 'hint' }, '你还没有发起过调课方案。')));
    return;
  }
  for (const item of list) {
    const card = el('div', { class: 'case-card' });
    card.append(
      el(
        'div',
        { class: 'head' },
        statusBadge(item.status),
        el('span', { class: 'id' }, item.caseId),
        el('span', { class: 'grow' }),
        el(
          'button',
          {
            class: 'btn ghost',
            type: 'button',
            onclick: () => {
              state.selectedCase = item.caseId;
              renderSectionRefresh();
            },
          },
          '详情',
        ),
      ),
      el('div', { class: 'stack' }, ...item.items.map((it) => caseHeadLine(it))),
      el('p', { class: 'hint' }, `必要确认：${describeNames(item.required, item.requiredNames)}`),
    );
    panel.append(card);
  }

  if (state.selectedCase) {
    const detailBox = el('div');
    panel.append(detailBox);
    await renderCaseDetail(detailBox, state.selectedCase, token);
  }
}

function describeNames(ids, names) {
  if (!ids || ids.length === 0) return '（无）';
  return ids.map((id) => names?.[id] ?? id).join('、');
}

async function renderCaseDetail(box, caseId, token) {
  const res = await api(`/api/changes/${encodeURIComponent(caseId)}`);
  if (token !== state.renderToken) return;
  if (!res.data.ok) {
    box.append(notice(`无法读取方案详情（${res.data.code ?? res.status}）。`, 'danger'));
    return;
  }
  const c = res.data.case;
  const events = res.data.events ?? [];
  const confirmations = new Map();
  for (const conf of c.confirmations) {
    if (conf.revision === c.revision) confirmations.set(conf.teacherId, conf.decision);
  }

  const requiredRows = c.required.map((id) =>
    el(
      'li',
      {},
      `${c.requiredNames?.[id] ?? id}　`,
      confirmations.get(id) === 'ACCEPT'
        ? badge('已接受', 'ok')
        : confirmations.get(id) === 'DECLINE'
          ? badge('已拒绝', 'danger')
          : badge('待确认', 'warn'),
    ),
  );

  const card = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'row' },
      el('h3', { class: 'grow' }, '方案详情'),
      statusBadge(c.status),
      el('span', { class: 'id' }, c.caseId),
    ),
    el(
      'dl',
      { class: 'kv' },
      el('dt', {}, '发起人'),
      el('dd', {}, c.submittedByName ?? c.submittedBy),
      el('dt', {}, '版本'),
      el('dd', {}, String(c.revision)),
      el('dt', {}, '发起说明'),
      el('dd', {}, c.reason ?? '（他人的私人理由不可见）'),
      el('dt', {}, '最后更新'),
      el('dd', {}, c.updatedAt),
    ),
    el('div', { class: 'divider' }),
    el('h3', {}, '变更条目'),
    el('div', { class: 'stack' }, ...c.items.map((it) => caseHeadLine(it))),
    el('div', { class: 'divider' }),
    el('h3', {}, '必要确认者（由受影响课务计算，不由发起人指定）'),
    requiredRows.length > 0 ? el('ul', {}, ...requiredRows) : el('p', { class: 'hint' }, '（无）'),
    el('div', { class: 'divider' }),
    el('h3', {}, '审计轨迹'),
    events.length === 0
      ? el('p', { class: 'hint' }, '（暂无事件）')
      : el(
          'ul',
          { class: 'timeline' },
          ...events.map((e) =>
            el(
              'li',
              {},
              el('div', {}, `${e.action}　${badge(String(e.beforeState ?? '—'))} → ${badge(String(e.afterState ?? '—'))}`),
              el('div', { class: 'at' }, `${e.at}　操作者 ${e.actor}`),
            ),
          ),
        ),
  );

  if (c.canWithdraw) {
    let armed = false;
    const btn = el(
      'button',
      {
        class: 'btn danger',
        type: 'button',
        onclick: async () => {
          if (!armed) {
            armed = true;
            btn.textContent = '再点一次确认撤回';
            return;
          }
          btn.disabled = true;
          const r = await api(`/api/changes/${encodeURIComponent(c.caseId)}/withdraw`, { method: 'POST' });
          toast(r.data.ok ? '方案已撤回（仅未生效方案可撤回）。' : `撤回失败：${r.data.code ?? r.status}`, !r.data.ok);
          renderSectionRefresh();
        },
      },
      '撤回方案',
    );
    card.append(el('div', { class: 'row mt10' }, btn));
  }

  box.append(card);
}

async function renderNewChange(panel, term, token) {
  const from = state.weekStart ?? defaultWeekStart(term);
  const res = await api(`/api/timetable/me?termId=${encodeURIComponent(term.id)}&from=${from}&to=${addDays(from, 6)}`);
  if (token !== state.renderToken) return;
  const rows = res.data.ok ? (res.data.view?.rows ?? []) : [];

  const picked = state.pendingOccurrence;
  const options = rows.filter((r) => !r.cancelled);
  if (picked && !options.some((r) => r.occurrenceId === picked.occurrenceId)) options.unshift(picked);

  // 持有代发起能力的人，即使自己这一周没课，也要能进来替别人发起
  const canOnBehalf = capability('CREATE_CHANGE_ON_BEHALF') === 'ALLOWED';
  if (options.length === 0 && !canOnBehalf) {
    panel.append(
      notice(
        '本时段没有可发起调课的课次。请先在"我的课表"选择要调整的课次，或切换周次。',
        'warn',
      ),
    );
    return;
  }

  // 课次下拉会被"代发起"整体替换成对方那一周的课，所以先建空的再填
  const occurrenceSelect = el('select', {});
  function fillOccurrences(list, selectedId = null) {
    clear(occurrenceSelect);
    for (const r of list) {
      occurrenceSelect.append(
        el(
          'option',
          { value: r.occurrenceId, selected: r.occurrenceId === selectedId },
          `${r.date} 第${r.period}节 · ${r.className} ${r.subjectName}`,
        ),
      );
    }
  }
  fillOccurrences(options, picked?.occurrenceId ?? null);

  /**
   * 代课对象：默认给"按规则排过序的候选"，而不是全校名单。
   * 推荐不锁死选择——推荐之外仍然可选，界面会说明为什么要自行核对。
   *
   * 不用原生 select：候选上百人时，原生弹层在部分浏览器（尤其平板/手机）
   * 点击滚动条会把整层关掉，导致根本选不了人。改成页面内的可滚动名单：
   * 滚动条是真实 DOM 滚动，另加姓名过滤，不依赖浏览器弹层。
   */
  const TIER_LABEL = { SAME_CLASS: '任教该班', SAME_GRADE: '任教同年级', CROSS_GRADE: '跨年级' };
  const candidateHint = el('p', { class: 'hint' });
  const excludedHint = el('p', { class: 'hint' });
  let candidates = [];
  let excluded = [];
  let selectedTeacherId = '';
  /**
   * 候选名单的就绪状态。
   * 候选没算出来时绝不回落到"全校名单平铺"：宁可空着并说明原因，
   * 也不能让老师在一百多个名字里盲选——那等于把冲突留到提交之后才暴露。
   */
  let candidateState = 'loading';
  let candidateError = '';

  const teacherSearch = el('input', { type: 'search', class: 'picker-search', placeholder: '输入姓名过滤' });
  const teacherList = el('div', { class: 'picker-list' });
  const teacherTrigger = el('button', { type: 'button', class: 'btn picker-trigger' }, '选择教师…');
  const closePicker = el('button', { type: 'button', class: 'btn ghost' }, '收起');
  const teacherPanel = el(
    'div',
    { class: 'picker', hidden: true },
    el('div', { class: 'row tight' }, teacherSearch, closePicker),
    teacherList,
  );

  function allTeachers() {
    return (state.refs?.teachers ?? []).filter((t) => t.id !== state.principal?.teacherId);
  }

  function nameOf(candidate) {
    return candidate?.teacherName ?? candidate?.teacherId ?? '';
  }

  /** 分组只用于显示顺序，选择不受限：三组之外的人同样能选。 */
  function grouped() {
    if (candidates.length === 0) return [];
    const recommended = candidates.filter((c) => c.freeAtSlot);
    const needSwap = candidates.filter((c) => !c.freeAtSlot && (c.teachesSubject || c.tier !== 'CROSS_GRADE'));
    const others = candidates.filter((c) => !c.freeAtSlot && !c.teachesSubject && c.tier === 'CROSS_GRADE');
    return [
      { label: `推荐（该节次本人无课，共 ${recommended.length} 位）`, rows: recommended },
      { label: `该节次有课 · 需先解决该时段冲突（共 ${needSwap.length} 位）`, rows: needSwap },
      { label: `其他教师（共 ${others.length} 位）`, rows: others },
    ].filter((g) => g.rows.length > 0);
  }

  function renderTeacherList() {
    clear(teacherList);
    if (candidateState !== 'ready') {
      teacherList.append(el('p', { class: 'picker-empty' }, candidateState === 'loading' ? '正在按规则计算候选…' : candidateError));
      if (candidateState === 'error') {
        const retry = el('button', { type: 'button', class: 'btn ghost' }, '重试');
        retry.addEventListener('click', () => void loadCandidates());
        teacherList.append(retry);
      }
      return;
    }
    const keyword = teacherSearch.value.trim();
    let shown = 0;
    for (const group of grouped()) {
      const rows = keyword === '' ? group.rows : group.rows.filter((c) => nameOf(c).includes(keyword));
      if (rows.length === 0) continue;
      teacherList.append(el('div', { class: 'picker-group' }, group.label));
      for (const c of rows) {
        shown += 1;
        const tags = (c.reasons ?? [])
          .filter((r) => !r.startsWith('当天'))
          .slice(0, 2)
          .join(' · ');
        const row = el(
          'button',
          {
            type: 'button',
            class: `picker-row${c.teacherId === selectedTeacherId ? ' is-selected' : ''}`,
          },
          el('span', { class: 'picker-name' }, nameOf(c)),
          TIER_LABEL[c.tier] ? el('span', { class: 'picker-tag' }, TIER_LABEL[c.tier]) : null,
          tags === '' ? null : el('span', { class: 'picker-meta' }, tags),
        );
        row.addEventListener('click', () => {
          setTeacher(c.teacherId);
          teacherPanel.hidden = true;
        });
        teacherList.append(row);
      }
    }
    if (shown === 0) {
      teacherList.append(
        el(
          'p',
          { class: 'picker-empty' },
          keyword === '' ? '没有可代课的教师。' : `没有匹配"${keyword}"的教师。清空过滤条件可看到全部。`,
        ),
      );
    }
  }

  function setTeacher(id) {
    selectedTeacherId = id ?? '';
    const found = candidates.find((c) => c.teacherId === id);
    const label = found ? nameOf(found) : (allTeachers().find((t) => t.id === id)?.name ?? '');
    teacherTrigger.textContent = selectedTeacherId === '' ? '选择教师…' : `已选：${label || selectedTeacherId}`;
    teacherTrigger.className = `btn picker-trigger${selectedTeacherId === '' ? '' : ' primary'}`;
    syncHint();
  }

  function togglePicker() {
    teacherPanel.hidden = !teacherPanel.hidden;
    if (!teacherPanel.hidden) {
      renderTeacherList();
      teacherSearch.focus();
    }
  }

  teacherTrigger.addEventListener('click', togglePicker);
  closePicker.addEventListener('click', () => {
    teacherPanel.hidden = true;
  });
  teacherSearch.addEventListener('input', renderTeacherList);
  teacherSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') teacherPanel.hidden = true;
  });

  function syncHint() {
    const found = candidates.find((c) => c.teacherId === selectedTeacherId);
    if (!found) {
      if (candidates.length === 0 || selectedTeacherId === '') {
        candidateHint.textContent = '';
        return;
      }
      candidateHint.textContent = '该教师不在候选评估范围内，请自行核对对方该节次是否有课。';
      return;
    }
    const hints = (found.hints ?? []).length === 0 ? '' : `｜提示：${found.hints.join('；')}`;
    candidateHint.textContent = `${TIER_LABEL[found.tier] ?? found.tier}：${found.reasons.join('；')}${hints}`;
  }

  function renderExcluded() {
    if (excluded.length === 0) {
      excludedHint.textContent = '';
      return;
    }
    const shown = excluded.slice(0, 5).map((e) => `${e.teacherName ?? e.teacherId}（${e.reasons.join('；')}）`);
    const rest = excluded.length - shown.length;
    excludedHint.textContent = `按当前筛选，另有 ${excluded.length} 位教师未列出：${shown.join('、')}${rest > 0 ? ` 等 ${excluded.length} 位` : ''}。取消勾选即可重新看到。`;
  }

  /** 候选不可用时把服务端原因说成人话，并且明确告诉老师"没有给你全量名单"。 */
  function candidateErrorText(code, status) {
    switch (code) {
      case 'PASSWORD_CHANGE_REQUIRED':
        return '请先修改初始口令，之后才能发起代课。';
      case 'NOT_A_TEACHER':
        return '当前账号没有关联教师档案，不能发起代课。';
      case 'NOT_OWNER':
        return '只能对自己任教的课次发起代课。';
      case 'OCCURRENCE_CANCELLED':
        return '该课次已停课，不能再发起代课。';
      case 'OCCURRENCE_NOT_FOUND':
        return '课次不存在或已不在本学期范围内，请重新选择。';
      case 'FORBIDDEN':
        return '当前身份不能发起代课。';
      case 'BAD_INPUT':
        return '请求缺少必要信息，请重新选择课次。';
      case 'NO_OCCURRENCE':
        return '请先选择要调整的课次，系统才能按规则给出候选。';
      default:
        return `候选推荐暂时不可用（${code ?? status ?? '未知原因'}）。已停止列出全校名单，请重试或联系课务管理人员。`;
    }
  }

  function setCandidateState(next, code, status) {
    candidateState = next;
    candidateError = next === 'error' ? candidateErrorText(code, status) : '';
    teacherTrigger.disabled = next !== 'ready';
    if (next === 'loading') teacherTrigger.textContent = '正在计算候选…';
    else if (next === 'error') teacherTrigger.textContent = '候选不可用';
    else setTeacher(selectedTeacherId);
    if (!teacherPanel.hidden) renderTeacherList();
  }

  async function loadCandidates() {
    const occurrenceId = occurrenceSelect.value;
    if (!occurrenceId) {
      setCandidateState('error', 'NO_OCCURRENCE');
      return;
    }
    // 不带筛选条件：服务端按"我的偏好 > 全校默认 > 中性默认"算。
    // 改口径要去设置页，发起调课的屏幕上不摆这些开关。
    const payload = { termId: term.id, occurrenceId };
    if (kind.value === 'MOVE') {
      payload.toDate = dateField.value;
      payload.toPeriod = Number(periodField.value);
    }
    setCandidateState('loading');
    let r;
    try {
      r = await api('/api/changes/candidates/preview', { method: 'POST', body: payload });
    } catch {
      if (token === state.renderToken) setCandidateState('error', 'NETWORK');
      return;
    }
    if (token !== state.renderToken) return;
    if (!r.data.ok) {
      candidates = [];
      excluded = [];
      setCandidateState('error', r.data.code, r.status);
      renderExcluded();
      return;
    }
    candidates = r.data.candidates ?? [];
    excluded = r.data.excluded ?? [];
    setCandidateState('ready');
    renderExcluded();
    syncHint();
  }

  /** 课次一变，已选的对调对象与候选全部作废：它们只对上一节课成立。 */
  function resetForOccurrence() {
    setTeacher('');
    swapTeacher = null;
    swapLesson = null;
    swapOptions = [];
    swapTrigger.textContent = '选择对调对象…';
    swapTrigger.className = 'btn picker-trigger';
    clear(swapLessons);
    swapHint.textContent = '';
    if (kind.value === 'REASSIGN') void loadCandidates();
    if (kind.value === 'SWAP') void loadSwapCandidates();
  }
  occurrenceSelect.addEventListener('change', resetForOccurrence);

  const dateField = el('input', { type: 'date', value: from });
  const periodField = el('input', { type: 'number', min: '1', max: '20', value: '1' });

  // 不用 label 包控件：label 会把点击转发给内部第一个可关联控件，
  // 点在面板上也会被当成点触发器，面板会被自己关掉。
  const targetTeacher = el(
    'div',
    { class: 'field' },
    el('span', {}, '代课教师'),
    teacherTrigger,
    teacherPanel,
    candidateHint,
    excludedHint,
  );
  const targetMove = el(
    'div',
    { class: 'row' },
    el('label', { class: 'field' }, el('span', {}, '调整到日期'), dateField),
    el('label', { class: 'field' }, el('span', {}, '节次'), periodField),
  );
  const targetNone = el('p', { class: 'hint' }, '停课：该课次不再计入有课，但仍保留在历史中。');

  /* ---- 对调：先选人，再选对方的那一节课（必须落到日期 + 第几节） ---- */
  const swapSearch = el('input', { type: 'search', class: 'picker-search', placeholder: '输入姓名过滤' });
  const swapList = el('div', { class: 'picker-list' });
  const swapTrigger = el('button', { type: 'button', class: 'btn picker-trigger' }, '选择对调对象…');
  const swapClose = el('button', { type: 'button', class: 'btn ghost' }, '收起');
  const swapPanel = el(
    'div',
    { class: 'picker', hidden: true },
    el('div', { class: 'row tight' }, swapSearch, swapClose),
    swapList,
  );
  const swapLessons = el('div', { class: 'swap-lessons' });
  const swapHint = el('p', { class: 'hint' });
  let swapState = 'idle';
  let swapError = '';
  let swapRecommended = [];
  let swapNotRecommended = [];
  let swapTeacher = null;
  let swapOptions = [];
  let swapLesson = null;

  function swapSlotText(option) {
    return `${option.date} 第${option.period}节`;
  }

  function renderSwapList() {
    clear(swapList);
    if (swapState !== 'ready') {
      swapList.append(
        el(
          'p',
          { class: 'picker-empty' },
          swapState === 'loading' ? '正在按规则计算对调对象…' : swapError,
        ),
      );
      return;
    }
    const keyword = swapSearch.value.trim();
    const groups = [
      { label: `推荐（本学期任教该班，共 ${swapRecommended.length} 位）`, rows: swapRecommended },
      { label: `不推荐（共 ${swapNotRecommended.length} 位，仍可选）`, rows: swapNotRecommended },
    ];
    let shown = 0;
    for (const group of groups) {
      const rows =
        keyword === ''
          ? group.rows
          : group.rows.filter((c) => (c.teacherName ?? c.teacherId).includes(keyword));
      if (rows.length === 0) continue;
      swapList.append(el('div', { class: 'picker-group' }, group.label));
      for (const c of rows) {
        shown += 1;
        const first = c.sampleOptions?.[0];
        const meta = c.recommended
          ? `${c.viableCount} 节可换${first ? `｜如 ${swapSlotText(first)}` : ''}`
          : c.reasons.join('；');
        const row = el(
          'button',
          {
            type: 'button',
            class: `picker-row${swapTeacher?.teacherId === c.teacherId ? ' is-selected' : ''}`,
          },
          el('span', { class: 'picker-name' }, c.teacherName ?? c.teacherId),
          el('span', { class: 'picker-tag' }, TIER_LABEL[c.tier] ?? c.tier),
          el('span', { class: 'picker-meta' }, meta),
        );
        row.addEventListener('click', () => {
          swapPanel.hidden = true;
          void pickSwapTeacher(c);
        });
        swapList.append(row);
      }
    }
    if (shown === 0) swapList.append(el('p', { class: 'picker-empty' }, '没有匹配的教师。'));
  }

  async function loadSwapCandidates() {
    const occurrenceId = occurrenceSelect.value;
    if (!occurrenceId) {
      swapState = 'error';
      swapError = '请先选择要换出的课次。';
      swapTrigger.disabled = true;
      swapTrigger.textContent = '对调对象不可用';
      renderSwapList();
      return;
    }
    swapState = 'loading';
    swapError = '';
    swapTrigger.disabled = true;
    swapTrigger.textContent = '正在计算对调对象…';
    let r;
    try {
      r = await api(
        `/api/changes/swap-candidates?termId=${encodeURIComponent(term.id)}&occurrenceId=${encodeURIComponent(occurrenceId)}`,
      );
    } catch {
      if (token !== state.renderToken) return;
      swapState = 'error';
      swapError = '网络不通，暂时拿不到对调对象。';
      swapTrigger.textContent = '对调对象不可用';
      renderSwapList();
      return;
    }
    if (token !== state.renderToken) return;
    if (!r.data.ok) {
      swapRecommended = [];
      swapNotRecommended = [];
      swapState = 'error';
      swapError = candidateErrorText(r.data.code, r.status);
      swapTrigger.textContent = '对调对象不可用';
      renderSwapList();
      return;
    }
    swapRecommended = (r.data.recommended ?? []).map((c) => ({ ...c, recommended: true }));
    swapNotRecommended = (r.data.notRecommended ?? []).map((c) => ({ ...c, recommended: false }));
    swapState = 'ready';
    swapTrigger.disabled = false;
    swapTrigger.textContent = '选择对调对象…';
    if (!swapPanel.hidden) renderSwapList();
  }

  async function pickSwapTeacher(candidate) {
    swapTeacher = candidate;
    swapLesson = null;
    swapOptions = [];
    swapTrigger.textContent = `已选：${candidate.teacherName ?? candidate.teacherId}`;
    swapTrigger.className = 'btn picker-trigger primary';
    renderSwapLessons();
    if (candidate.viableCount === 0) return;

    const occurrenceId = occurrenceSelect.value;
    let r;
    try {
      r = await api(
        `/api/changes/swap-options?termId=${encodeURIComponent(term.id)}&occurrenceId=${encodeURIComponent(occurrenceId)}&teacherId=${encodeURIComponent(candidate.teacherId)}`,
      );
    } catch {
      if (token !== state.renderToken) return;
      swapHint.textContent = '网络不通，拿不到对方的课次。';
      return;
    }
    if (token !== state.renderToken) return;
    if (!r.data.ok) {
      swapHint.textContent = candidateErrorText(r.data.code, r.status);
      return;
    }
    swapOptions = r.data.options ?? [];
    renderSwapLessons();
  }

  function renderSwapLessons() {
    clear(swapLessons);
    if (!swapTeacher) return;
    if (swapTeacher.viableCount === 0) {
      swapHint.textContent = `这位教师暂无可换课次：${swapTeacher.reasons.join('；')}`;
      return;
    }
    if (swapOptions.length === 0) {
      swapHint.textContent = '正在读取对方的课次…';
      return;
    }
    swapLessons.append(
      el('div', { class: 'picker-group' }, '选择对方要让出的那一节课（冲突项不可选，并写明原因）'),
    );
    for (const option of swapOptions) {
      const blocked = (option.blockedReasons ?? []).length > 0;
      const meta = blocked
        ? option.blockedReasons.join('；')
        : `${option.className} ${option.subjectName}${
            (option.hints ?? []).length > 0 ? `｜提示：${option.hints.join('；')}` : ''
          }`;
      const row = el(
        'button',
        {
          type: 'button',
          class: `picker-row${swapLesson?.occurrenceId === option.occurrenceId ? ' is-selected' : ''}`,
          disabled: blocked,
        },
        el('span', { class: 'picker-name' }, swapSlotText(option)),
        el('span', { class: 'picker-meta' }, meta),
      );
      if (!blocked) {
        row.addEventListener('click', () => {
          swapLesson = option;
          renderSwapLessons();
        });
      }
      swapLessons.append(row);
    }
    swapHint.textContent = swapLesson
      ? `已选：${swapSlotText(swapLesson)}（${swapLesson.className} ${swapLesson.subjectName}）`
      : '';
  }

  swapTrigger.addEventListener('click', () => {
    swapPanel.hidden = !swapPanel.hidden;
    if (!swapPanel.hidden) {
      renderSwapList();
      swapSearch.focus();
    }
  });
  swapClose.addEventListener('click', () => {
    swapPanel.hidden = true;
  });
  swapSearch.addEventListener('input', renderSwapList);
  swapSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') swapPanel.hidden = true;
  });

  const targetSwap = el(
    'div',
    { class: 'field' },
    el('span', {}, '对调对象'),
    swapTrigger,
    swapPanel,
    swapLessons,
    swapHint,
  );

  // 默认对调：这是老师之间最常见的互换，先按它给出对象；要改成代课/调整时间/停课再自己切。
  // 顺序也按这个来，避免下拉第一项和默认值不一致。
  const kind = el(
    'select',
    {},
    el('option', { value: 'SWAP' }, '对调（与另一位教师互换一节课）'),
    el('option', { value: 'REASSIGN' }, '代课（请另一位教师上这节课）'),
    el('option', { value: 'MOVE' }, '调整时间（换日期/节次）'),
    el('option', { value: 'CANCEL' }, '停课'),
  );

  /* ---- 代他人发起：只有持有账号级能力 CREATE_CHANGE_ON_BEHALF 的人才看得到 ---- */
  let behalfActive = false;
  let behalfTeacher = null;
  const behalfStatus = el('p', { class: 'hint' });
  const behalfBox = el('div', { hidden: true });

  async function loadBehalfOccurrences(teacher, selectedId = null) {
    const from = state.weekStart ?? defaultWeekStart(term);
    const to = addDays(from, 6);
    behalfStatus.textContent = `正在读取 ${teacher.name} 的课次…`;
    const r = await api(
      `/api/timetable/teacher/${encodeURIComponent(teacher.id)}?termId=${encodeURIComponent(term.id)}&from=${from}&to=${to}`,
    );
    if (!r.data.ok) {
      fillOccurrences([]);
      behalfStatus.textContent = `无法读取 ${teacher.name} 的课次（${r.data.code ?? r.status}）。`;
      return;
    }
    const list = (r.data.view?.rows ?? []).filter((x) => !x.cancelled);
    fillOccurrences(list, selectedId);
    resetForOccurrence();
    behalfStatus.textContent =
      list.length === 0
        ? `${teacher.name} 在本周没有可调课的课次，换一周或选别人。`
        : `正在代 ${teacher.name} 发起（本周 ${list.length} 节课）。提交后仍需他本人确认，系统不会替他同意。`;
  }

  const behalfPicker = canOnBehalf
    ? createTeacherPicker({
        excludeTeacherId: state.principal?.teacherId ?? null,
        onPick: (t) => {
          behalfTeacher = t;
          void loadBehalfOccurrences(t);
        },
      })
    : null;

  const behalfToggle = canOnBehalf
    ? el(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: () => {
            behalfActive = !behalfActive;
            behalfBox.hidden = !behalfActive;
            behalfToggle.textContent = behalfActive ? '取消代发起' : '代其他老师发起';
            if (!behalfActive) {
              behalfTeacher = null;
              behalfPicker.reset();
              behalfStatus.textContent = '';
              fillOccurrences(options, state.pendingOccurrence?.occurrenceId ?? null);
              resetForOccurrence();
            }
          },
        },
        '代其他老师发起',
      )
    : null;

  if (canOnBehalf) behalfBox.append(behalfPicker.root, behalfStatus);

  // 从"他人课表"点某一节跳过来：直接进入代发起，并选中那一节。
  // 这里不动 state.pendingOccurrence——它记的是"我自己的课次"，两种上下文不能混。
  const pendingBehalf = state.pendingBehalf;
  if (pendingBehalf) state.pendingBehalf = null;
  if (canOnBehalf && pendingBehalf) {
    behalfActive = true;
    behalfBox.hidden = false;
    behalfToggle.textContent = '取消代发起';
    behalfTeacher = { id: pendingBehalf.teacherId, name: pendingBehalf.teacherName };
    behalfPicker.setPicked(behalfTeacher);
    void loadBehalfOccurrences(behalfTeacher, pendingBehalf.occurrenceId);
  }

  const reason = el('textarea', { placeholder: '可选。说明会作为方案的一部分留存；他人不会看到你的私人说明。' });
  const result = el('div');

  function syncKind() {
    targetTeacher.hidden = kind.value !== 'REASSIGN';
    targetSwap.hidden = kind.value !== 'SWAP';
    targetMove.hidden = kind.value !== 'MOVE';
    targetNone.hidden = kind.value !== 'CANCEL';
  }
  kind.addEventListener('change', () => {
    syncKind();
    // 切到"代课"时才需要候选名单；已加载过就复用，避免重复请求。
    if (kind.value === 'REASSIGN' && candidates.length === 0) void loadCandidates();
    // 对调每次都重算：口径随课次与偏好变化，缓存下来只会给出过期建议
    if (kind.value === 'SWAP') void loadSwapCandidates();
  });

  const form = el(
    'form',
    {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        const occurrenceId = occurrenceSelect.value;
        // 代发起必须先选人：没选人时下面的课次还是"我自己"的，提交出去就是另一回事了。
        if (behalfActive && !behalfTeacher) {
          clear(result);
          result.append(notice('请先选择要代替哪位老师发起。', 'warn'));
          return;
        }
        if (occurrenceId === '') {
          clear(result);
          result.append(notice('请选择要调整的课次。', 'warn'));
          return;
        }
        // 这笔方案"算谁的"：本人发起是自己，代发起是被代教师。
        // 对调的第二条（对方把课给谁）必须跟着这个走，否则会把课换给代办人。
        const ownerTeacherId = behalfActive && behalfTeacher ? behalfTeacher.id : state.principal.teacherId;
        // 除"调整时间""停课"外都要指定教师。候选没算出来时不让提交：
        // 此时系统不知道谁能接这节课，硬提交只会把冲突推给对方和审批人。
        if (kind.value === 'SWAP') {
          if (swapState !== 'ready') {
            clear(result);
            result.append(notice(swapError || '对调对象尚未就绪，请稍候再试。', 'warn'));
            return;
          }
          if (!swapTeacher) {
            clear(result);
            result.append(notice('请先选择对调对象。', 'warn'));
            return;
          }
          if (!swapLesson) {
            clear(result);
            result.append(notice('请选择对方要与你对调的那一节课。', 'warn'));
            return;
          }
        } else if (kind.value !== 'MOVE' && kind.value !== 'CANCEL') {
          if (candidateState !== 'ready') {
            clear(result);
            result.append(notice(candidateError || '候选名单尚未就绪，请稍候再试。', 'warn'));
            return;
          }
          if (selectedTeacherId === '') {
            clear(result);
            result.append(notice('请先选择由哪位教师代课。', 'warn'));
            return;
          }
        }
        // 对调＝同一笔方案里的两条代课：我给对方，对方给我。
        // 服务端按变更后的整体状态判冲突，必要确认人自动是双方。
        const items =
          kind.value === 'SWAP'
            ? [
                { occurrenceId, kind: 'REASSIGN', toTeacherId: swapTeacher.teacherId },
                {
                  occurrenceId: swapLesson.occurrenceId,
                  kind: 'REASSIGN',
                  toTeacherId: ownerTeacherId,
                },
              ]
            : [
                {
                  occurrenceId,
                  kind: kind.value,
                  toTeacherId: kind.value === 'REASSIGN' ? selectedTeacherId : null,
                  toDate: kind.value === 'MOVE' ? dateField.value : null,
                  toPeriod: kind.value === 'MOVE' ? Number(periodField.value) : null,
                },
              ];
        const payload = {
          termId: term.id,
          items,
          reason: reason.value.trim() === '' ? null : reason.value.trim(),
          idempotencyKey: newIdempotencyKey(),
          onBehalfOfTeacherId: behalfActive && behalfTeacher ? behalfTeacher.id : null,
        };
        clear(result);
        const r = await api('/api/changes', { method: 'POST', body: payload });
        result.append(renderChangeResult(r));
        if (r.data.ok) {
          state.pendingOccurrence = null;
          reason.value = '';
          swapTeacher = null;
          swapLesson = null;
          swapOptions = [];
          swapTrigger.textContent = '选择对调对象…';
          swapTrigger.className = 'btn picker-trigger';
          clear(swapLessons);
          swapHint.textContent = '';
          // 代发起提交完，把课次列表切回自己的，避免下一笔误用对方的课次
          if (canOnBehalf) {
            behalfActive = false;
            behalfTeacher = null;
            behalfBox.hidden = true;
            behalfToggle.textContent = '代其他老师发起';
            behalfPicker.reset();
            behalfStatus.textContent = '';
            fillOccurrences(options, null);
            resetForOccurrence();
          }
        }
      },
    },
    el('h3', {}, '新建调课方案'),
    el('p', { class: 'hint' }, '提交后进入"待确认"，必须由受影响的教师本人逐人确认，系统不会自动视为同意。'),
    canOnBehalf ? el('div', { class: 'row tight' }, behalfToggle) : null,
    behalfBox,
    el('label', { class: 'field' }, el('span', {}, '课次'), occurrenceSelect),
    el('label', { class: 'field' }, el('span', {}, '变更方式'), kind),
    targetTeacher,
    targetSwap,
    targetMove,
    targetNone,
    el('label', { class: 'field' }, el('span', {}, '发起说明'), reason),
    el('div', { class: 'row mt10' }, el('button', { class: 'btn primary', type: 'submit' }, '提交方案')),
    result,
  );
  syncKind();
  panel.append(form);
  setTeacher('');
  // 进来就按"对调"算一次对象，用户不必先点一下才有内容
  if (kind.value === 'SWAP') void loadSwapCandidates();
  if (kind.value === 'REASSIGN') void loadCandidates();
}

function renderChangeResult(res) {
  const data = res.data ?? {};
  if (res.status >= 500) return notice(`服务端错误（${res.status}），请勿重复提交，先联系管理员。`, 'danger');
  if (data.ok && data.code === 'DUPLICATE_REPLAY') {
    return notice(`该幂等键已提交过，返回原方案 ${data.caseId}（未重复建单）。`, 'ok');
  }
  if (data.ok) {
    const nameMap = {};
    for (const t of state.refs?.teachers ?? []) nameMap[t.id] = t.name;
    return el(
      'div',
      { class: 'notice ok' },
      el('div', {}, `已提交：${STATUS_LABEL[data.status] ?? data.status}（方案 ${data.caseId}）`),
      el('div', {}, `必要确认者：${describeNames(data.required ?? [], nameMap)}`),
      data.notifiedUnknownClasses?.length
        ? el('div', { class: 'hint' }, `班主任未配置的班级：${data.notifiedUnknownClasses.join('、')}（未假装已通知）`)
        : null,
    );
  }
  const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
  return el(
    'div',
    { class: 'notice danger' },
    el('div', {}, `未提交成功：${data.code ?? res.status}`),
    conflicts.length > 0
      ? el(
          'ul',
          {},
          ...conflicts.map((c) =>
            el('li', {}, `${c.code}${c.occurrenceId ? `（${c.occurrenceId}）` : ''}：${c.detail}`),
          ),
        )
      : null,
  );
}

/* ------------------------------------------------------------------ 设置 */

/**
 * 候选筛选偏好表单。只在设置页出现：
 * 发起调课那一刻，屏幕上只该有"这节课、改成什么、给谁"，
 * 口径是提前想好的事，不该在发起时临时摆弄。
 */
function buildPreferenceForm(initial) {
  const check = (checked) => el('input', { type: 'checkbox', checked });
  const num = (value) => el('input', { type: 'number', min: '1', max: '20', value: String(value) });

  const cbSameClass = check(initial.considerSameClass);
  const cbSameGrade = check(initial.considerSameGrade);
  const cbSameSubject = check(initial.considerSameSubject);
  const cbLightLoad = check(initial.considerLightLoad);
  const cbBusy = check(initial.excludeBusyAtSlot);
  const cbRun = check(initial.excludeConsecutive);
  const numRun = num(initial.consecutiveLimit);
  const cbTotal = check(initial.excludeDayTotal);
  const numTotal = num(initial.dayTotalLimit);
  const numSubjectDay = num(initial.classSubjectDayLimit);

  const root = el(
    'div',
    { class: 'stack' },
    el('p', { class: 'hint' }, '排序时考虑（勾选才参与）'),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'check' }, cbSameClass, '任教该班'),
      el('label', { class: 'check' }, cbSameGrade, '任教同年级'),
      el('label', { class: 'check' }, cbSameSubject, '任教同一科目'),
      el('label', { class: 'check' }, cbLightLoad, '当天课时少'),
    ),
    el('p', { class: 'hint' }, '直接不列出（勾选才隐藏；被隐藏者仍会连同原因说明）'),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'check' }, cbBusy, '该节次本人有课'),
      el('label', { class: 'check' }, cbRun, '接手后连上 ≥', numRun, '节'),
    ),
    el('div', { class: 'row' }, el('label', { class: 'check' }, cbTotal, '接手后当天超过', numTotal, '节')),
    el('p', { class: 'hint' }, '该班当天同一科目达到', numSubjectDay, '节时提示（只提示，不排除）。'),
  );

  return {
    root,
    read() {
      return {
        considerSameClass: cbSameClass.checked,
        considerSameGrade: cbSameGrade.checked,
        considerSameSubject: cbSameSubject.checked,
        considerLightLoad: cbLightLoad.checked,
        excludeBusyAtSlot: cbBusy.checked,
        excludeConsecutive: cbRun.checked,
        consecutiveLimit: Number(numRun.value),
        excludeDayTotal: cbTotal.checked,
        dayTotalLimit: Number(numTotal.value),
        hintClassSubjectDay: true,
        classSubjectDayLimit: Number(numSubjectDay.value),
      };
    },
  };
}

function neutralPreferenceInput() {
  return {
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
}

const PREF_SOURCE_LABEL = { TEACHER: '我的偏好', SCHOOL_DEFAULT: '全校默认', NEUTRAL: '系统默认（不做减法）' };

async function renderSettings(view, token) {
  const res = await api('/api/preferences/change');
  if (token !== state.renderToken) return;
  const data = res.data.ok ? res.data : null;
  const pref = data?.preference ?? null;
  const initial = pref
    ? {
        considerSameClass: pref.consider?.sameClass ?? true,
        considerSameGrade: pref.consider?.sameGrade ?? true,
        considerSameSubject: pref.consider?.sameSubject ?? true,
        considerLightLoad: pref.consider?.lightLoad ?? true,
        excludeBusyAtSlot: pref.exclude?.busyAtSlot ?? false,
        excludeConsecutive: pref.exclude?.consecutive ?? false,
        consecutiveLimit: pref.exclude?.consecutiveLimit ?? 3,
        excludeDayTotal: pref.exclude?.dayTotal ?? false,
        dayTotalLimit: pref.exclude?.dayTotalLimit ?? 6,
        classSubjectDayLimit: pref.hint?.classSubjectDayLimit ?? 2,
      }
    : neutralPreferenceInput();

  const form = buildPreferenceForm(initial);
  const result = el('div');

  const saveMine = el('button', { type: 'button', class: 'btn primary' }, '保存为我的偏好');
  saveMine.addEventListener('click', async () => {
    const r = await api('/api/preferences/change', { method: 'PUT', body: form.read() });
    toast(
      r.data.ok
        ? '已保存为我的筛选偏好，发起代课时按这个口径推荐。'
        : `保存失败（${r.data.code ?? r.status}）`,
      !r.data.ok,
    );
  });

  const saveSchool = el('button', { type: 'button', class: 'btn' }, '设为全校默认');
  saveSchool.addEventListener('click', async () => {
    const r = await api('/api/preferences/change/school', { method: 'PUT', body: form.read() });
    toast(
      r.data.ok
        ? '已保存为全校默认筛选（教师仍可在自己的偏好里覆盖）。'
        : `保存失败（${r.data.code ?? r.status}）`,
      !r.data.ok,
    );
  });

  const canEditSchool = data?.canEditSchool === true;
  const hasTeacher = Boolean(state.principal?.teacherId);

  view.append(
    el(
      'div',
      { class: 'page-head' },
      el('h2', {}, '设置'),
      el('p', { class: 'hint' }, '这里只改"怎么给你看"，不改业务规则；改完在下一次发起代课时生效。'),
    ),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el('h3', { class: 'grow' }, '代课候选筛选'),
        badge(PREF_SOURCE_LABEL[data?.source] ?? '当前口径未知', data?.source === 'NEUTRAL' ? null : 'brand'),
      ),
      el(
        'p',
        { class: 'hint' },
        '只影响给你看的排序与显示；不影响谁必须确认，也不改变冲突判定。课务管理人员可设全校默认，教师可各自覆盖。',
      ),
      form.root,
      el('div', { class: 'divider' }),
      el('div', { class: 'row mt10' }, hasTeacher ? saveMine : null, canEditSchool ? saveSchool : null),
      hasTeacher
        ? null
        : el('p', { class: 'hint' }, '当前身份没有教师档案，个人偏好不适用；仅可维护全校默认。'),
      result,
    ),
  );
  if (!data) {
    result.append(notice(`未能读取当前偏好（${res.data.code ?? res.status}），下面显示的是系统默认，保存会覆盖它。`, 'warn'));
  }
}

/* ------------------------------------------------------------------ 应急 */

async function sectionEmergency(view, token) {
  const term = currentTerm();
  if (!term) {
    view.append(notice('数据库中没有学期数据，无法发起求助。', 'warn'));
    return;
  }
  const from = todayISO() < term.startMonday ? term.startMonday : todayISO();
  const to = addDays(from, 13);
  const [table, mine] = await Promise.all([
    api(`/api/timetable/me?termId=${encodeURIComponent(term.id)}&from=${from}&to=${to}`),
    api('/api/emergency/mine'),
  ]);
  if (token !== state.renderToken) return;

  view.append(
    notice(
      '求助只记录"我已求助"这一事实：不产生通知、不指定负责人、不代表已安排代课。标"待校方确认"的职责在获得书面依据前一律不可用。',
      'warn',
    ),
  );

  const rows = table.data.ok ? (table.data.view?.rows ?? []).filter((r) => !r.cancelled) : [];
  const options = rows.slice(0, 60);
  if (state.emergencyPicked && !options.some((r) => r.occurrenceId === state.emergencyPicked.occurrenceId)) {
    options.unshift(state.emergencyPicked);
  }

  if (options.length === 0) {
    view.append(notice('接下来两周没有可关联的本人课次。', 'warn'));
  } else {
    const occurrenceSelect = el(
      'select',
      {},
      ...options.map((r) =>
        el(
          'option',
          {
            value: r.occurrenceId,
            selected: state.emergencyPicked?.occurrenceId === r.occurrenceId,
          },
          `${r.date} 第${r.period}节 · ${r.className} ${r.subjectName}`,
        ),
      ),
    );
    const note = el('textarea', {
      placeholder: '说明情况（1–2000 字）。这里只在你本人与系统之间保存，不会写进审计。',
      value: state.emergencyPicked ? '' : '',
    });
    const result = el('div');
    const form = el(
      'form',
      {
        class: 'card',
        onsubmit: async (event) => {
          event.preventDefault();
          clear(result);
          const r = await api('/api/emergency/requests', {
            method: 'POST',
            body: {
              termId: term.id,
              occurrenceId: occurrenceSelect.value,
              note: note.value.trim(),
              idempotencyKey: newIdempotencyKey(),
            },
          });
          result.append(renderEmergencyResult(r));
          if (r.data.ok) note.value = '';
        },
      },
      el('h3', {}, '发起求助（仅限本人课次）'),
      el('label', { class: 'field' }, el('span', {}, '课次'), occurrenceSelect),
      el('label', { class: 'field' }, el('span', {}, '情况说明'), note),
      el('div', { class: 'row mt10' }, el('button', { class: 'btn primary', type: 'submit' }, '提交求助')),
      result,
    );
    view.append(form);
  }

  const list = mine.data.ok ? (mine.data.requests ?? []) : [];
  const card = el('div', { class: 'card' }, el('h3', {}, `我的求助（${list.length}）`));
  if (list.length === 0) {
    card.append(el('p', { class: 'hint' }, '还没有求助记录。'));
  }
  for (const req of list) {
    card.append(renderEmergencyRow(req));
  }
  view.append(card);
}

function renderEmergencyResult(res) {
  const data = res.data ?? {};
  if (data.ok) {
    return el(
      'div',
      { class: 'notice ok' },
      `已记录求助（${data.requestId}）。授课核验状态：${data.teachingVerification ?? 'PENDING'}——求助不等于已安排，也不等于已执行。`,
    );
  }
  return notice(`未记录：${data.code ?? res.status}`, 'danger');
}

function renderEmergencyRow(req) {
  const row = el(
    'div',
    { class: 'case-card' },
    el(
      'div',
      { class: 'head' },
      badge(EMERGENCY_STATUS[req.status] ?? req.status, 'brand'),
      badge(`授课核验：${req.teachingVerification}`, 'warn'),
      el('span', { class: 'id' }, req.id),
      el('span', { class: 'grow' }),
      el('span', { class: 'hint' }, req.createdAt),
    ),
    el('div', {}, `课次 ${req.occurrenceId}`),
    el('div', { class: 'hint' }, `说明：${req.note}`),
    el(
      'div',
      { class: 'row tight mt8' },
      ...EMERGENCY_ACTIONS.map(([slug, label]) =>
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async (event) => {
              const btn = event.target;
              btn.disabled = true;
              const r = await api(`/api/emergency/requests/${encodeURIComponent(req.id)}/${slug}`, {
                method: 'POST',
                body: slug === 'escalate' ? { primaryDeclined: true } : undefined,
              });
              const data = r.data ?? {};
              toast(`${label}：${data.code ?? r.status}${data.blockedBy?.length ? `（阻断：${data.blockedBy.join('、')}）` : ''}`, !data.ok);
              btn.disabled = false;
            },
          },
          label,
        ),
      ),
    ),
  );
  return row;
}

/* ------------------------------------------------------------------ 权限与审计 */

async function sectionAccess(view, token) {
  const audit = await api('/api/audit/mine');
  if (token !== state.renderToken) return;

  const caps = state.meta?.capabilities ?? [];
  const table = el(
    'table',
    { class: 'data' },
    el('thead', {}, el('tr', {}, el('th', {}, '操作'), el('th', {}, '判定'), el('th', {}, '说明'))),
    el(
      'tbody',
      {},
      ...caps.map((c) =>
        el(
          'tr',
          {},
          el('td', {}, c.label),
          el(
            'td',
            {},
            badge(
              VERDICT_LABEL[c.verdict] ?? c.verdict,
              c.verdict === 'ALLOWED' ? 'ok' : c.verdict === 'ROLE_NOT_ASSIGNED' ? 'warn' : '',
            ),
          ),
          el('td', { class: 'hint' }, c.verdict === 'ROLE_NOT_ASSIGNED' ? '该职责待校方确认，任何人不得临时授予' : ''),
        ),
      ),
    ),
  );

  view.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, '我的权限（服务端逐项判定，前端隐藏不代表授权）'),
      el('p', { class: 'hint' }, `当前身份：${ROLE_LABEL[state.principal?.actingRole] ?? ''}。管理员不因技术权限获得业务权。`),
      table,
    ),
  );

  const events = audit.data.ok ? (audit.data.events ?? []) : [];
  const list = el('div', { class: 'card' }, el('h3', {}, `与我相关的审计（${events.length}）`));
  if (events.length === 0) list.append(el('p', { class: 'hint' }, '暂无记录。'));
  else {
    list.append(
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, '时间'), el('th', {}, '操作'), el('th', {}, '对象'), el('th', {}, '操作者'), el('th', {}, '哈希'))),
        el(
          'tbody',
          {},
          ...events.map((e) =>
            el(
              'tr',
              {},
              el('td', { class: 'mono' }, e.at),
              el('td', {}, e.action),
              el('td', { class: 'mono' }, e.objectId),
              el('td', { class: 'mono' }, e.actor),
              el('td', { class: 'mono' }, String(e.hash ?? '').slice(0, 12)),
            ),
          ),
        ),
      ),
    );
  }
  view.append(list);
}

/* ------------------------------------------------------------------ 系统状态 */

async function sectionSchool(view, token) {
  const [status, recent] = await Promise.all([api('/api/status'), api('/api/audit/recent?limit=50')]);
  if (token !== state.renderToken) return;
  if (!status.data.ok) {
    view.append(notice(`无权查看系统状态（${status.data.code ?? status.status}）。`, 'danger'));
    return;
  }
  const s = status.data;
  const auditOk = s.audit.ok === true;

  view.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el('h3', { class: 'grow' }, '审计链'),
        badge(auditOk ? '链校验通过' : '链校验失败', auditOk ? 'ok' : 'danger'),
      ),
      el(
        'dl',
        { class: 'kv' },
        el('dt', {}, '记录条数'),
        el('dd', {}, String(s.audit.length)),
        el('dt', {}, '链尾哈希'),
        el('dd', { class: 'mono' }, String(s.audit.lastHash ?? '（空）')),
        el('dt', {}, '首个异常位置'),
        el('dd', {}, s.audit.brokenAt === null ? '无' : `${s.audit.brokenAt}（${s.audit.reason}）`),
        el('dt', {}, '库结构版本'),
        el('dd', { class: 'mono' }, String(s.schemaVersion ?? '未知')),
        el('dt', {}, '服务器时间'),
        el('dd', { class: 'mono' }, s.serverTime),
      ),
    ),
  );

  view.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, '数据规模与来源'),
      el(
        'div',
        { class: 'grid-3' },
        statCard(s.counts.occurrences, '课次'),
        statCard(s.counts.changeCases, '调课方案'),
        statCard(s.counts.effectiveChanges, '已生效方案'),
        statCard(s.counts.emergencyRequests, '求助记录'),
        statCard(s.counts.teachers, '教师'),
        statCard(s.counts.accounts, '账号'),
      ),
      el('div', { class: 'divider' }),
      el(
        'div',
        { class: 'row' },
        badge(`模拟 ${s.origins.simulated}`, 'warn'),
        badge(`导入未核验 ${s.origins.importedUnverified}`, 'warn'),
        badge(`学校正式 ${s.origins.official}`, s.origins.official > 0 ? 'ok' : ''),
        el('span', { class: 'hint' }, '模拟数据永远不会被标记为正式数据。'),
      ),
    ),
  );

  const events = recent.data.ok ? (recent.data.events ?? []) : [];
  view.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `全校审计（最近 ${events.length} 条）`),
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, '序号'), el('th', {}, '时间'), el('th', {}, '操作'), el('th', {}, '对象'), el('th', {}, '操作者'))),
        el(
          'tbody',
          {},
          ...events.map((e) =>
            el(
              'tr',
              {},
              el('td', { class: 'mono' }, String(e.seq)),
              el('td', { class: 'mono' }, e.at),
              el('td', {}, e.action),
              el('td', { class: 'mono' }, `${e.objectType}/${e.objectId}`),
              el('td', { class: 'mono' }, e.actor),
            ),
          ),
        ),
      ),
    ),
  );
}

function statCard(n, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'n' }, String(n)), el('div', { class: 'l' }, label));
}

/* ------------------------------------------------------------------ 启动 */

void boot();
