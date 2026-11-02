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
const KIND_LABEL = { REASSIGN: '改派', MOVE: '调整时间', CANCEL: '停课' };
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
  if (!items.some(([key]) => key === state.section)) state.section = items[0][0];

  for (const [key, label] of items) {
    nav.append(
      el(
        'button',
        {
          type: 'button',
          'aria-current': state.section === key ? 'page' : null,
          onclick: () => go(key),
        },
        label,
      ),
    );
  }

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
  renderSection(main);
}

function go(section) {
  state.section = section;
  state.selectedSlot = null;
  state.selectedCase = null;
  renderShell();
  window.scrollTo(0, 0);
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

  const toolbar = el(
    'div',
    { class: 'row' },
    el('label', { class: 'field' }, el('span', {}, '学期'), termToolbar(() => renderSectionRefresh())),
    el('div', { class: 'spacer grow' }),
    el('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(-1) }, '上一周'),
    el('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(1) }, '下一周'),
    el('button', { class: 'btn', type: 'button', onclick: () => { state.weekStart = defaultWeekStart(term); renderSectionRefresh(); } }, '本周'),
  );

  view.append(
    el(
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
    ),
  );

  const res = await api(`/api/timetable/me?termId=${encodeURIComponent(term.id)}&from=${from}&to=${to}`);
  if (token !== state.renderToken) return;
  if (!res.data.ok) {
    const code = res.data.code ?? String(res.status);
    const text =
      code === 'NOT_A_TEACHER'
        ? '当前身份未绑定教师档案，因此没有"本人课表"。课务管理请使用导入预览与系统状态页。'
        : `无法读取课表（${code}）。`;
    view.append(notice(text, 'warn'));
    return;
  }

  const v = res.data.view ?? {};
  const rows = Array.isArray(v.rows) ? v.rows : [];

  if (!v.complete) {
    view.append(
      notice(
        '本视图不完整：存在无法判定的日期或课次。缺时间不等于没课，系统不会替你推断。',
        'warn',
      ),
    );
  }

  view.append(renderBoard(rows, from));

  const pending = el('div', { id: 'slot-detail' });
  view.append(pending);
  if (state.selectedSlot) renderSlotDetail(pending, state.selectedSlot, term);

  const issues = [];
  for (const d of v.unknownDays ?? []) issues.push(`${d.date}：${d.reason}`);
  for (const u of v.unresolved ?? []) issues.push(`${u.date ?? ''} ${u.templateId ?? ''}：${u.reason ?? 'UNRESOLVED'}`);
  if (issues.length > 0) {
    view.append(
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

function renderBoard(rows, from) {
  const dates = WEEKDAYS.map((_, i) => addDays(from, i));
  const periods = [...new Set(rows.map((r) => r.period))].sort((a, b) => a - b);
  const maxPeriod = periods.length > 0 ? Math.max(...periods) : 8;
  const list = [];
  for (let p = 1; p <= maxPeriod; p++) list.push(p);

  const head = el(
    'tr',
    {},
    el('th', { class: 'period-head' }, '节次'),
    ...dates.map((d, i) => el('th', {}, WEEKDAYS[i], el('span', { class: 'date' }, fmtDate(d)))),
  );

  const body = el('tbody');
  for (const period of list) {
    const tr = el('tr');
    tr.append(el('td', { class: 'period' }, `第${period}节`));
    for (const date of dates) {
      const cell = el('td');
      const items = rows.filter((r) => r.date === date && r.period === period);
      if (items.length === 0) {
        cell.append(el('div', { class: 'slot empty' }));
      } else {
        for (const row of items) cell.append(slotButton(row));
      }
      tr.append(cell);
    }
    body.append(tr);
  }

  const weekend = rows.filter((r) => !dates.includes(r.date));
  const wrap = el('div', { class: 'card' });
  wrap.append(el('table', { class: 'board' }, el('thead', {}, head), body));
  if (weekend.length > 0) {
    wrap.append(
      el('div', { class: 'divider' }),
      el('h3', {}, '本时段内的非工作日课次'),
      el('div', { class: 'stack' }, ...weekend.map((r) => slotButton(r))),
    );
  }
  return wrap;
}

function slotButton(row) {
  const cls = `slot${row.certainty === 'UNKNOWN' ? ' is-unknown' : ''}${row.cancelled ? ' is-cancelled' : ''}`;
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
    el('span', { class: 'subject' }, row.subjectName),
    el('span', { class: 'meta' }, `${row.className} · ${row.startsAt ?? '时间未配置'}${row.endsAt ? `-${row.endsAt}` : ''}`),
    el(
      'span',
      { class: 'tags' },
      row.certainty === 'UNKNOWN' ? badge('时间待核验', 'warn') : null,
      row.cancelled ? badge('已停课', 'danger') : null,
    ),
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
        el('span', { class: 'hint' }, '调课是"授课责任变更"，需要受影响教师本人逐人确认。'),
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
  const submitted = mine.data.submitted ?? [];
  const awaiting = mine.data.awaiting ?? [];
  state.refs = refs.data.ok ? refs.data : { teachers: [], classes: [], subjects: [] };
  state.pref = pref.data.ok ? pref.data : null;

  const tabs = el('div', { class: 'tabs' });
  const panel = el('div');
  const entries = [
    ['awaiting', `待我确认（${awaiting.length}）`],
    ['submitted', `我发起的（${submitted.length}）`],
    ['new', '新建方案'],
  ];
  for (const [key, label] of entries) {
    tabs.append(
      el(
        'button',
        {
          type: 'button',
          'aria-selected': state.changeTab === key ? 'true' : 'false',
          onclick: () => {
            state.changeTab = key;
            renderSectionRefresh();
          },
        },
        label,
      ),
    );
  }
  view.append(tabs, panel);

  if (state.changeTab === 'awaiting') renderAwaiting(panel, awaiting);
  else if (state.changeTab === 'submitted') await renderSubmitted(panel, submitted, token);
  else await renderNewChange(panel, term, token);
}

function caseHeadLine(item) {
  const cur = item.current;
  const left = cur
    ? `${cur.className} ${cur.subjectName} · ${cur.date} 第${cur.period}节 · ${cur.teacherName}`
    : `${item.occurrenceId}（课次已不存在）`;
  let right = '';
  if (item.kind === 'REASSIGN') right = `改派给 ${item.toTeacherName ?? item.toTeacherId ?? '未指定'}`;
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

  if (options.length === 0) {
    panel.append(
      notice(
        '本时段没有可发起调课的课次。请先在"我的课表"选择要调整的课次，或切换周次。',
        'warn',
      ),
    );
    return;
  }

  const occurrenceSelect = el(
    'select',
    {},
    ...options.map((r) =>
      el(
        'option',
        {
          value: r.occurrenceId,
          selected: picked?.occurrenceId === r.occurrenceId,
        },
        `${r.date} 第${r.period}节 · ${r.className} ${r.subjectName}`,
      ),
    ),
  );

  /**
   * 改派对象：默认给"按规则排过序的候选"，而不是全校名单。
   * 推荐不锁死选择——推荐之外仍然可选，界面会说明为什么要自行核对。
   */
  const TIER_LABEL = { SAME_CLASS: '任教该班', SAME_GRADE: '任教同年级', CROSS_GRADE: '跨年级' };
  const teacherSelect = el('select', {});
  const candidateHint = el('p', { class: 'hint' });
  const excludedHint = el('p', { class: 'hint' });
  let candidates = [];
  let excluded = [];

  /**
   * 筛选条件：默认取"我的偏好 > 全校默认 > 中性默认"（服务端已算好），
   * 教师可以在这里临时改，也可以存成自己的偏好。系统不替学校把口径写死。
   */
  const serverPref = state.pref?.preference ?? null;
  const prefState = {
    considerSameClass: serverPref?.consider?.sameClass ?? true,
    considerSameGrade: serverPref?.consider?.sameGrade ?? true,
    considerSameSubject: serverPref?.consider?.sameSubject ?? true,
    considerLightLoad: serverPref?.consider?.lightLoad ?? true,
    excludeBusyAtSlot: serverPref?.exclude?.busyAtSlot ?? false,
    excludeConsecutive: serverPref?.exclude?.consecutive ?? false,
    consecutiveLimit: serverPref?.exclude?.consecutiveLimit ?? 3,
    excludeDayTotal: serverPref?.exclude?.dayTotal ?? false,
    dayTotalLimit: serverPref?.exclude?.dayTotalLimit ?? 6,
    hintClassSubjectDay: serverPref?.hint?.classSubjectDay ?? true,
    classSubjectDayLimit: serverPref?.hint?.classSubjectDayLimit ?? 2,
  };

  const cbSameClass = el('input', { type: 'checkbox', checked: prefState.considerSameClass });
  const cbSameGrade = el('input', { type: 'checkbox', checked: prefState.considerSameGrade });
  const cbSameSubject = el('input', { type: 'checkbox', checked: prefState.considerSameSubject });
  const cbLightLoad = el('input', { type: 'checkbox', checked: prefState.considerLightLoad });
  const cbBusy = el('input', { type: 'checkbox', checked: prefState.excludeBusyAtSlot });
  const cbRun = el('input', { type: 'checkbox', checked: prefState.excludeConsecutive });
  const numRun = el('input', {
    type: 'number',
    min: '1',
    max: '20',
    value: String(prefState.consecutiveLimit),
  });
  const cbTotal = el('input', { type: 'checkbox', checked: prefState.excludeDayTotal });
  const numTotal = el('input', { type: 'number', min: '1', max: '20', value: String(prefState.dayTotalLimit) });
  const numSubjectDay = el('input', {
    type: 'number',
    min: '1',
    max: '20',
    value: String(prefState.classSubjectDayLimit),
  });

  function readPref() {
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
  }

  const saveMine = el('button', { type: 'button', class: 'btn' }, '保存为我的偏好');
  saveMine.addEventListener('click', async () => {
    const r = await api('/api/preferences/change', { method: 'PUT', body: readPref() });
    toast(r.data.ok ? '已保存为我的筛选偏好，下次发起调课默认使用。' : `保存失败（${r.data.code ?? r.status}）`, !r.data.ok);
  });

  const saveSchool = el('button', { type: 'button', class: 'btn' }, '设为全校默认');
  saveSchool.addEventListener('click', async () => {
    const r = await api('/api/preferences/change/school', { method: 'PUT', body: readPref() });
    toast(
      r.data.ok ? '已保存为全校默认筛选（教师仍可在自己的偏好里覆盖）。' : `保存失败（${r.data.code ?? r.status}）`,
      !r.data.ok,
    );
  });

  const filterBox = el(
    'details',
    { class: 'card' },
    el('summary', {}, '候选筛选（可选：考虑什么、不考虑谁）'),
    el('p', { class: 'hint' }, '只影响给你看的排序与显示；不影响谁必须确认，也不改变冲突判定。'),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'check' }, cbSameClass, '任教该班'),
      el('label', { class: 'check' }, cbSameGrade, '任教同年级'),
      el('label', { class: 'check' }, cbSameSubject, '任教同一科目'),
      el('label', { class: 'check' }, cbLightLoad, '当天课时少'),
    ),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'check' }, cbBusy, '该节次本人有课'),
      el('label', { class: 'check' }, cbRun, '接手后连上 ≥', numRun, '节'),
    ),
    el('div', { class: 'row' }, el('label', { class: 'check' }, cbTotal, '接手后当天超过', numTotal, '节')),
    el('p', { class: 'hint' }, '该班当天同一科目达到', numSubjectDay, '节时提示（只提示，不排除）。'),
    el('div', { class: 'row mt10' }, saveMine, state.pref?.canEditSchool ? saveSchool : null),
  );

  for (const box of [cbSameClass, cbSameGrade, cbSameSubject, cbLightLoad, cbBusy, cbRun, cbTotal]) {
    box.addEventListener('change', () => {
      if (kind.value === 'REASSIGN') void loadCandidates();
    });
  }
  for (const box of [numRun, numTotal, numSubjectDay]) {
    box.addEventListener('change', () => {
      if (kind.value === 'REASSIGN') void loadCandidates();
    });
  }

  function allTeachers() {
    return (state.refs?.teachers ?? []).filter((t) => t.id !== state.principal?.teacherId);
  }

  function optionOf(candidate) {
    const tags = candidate.reasons
      .filter((r) => !r.startsWith('当天'))
      .slice(0, 2)
      .join(' · ');
    const name = candidate.teacherName ?? candidate.teacherId;
    return el('option', { value: candidate.teacherId }, tags === '' ? name : `${name}（${tags}）`);
  }

  function fillTeacherSelect() {
    clear(teacherSelect);
    if (candidates.length === 0) {
      for (const t of allTeachers()) teacherSelect.append(el('option', { value: t.id }, t.name));
      return;
    }
    const recommended = candidates.filter((c) => c.freeAtSlot);
    const needSwap = candidates.filter((c) => !c.freeAtSlot && (c.teachesSubject || c.tier !== 'CROSS_GRADE'));
    const others = candidates.filter((c) => !c.freeAtSlot && !c.teachesSubject && c.tier === 'CROSS_GRADE');
    if (recommended.length > 0) {
      teacherSelect.append(
        el('optgroup', { label: '推荐（该节次本人无课，按匹配度排序）' }, ...recommended.map(optionOf)),
      );
    }
    if (needSwap.length > 0) {
      teacherSelect.append(
        el('optgroup', { label: '该节次有课 · 需先与对方对调' }, ...needSwap.map(optionOf)),
      );
    }
    if (others.length > 0) {
      teacherSelect.append(el('optgroup', { label: '其他教师' }, ...others.map(optionOf)));
    }
  }

  function syncHint() {
    const found = candidates.find((c) => c.teacherId === teacherSelect.value);
    if (!found) {
      candidateHint.textContent =
        candidates.length === 0 ? '' : '该教师不在候选评估范围内，请自行核对对方该节次是否有课。';
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

  async function loadCandidates() {
    const occurrenceId = occurrenceSelect.value;
    if (!occurrenceId) return;
    // 预览：把界面上当前的筛选条件交给服务端算一遍，不落库。
    const payload = { termId: term.id, occurrenceId, preference: readPref() };
    if (kind.value === 'MOVE') {
      payload.toDate = dateField.value;
      payload.toPeriod = Number(periodField.value);
    }
    const r = await api('/api/changes/candidates/preview', { method: 'POST', body: payload });
    if (token !== state.renderToken) return;
    candidates = r.data.ok ? (r.data.candidates ?? []) : [];
    excluded = r.data.ok ? (r.data.excluded ?? []) : [];
    fillTeacherSelect();
    renderExcluded();
    if (!r.data.ok) {
      candidateHint.textContent = `候选推荐不可用（${r.data.code ?? r.status}），下列为全部教师，请自行核对。`;
      return;
    }
    syncHint();
  }

  teacherSelect.addEventListener('change', syncHint);
  occurrenceSelect.addEventListener('change', () => {
    if (kind.value === 'REASSIGN') void loadCandidates();
  });

  const dateField = el('input', { type: 'date', value: from });
  const periodField = el('input', { type: 'number', min: '1', max: '20', value: '1' });

  const targetTeacher = el(
    'label',
    { class: 'field' },
    el('span', {}, '改派给'),
    teacherSelect,
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

  const kind = el(
    'select',
    {},
    el('option', { value: 'REASSIGN' }, '改派（换授课教师）'),
    el('option', { value: 'MOVE' }, '调整时间（换日期/节次）'),
    el('option', { value: 'CANCEL' }, '停课'),
  );

  const reason = el('textarea', { placeholder: '可选。说明会作为方案的一部分留存；他人不会看到你的私人说明。' });
  const result = el('div');

  function syncKind() {
    targetTeacher.hidden = kind.value !== 'REASSIGN';
    targetMove.hidden = kind.value !== 'MOVE';
    targetNone.hidden = kind.value !== 'CANCEL';
  }
  kind.addEventListener('change', () => {
    syncKind();
    // 切到"改派"时才需要候选名单；已加载过就复用，避免重复请求。
    if (kind.value === 'REASSIGN' && candidates.length === 0) void loadCandidates();
  });

  const form = el(
    'form',
    {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        const occurrenceId = occurrenceSelect.value;
        const payload = {
          termId: term.id,
          items: [
            {
              occurrenceId,
              kind: kind.value,
              toTeacherId: kind.value === 'REASSIGN' ? teacherSelect.value : null,
              toDate: kind.value === 'MOVE' ? dateField.value : null,
              toPeriod: kind.value === 'MOVE' ? Number(periodField.value) : null,
            },
          ],
          reason: reason.value.trim() === '' ? null : reason.value.trim(),
          idempotencyKey: newIdempotencyKey(),
        };
        clear(result);
        const r = await api('/api/changes', { method: 'POST', body: payload });
        result.append(renderChangeResult(r));
        if (r.data.ok) {
          state.pendingOccurrence = null;
          reason.value = '';
        }
      },
    },
    el('h3', {}, '新建调课方案'),
    el('p', { class: 'hint' }, '提交后进入"待确认"，必须由受影响的教师本人逐人确认，系统不会自动视为同意。'),
    el('label', { class: 'field' }, el('span', {}, '课次'), occurrenceSelect),
    el('label', { class: 'field' }, el('span', {}, '变更方式'), kind),
    filterBox,
    targetTeacher,
    targetMove,
    targetNone,
    el('label', { class: 'field' }, el('span', {}, '发起说明'), reason),
    el('div', { class: 'row mt10' }, el('button', { class: 'btn primary', type: 'submit' }, '提交方案')),
    result,
  );
  syncKind();
  panel.append(form);
  fillTeacherSelect();
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
