/**
 * FoxBox 界面。
 *
 * 刻意不引框架、不做构建：产物就是三个静态文件，改完刷新即生效。
 * 后续要包进 Tauri，这一层可以原样塞进 WebView，不需要重写。
 */

const { token, port } = window.__FOXBOX__;

const API = {
  async call(path, { method = 'GET', body } = {}) {
    // 只在真的有 body 时才带 content-type：Fastify 见到 json 头会强制要求 body
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    if (!res.ok) {
      const err = new Error(data?.message || `请求失败（${res.status}）`);
      err.code = data?.error;
      err.payload = data;
      throw err;
    }
    return data;
  },
};

const state = {
  view: 'profiles',
  profiles: [],
  total: 0,
  proxies: [],
  groups: [],
  audit: [],
  tasks: [],
  automations: [],
  automationScheduler: null,
  automationRuns: {},
  datasets: [],
  datasetsLoaded: false,
  dataset: null,
  datasetRows: { rows: [], total: 0 },
  datasetQuery: { q: '', offset: 0, limit: 50 },
  expandedAutomation: null,
  expandedTask: null,
  system: null,
  filter: { q: '', groupId: null, ungrouped: false, status: '' },
  selection: new Set(),
  drawer: null,
  drawerTab: 'fingerprint',
  drawerFresh: false,
  drawerData: { validate: null, launches: [], selfcheck: null, automation: null, tryResult: null, loading: false },
  expandedAudit: new Set(),
  busy: new Set(),
  loading: true,
  error: null,
};

// ---------------------------------------------------------------- 工具

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const STATUS_LABEL = { idle: '未运行', starting: '启动中', running: '运行中', error: '异常' };
const PROTO_LABEL = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function clock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const tzShort = (tz) => (tz ? String(tz).split('/').pop().replace(/_/g, ' ') : '—');
const browserShort = (v) => String(v || '').split('.')[0] || '—';
const screenText = (s) => (s ? `${s.width}×${s.height}` : '—');

function proxyLabel(profile) {
  if (!profile.proxyId) return '<span class="faint">直连</span>';
  const proxy = state.proxies.find((p) => p.id === profile.proxyId);
  if (!proxy) return '<span class="chip bad">代理已删除</span>';
  const country = proxy.lastCheckCountry || proxy.expectedCountry;
  const mismatch = proxy.lastCheckCountry && proxy.expectedCountry && proxy.lastCheckCountry !== proxy.expectedCountry;
  const health = proxy.lastCheckOk === false ? 'bad' : mismatch ? 'warn' : proxy.lastCheckOk ? 'ok' : '';
  const title = mismatch ? `申报 ${proxy.expectedCountry}，实测 ${proxy.lastCheckCountry}` : '';
  return `<span class="chip ${health}" title="${esc(title)}">${esc(country || '??')} · ${esc(proxy.name)}</span>`;
}

const ICON = {
  layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>',
  pulse: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 13 4 4 10-10"/></svg>',
  clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>',
  table: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></svg>',
  download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>',
};

// ---------------------------------------------------------------- 数据

async function loadProfiles() {
  const { q, groupId, ungrouped, status } = state.filter;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (groupId) params.set('groupId', groupId);
  if (ungrouped) params.set('ungrouped', 'true');
  if (status) params.set('status', status);
  const data = await API.call(`/api/profiles?${params.toString()}`);
  state.profiles = data.items;
  state.total = data.total;
  const alive = new Set(state.profiles.map((p) => p.id));
  for (const id of [...state.selection]) if (!alive.has(id)) state.selection.delete(id);
}

async function loadAll({ silent = false } = {}) {
  if (!silent) state.loading = true;
  try {
    const [proxies, groups, system] = await Promise.all([
      API.call('/api/proxies'),
      API.call('/api/groups'),
      API.call('/api/system'),
      loadProfiles(),
    ]);
    state.proxies = proxies;
    state.groups = groups;
    state.system = system;
    if (state.view === 'audit') state.audit = await API.call('/api/audit');
    if (state.view === 'tasks') state.tasks = await API.call('/api/tasks');
    if (state.view === 'datasets') {
      state.datasets = await API.call('/api/datasets');
      state.datasetsLoaded = true;
      // 选中的数据集被删掉后，退回第一个，避免右侧一直空着
      if (state.dataset && !state.datasets.some((d) => d.id === state.dataset.id)) {
        state.dataset = null;
      }
      if (!state.dataset && state.datasets.length > 0) state.dataset = state.datasets[0];
      if (state.dataset) await loadDatasetRows({ silent: true });
    }
    if (state.view === 'automations') {
      // 任务列表一起取：卡片上要显示「跑任务「xxx」」，只拿规则会全变成"已删除"
      const [data, tasks] = await Promise.all([API.call('/api/automations'), API.call('/api/tasks')]);
      state.automations = data.items;
      state.automationScheduler = data.scheduler;
      state.tasks = tasks;
    }
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    // 轮询时数据没变就不重绘：否则每 4 秒整页闪一下，抽屉动画也会重播
    const signature = JSON.stringify([
      state.view,
      state.profiles,
      state.proxies,
      state.groups,
      state.system,
      state.audit,
      state.tasks,
      state.automations,
      state.automationRuns,
      state.datasets,
      state.dataset,
      state.datasetRows.rows.length,
      state.datasetRows.total,
      state.datasetQuery.q,
    ]);
    if (!silent || signature !== lastSignature) {
      lastSignature = signature;
      render();
    }
  }
}

let lastSignature = '';

async function refreshDrawer(id) {
  state.drawerData.loading = true;
  state.drawerData.validate = null;
  state.drawerData.launches = [];
  state.drawerData.selfcheck = null;
  state.drawerData.automation = null;
  state.drawerData.tryResult = null;
  render();
  try {
    const [validate, launches, automation] = await Promise.all([
      API.call(`/api/profiles/${id}/validate`),
      API.call(`/api/profiles/${id}/launches?limit=8`),
      // 自动化信息失败不该拖垮整个抽屉：老版本后端没有这个路由
      API.call(`/api/profiles/${id}/automation`).catch(() => null),
    ]);
    state.drawerData.validate = validate;
    state.drawerData.launches = launches;
    state.drawerData.automation = automation;
  } catch (error) {
    toast('读取详情失败', error.message, 'bad');
  } finally {
    state.drawerData.loading = false;
    render();
  }
}

// ---------------------------------------------------------------- 渲染

/**
 * 导出走 fetch + blob，而不是直接给 <a href>。
 *
 * 导出接口要 Bearer token，而 <a> 带不了请求头；把 token 塞进 URL 又会留在
 * 浏览历史里。代价是整包先落在内存——10 万行约 30MB，换来的是不用给导出
 * 单独开一条鉴权更弱的路径。
 */
async function exportDataset(format) {
  const ds = state.dataset;
  if (!ds) return;
  try {
    const res = await fetch(`/api/datasets/${ds.id}/export?format=${format}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? `${ds.name}.${format}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('已开始下载', `${name} · ${formatSize(blob.size)}`, 'ok');
  } catch (error) {
    toast('导出失败', error.message, 'bad');
  }
}

function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function loadDatasetRows({ silent = false } = {}) {  if (!state.dataset) {
    state.datasetRows = { rows: [], total: 0 };
    return;
  }
  const { q, offset, limit } = state.datasetQuery;
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (q) params.set('q', q);
  try {
    const data = await API.call(`/api/datasets/${state.dataset.id}/rows?${params.toString()}`);
    state.datasetRows = { rows: data.rows, total: data.total };
    // 列定义以服务端为准：schema 会随新字段增长，前端不该自己拍
    if (data.columns) state.dataset = { ...state.dataset, columns: data.columns };
  } catch (error) {
    if (!silent) toast('读取数据失败', error.message, 'bad');
    state.datasetRows = { rows: [], total: 0 };
  }
}

function render() {
  const active = document.activeElement;
  const focusId = active?.id || null;
  const caret = active && 'selectionStart' in active ? active.selectionStart : null;
  // 4 秒轮询会重绘整个视图，不记住滚动位置的话列表会自己跳回顶部
  const content = $('.content');
  const scrollTop = content?.scrollTop ?? 0;
  const drawerBody = $('.drawer-body');
  const drawerScroll = drawerBody?.scrollTop ?? 0;

  $('#app').innerHTML = `
    ${renderSidebar()}
    <div class="main">
      ${renderTopbar()}
      <div class="content">${renderContent()}</div>
    </div>
    ${renderDrawer()}
  `;

  const nextContent = $('.content');
  if (nextContent && scrollTop) nextContent.scrollTop = scrollTop;
  const nextDrawer = $('.drawer-body');
  if (nextDrawer && drawerScroll) nextDrawer.scrollTop = drawerScroll;

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret != null && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* number input 不支持，忽略 */
        }
      }
    }
  }
  state.drawerFresh = false;
}

function renderSidebar() {
  const running = state.profiles.filter((p) => p.status === 'running').length;
  const groups = state.groups
    .map(
      (g) => `
      <button class="nav-item" data-act="filter-group" data-id="${esc(g.id)}"
        aria-current="${state.filter.groupId === g.id}">
        <span class="faint">·</span>${esc(g.name)}<span class="count">${g.profileCount}</span>
      </button>`,
    )
    .join('');

  return `
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">F</div>
      <div>
        <div class="brand-title">FoxBox</div>
        <div class="brand-sub">本地环境工作台</div>
      </div>
    </div>

    <button class="nav-item" data-act="view" data-id="profiles" aria-current="${state.view === 'profiles'}">
      ${ICON.layers} 环境<span class="count">${state.total}</span>
    </button>
    <button class="nav-item" data-act="view" data-id="proxies" aria-current="${state.view === 'proxies'}">
      ${ICON.globe} 代理<span class="count">${state.proxies.length}</span>
    </button>
    <button class="nav-item" data-act="view" data-id="tasks" aria-current="${state.view === 'tasks'}">
      ${ICON.play} 任务<span class="count">${state.system?.tasks ?? 0}</span>
    </button>
    <button class="nav-item" data-act="view" data-id="datasets" aria-current="${state.view === 'datasets'}">
      ${ICON.table} 数据<span class="count">${state.system?.datasets ?? 0}</span>
    </button>
    <button class="nav-item" data-act="view" data-id="automations" aria-current="${state.view === 'automations'}">
      ${ICON.clock} 自动化<span class="count">${state.system?.automations ?? 0}</span>
    </button>
    <button class="nav-item" data-act="view" data-id="audit" aria-current="${state.view === 'audit'}">
      ${ICON.pulse} 审计
    </button>

    <div class="nav-label">分组</div>
    <button class="nav-item" data-act="filter-group" data-id=""
      aria-current="${!state.filter.groupId && !state.filter.ungrouped}">
      <span class="faint">·</span>全部环境<span class="count">${state.total}</span>
    </button>
    ${groups}
    <button class="nav-item" data-act="filter-group" data-id="__ungrouped__"
      aria-current="${state.filter.ungrouped}">
      <span class="faint">·</span>未分组
    </button>
    <button class="nav-item" data-act="new-group" style="color:#6f7d8f">
      ${ICON.plus} 新建分组
    </button>

    <div class="sidebar-foot">
      <div>运行中 <b>${running}</b> · 并发上限 <b>${state.system?.engines?.maxConcurrent ?? '—'}</b></div>
      <div>引擎 <b>${esc((state.system?.engines?.engines || []).join(' / ') || 'camoufox')}</b></div>
      <div>端口 <b>${port}</b></div>
    </div>
  </aside>`;
}

function renderTopbar() {
  if (state.view === 'proxies') {
    return `
      <header class="topbar">
        <h1>代理</h1>
        <span class="sub">${state.proxies.length} 条 · 预检结果保存在本地</span>
        <div class="spacer"></div>
        <button class="btn" data-act="check-all">${ICON.refresh} 全部预检</button>
        <button class="btn primary" data-act="new-proxy">${ICON.plus} 新建代理</button>
      </header>`;
  }
  if (state.view === 'tasks') {
    return `
      <header class="topbar">
        <h1>任务</h1>
        <span class="sub">一串动作对多个环境执行 · 每步结果留证</span>
        <div class="spacer"></div>
        <button class="btn primary" data-act="new-task">${ICON.plus} 新建任务</button>
      </header>`;
  }
  if (state.view === 'automations') {
    return `
      <header class="topbar">
        <h1>自动化</h1>
        <span class="sub">到点自动跑 · 代理失效自动处理</span>
        <div class="spacer"></div>
        <button class="btn primary" data-act="new-automation">${ICON.plus} 新建规则</button>
      </header>`;
  }
  if (state.view === 'datasets') {
    return `
      <header class="topbar">
        <h1>数据</h1>
        <span class="sub">采集落表 · 可去重、可增量、可导出</span>
        <div class="spacer"></div>
        <button class="btn" data-act="reload">${ICON.refresh} 刷新</button>
      </header>`;
  }
  if (state.view === 'audit') {
    return `
      <header class="topbar">
        <h1>审计</h1>
        <span class="sub">最近 50 条动作 · 不含 Cookie 与密码</span>
        <div class="spacer"></div>
        <button class="btn" data-act="reload">${ICON.refresh} 刷新</button>
      </header>`;
  }
  return `
    <header class="topbar">
      <h1>环境</h1>
      <span class="sub">${state.total} 个</span>
      <div class="spacer"></div>
      <div class="search">
        ${ICON.search}
        <input id="q" placeholder="搜索环境名" value="${esc(state.filter.q)}" autocomplete="off" />
      </div>
      <select class="control" id="status-filter" style="width:104px">
        ${['', 'idle', 'starting', 'running', 'error']
          .map(
            (s) =>
              `<option value="${s}" ${state.filter.status === s ? 'selected' : ''}>${
                s ? STATUS_LABEL[s] : '全部状态'
              }</option>`,
          )
          .join('')}
      </select>
      <button class="btn" data-act="session-check">${ICON.pulse} 检测登录态</button>
      <button class="btn primary" data-act="new-profile">${ICON.plus} 新建环境</button>
    </header>`;
}

function renderContent() {
  if (state.error) {
    return `<div class="empty"><h3>连不上本地服务</h3><p>${esc(state.error)}</p>
      <button class="btn" data-act="reload">重试</button></div>`;
  }
  if (state.view === 'proxies') return renderProxies();
  if (state.view === 'tasks') return renderTasks();
  if (state.view === 'datasets') return renderDatasets();
  if (state.view === 'automations') return renderAutomations();
  if (state.view === 'audit') return renderAudit();
  return renderProfiles();
}

function renderStats() {
  const running = state.profiles.filter((p) => p.status === 'running').length;
  const unhealthy = state.proxies.filter((p) => p.lastCheckOk === false).length;
  const expired = state.profiles.filter((p) => p.lastSessionStatus === 'expired').length;
  const unchecked = state.profiles.filter((p) => !p.lastSessionStatus).length;
  return `
  <div class="stat-row">
    <div class="stat"><b>${state.total}</b><span>环境总数</span></div>
    <div class="stat"><b style="color:${running ? '#74d083' : 'inherit'}">${running}</b><span>运行中</span></div>
    <div class="stat"><b>${state.proxies.length}</b><span>代理${
      unhealthy ? ` · <span style="color:#ff8b84">${unhealthy} 条异常</span>` : ''
    }</span></div>
    <div class="stat"><b>${state.system?.engines?.slots ?? '—'}</b><span>剩余并发名额</span></div>
    <div class="stat"><b style="color:${expired ? '#ff8b84' : 'inherit'}">${expired}</b><span>需重新登录${
      unchecked ? ` · <span class="faint">${unchecked} 个未检测</span>` : ''
    }</span></div>
  </div>`;
}

/**
 * 身份健康角标。
 *
 * 只在 diff 非空时出现，且用琥珀色而不是红色：身份对不上不会立刻坏事，
 * 但它会让这个环境「看起来不像一台真机」，越早重建越省事。
 * 红色留给"已经确认出问题"的东西（会话失效、代理挂了）。
 */
function healthBadge(profile) {
  const health = profile.health;
  if (!health || !Array.isArray(health.diff) || health.diff.length === 0) return '';
  const first = health.diff[0];
  const tip = health.diff
    .slice(0, 5)
    .map((d) => `${d.key}: 预期 ${d.expected}，实际 ${d.actual}`)
    .join('\n');
  return `<span class="chip warn" title="${esc(tip)}">身份待检查 ${health.diff.length}</span>`;
}

/**
 * 会话灯。
 *
 * 红色只留给「确认过已经掉登录」；打不开一律灰问号。
 * 混在一起就会在代理挂掉的那天把几十个环境全刷红，
 * 用户挨个登一遍发现都是好的，之后就再也不看这个列了。
 */
function sessionChip(profile) {
  const status = profile.lastSessionStatus;
  if (!status) return '<span class="chip muted" title="还没有检测过">未检测</span>';
  const map = {
    alive: { cls: 'ok', label: '有效', tip: '能看到登录后才可见的页面' },
    expired: { cls: 'bad', label: '已失效', tip: '被重定向到登录页，或登录后才可见的内容消失' },
    unknown: { cls: 'warn', label: '未知', tip: '探针自己没打开（代理/超时/站点故障），不代表掉登录' },
  };
  const hit = map[status] ?? { cls: '', label: status, tip: '' };
  return `<span class="chip ${hit.cls}" title="${esc(hit.tip)} · ${relTime(profile.lastSessionCheckAt)}">${hit.label}</span>`;
}

function renderProfiles() {  if (state.loading && state.profiles.length === 0) {
    return `<div class="empty"><p>加载中…</p></div>`;
  }
  const rows = state.profiles.map(renderProfileRow).join('');
  const selected = state.selection.size;

  const batchbar = selected
    ? `<div class="batchbar">
        <b>已选 ${selected} 个</b>
        <button class="btn sm" data-act="batch-start">${ICON.play} 批量启动</button>
        <button class="btn sm" data-act="batch-stop">${ICON.stop} 批量关闭</button>
        <select class="control" data-act="batch-move" style="height:28px;width:140px">
          <option value="">移动到分组…</option>
          ${state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
          <option value="__none__">移出分组</option>
        </select>
        <button class="btn sm danger" data-act="batch-delete">${ICON.trash} 删除</button>
        <div class="spacer"></div>
        <button class="btn sm ghost" data-act="clear-selection">取消选择</button>
      </div>`
    : '';

  const table = state.profiles.length
    ? `<div class="table-wrap"><table class="grid">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" data-act="select-all"
            ${selected && selected === state.profiles.length ? 'checked' : ''} /></th>
          <th>环境</th>
          <th style="width:96px">状态</th>
          <th style="width:92px">会话</th>
          <th style="width:150px">身份</th>
          <th style="width:132px">语言 / 时区</th>
          <th style="width:96px">屏幕</th>
          <th style="width:150px">代理</th>
          <th style="width:92px">最后打开</th>
          <th style="width:132px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<div class="empty">
        <h3>还没有环境</h3>
        <p>每个环境是一份固定的浏览器身份：UA、时区、屏幕、WebGL 在创建时固化，之后永不改变。</p>
        <button class="btn primary" data-act="new-profile">${ICON.plus} 新建第一个环境</button>
      </div>`;

  return renderStats() + batchbar + table;
}

function renderProfileRow(p) {
  const running = p.status === 'running';
  const group = state.groups.find((g) => g.id === p.groupId);
  return `
  <tr data-act="open" data-id="${esc(p.id)}" class="${state.selection.has(p.id) ? 'selected' : ''}">
    <td><input type="checkbox" data-act="toggle-select" data-id="${esc(p.id)}"
      ${state.selection.has(p.id) ? 'checked' : ''} /></td>
    <td>
      <div class="cell-name">
        <div class="cell-title"><b>${esc(p.name)}</b>${healthBadge(p)}</div>
        <span>${esc(group ? group.name : p.note || p.id)}</span>
      </div>
    </td>
    <td><span class="status ${p.status}"><span class="dot"></span>${STATUS_LABEL[p.status]}</span></td>
    <td>${sessionChip(p)}</td>
    <td class="dim">${OS_LABEL[p.os]} · Firefox ${esc(browserShort(p.preset.browserVersion))}${
      p.headless ? '<span class="chip warn" title="无头模式：不显示浏览器窗口">无头</span>' : ''
    }</td>
    <td class="dim">${esc(p.preset.locale)} <span class="faint">${esc(tzShort(p.preset.timezone))}</span></td>
    <td class="dim mono">${screenText(p.preset.screen)}</td>
    <td>${proxyLabel(p)}</td>
    <td class="faint">${relTime(p.lastOpenedAt)}</td>
    <td>
      <div class="row-actions">
        ${
          running
            ? `<button class="btn sm" data-act="stop" data-id="${esc(p.id)}" title="关闭">${ICON.stop}</button>`
            : `<button class="btn sm" data-act="start" data-id="${esc(p.id)}" title="启动">${ICON.play}</button>`
        }
        <button class="btn sm ghost" data-act="delete" data-id="${esc(p.id)}" title="删除">${ICON.trash}</button>
      </div>
    </td>
  </tr>`;
}

function renderProxies() {
  if (state.proxies.length === 0) {
    return `<div class="empty">
      <h3>还没有代理</h3>
      <p>代理不是必须的，但"环境绑定的出口 IP"必须稳定——否则同一身份会从不同城市出现。</p>
      <button class="btn primary" data-act="new-proxy">${ICON.plus} 新建代理</button>
    </div>`;
  }
  const rows = state.proxies
    .map((proxy) => {
      const ok = proxy.lastCheckOk;
      const mismatch =
        proxy.lastCheckCountry && proxy.expectedCountry && proxy.lastCheckCountry !== proxy.expectedCountry;
      const used = state.profiles.filter((p) => p.proxyId === proxy.id).length;
      const busy = state.busy.has(`proxy:${proxy.id}`);
      return `
      <tr>
        <td>
          <div class="cell-name">
            <b>${esc(proxy.name)}</b>
            <span class="mono">${PROTO_LABEL[proxy.protocol]} · ${esc(proxy.host)}:${proxy.port}${
              proxy.username ? ` · ${esc(proxy.username)}` : ''
            }</span>
          </div>
        </td>
        <td>${
          ok === null
            ? '<span class="chip">未预检</span>'
            : ok
              ? '<span class="chip ok">可用</span>'
              : '<span class="chip bad">不可用</span>'
        }</td>
        <td class="mono dim">${proxy.lastLatencyMs != null ? `${proxy.lastLatencyMs} ms` : '—'}</td>
        <td class="mono dim">${esc(proxy.lastExitIp || '—')}</td>
        <td>${
          proxy.lastCheckCountry
            ? `<span class="chip ${mismatch ? 'warn' : 'ok'}">${esc(proxy.lastCheckCountry)}${
                proxy.lastCheckCity ? ' · ' + esc(proxy.lastCheckCity) : ''
              }</span>`
            : proxy.expectedCountry
              ? `<span class="chip">申报 ${esc(proxy.expectedCountry)}</span>`
              : '<span class="faint">—</span>'
        }</td>
        <td class="faint">${proxy.lastCheckAt ? relTime(proxy.lastCheckAt) : '—'}</td>
        <td class="faint">${used} 个环境</td>
        <td>
          <div class="row-actions" style="opacity:1">
            <button class="btn sm" data-act="check-proxy" data-id="${esc(proxy.id)}" ${
              busy ? 'disabled' : ''
            }>${busy ? '检测中…' : '预检'}</button>
            <button class="btn sm ghost" data-act="delete-proxy" data-id="${esc(proxy.id)}">${ICON.trash}</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  return `<div class="table-wrap"><table class="grid">
    <thead><tr>
      <th>代理</th><th style="width:80px">状态</th><th style="width:88px">延迟</th>
      <th style="width:130px">出口 IP</th><th style="width:150px">实测出口</th>
      <th style="width:90px">预检时间</th><th style="width:86px">被引用</th><th style="width:120px"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderDatasets() {
  // 用「拉过没有」而不是 loading 判断：切换页面时是 silent 加载，
  // loading 始终为 false，否则会先闪一帧「还没有数据」再变成列表。
  if (!state.datasetsLoaded) {
    return `<div class="empty"><p>加载中…</p></div>`;
  }
  if (state.datasets.length === 0) {
    return `<div class="empty">
      <h3>还没有数据</h3>
      <p>数据来自任务里的「采集落表」步骤：脚本返回一个数组，每项一条记录，系统按你指定的字段判重，<br />
      同一批数据反复采集只会更新内容，不会重复堆行。</p>
      <p class="dim">新建任务时加一步「采集落表」，或先看 <code>scripts/fixtures/login-site.ts</code> 里的示例。</p>
      <button class="btn primary" data-act="new-task">新建任务</button>
    </div>`;
  }

  const current = state.dataset ?? state.datasets[0];
  const list = state.datasets
    .map(
      (d) => `
    <button class="data-item" data-act="select-dataset" data-id="${esc(d.id)}"
      aria-current="${current && current.id === d.id}">
      <b>${esc(d.name)}</b>
      <span class="data-item-meta">${d.rowCount} 行 · ${d.columns.length} 列${
        d.lastWriteAt ? ` · ${relTime(d.lastWriteAt)}` : ''
      }</span>
    </button>`,
    )
    .join('');

  return `
  <div class="data-layout">
    <aside class="data-list">
      <div class="data-list-head">${state.datasets.length} 个数据集</div>
      ${list}
    </aside>
    <section class="data-main">${renderDatasetTable(current)}</section>
  </div>`;
}

function renderDatasetTable(dataset) {
  if (!dataset) return '<div class="empty"><p>选一个数据集</p></div>';

  const { rows, total } = state.datasetRows;
  const { offset, limit, q } = state.datasetQuery;
  const columns = dataset.columns ?? [];
  const shown = rows.length;

  const head = `<tr><th class="row-no">#</th>${columns
    .map((c) => `<th title="${esc(c.key)} · ${esc(c.type)}">${esc(c.key)}</th>`)
    .join('')}<th class="row-meta" title="这条数据被采集到过几次；同一批数据反复采集只会 +1，不会新增行">见到</th></tr>`;

  const body = rows
    .map((row, i) => {
      const cells = columns
        .map((c) => {
          const raw = row.data[c.key];
          const text = formatCell(raw);
          return `<td title="${esc(text)}" class="${raw === null || raw === undefined ? 'dim' : ''}">${esc(text)}</td>`;
        })
        .join('');
      return `<tr><td class="row-no">${offset + i + 1}</td>${cells}<td class="row-meta">${row.seenCount}×</td></tr>`;
    })
    .join('');

  const pager =
    total > limit
      ? `<div class="data-pager">
           <button class="btn tiny" data-act="dataset-page" data-id="prev" ${offset === 0 ? 'disabled' : ''}>上一页</button>
           <span class="dim">${offset + 1}–${Math.min(offset + shown, total)} / ${total}</span>
           <button class="btn tiny" data-act="dataset-page" data-id="next" ${
             offset + shown >= total ? 'disabled' : ''
           }>下一页</button>
         </div>`
      : '';

  return `
  <div class="data-head">
    <div>
      <h2>${esc(dataset.name)}</h2>
      <div class="data-sub">${dataset.rowCount} 行 · ${columns.length} 列 · 按 ${
        dataset.dedupe.mode === 'fields' ? `[${esc(dataset.dedupe.fields.join(', '))}] 判重` : '全字段哈希判重'
      }</div>
    </div>
    <div class="spacer"></div>
    <div class="search">
      ${ICON.search}
      <input id="dataset-q" placeholder="搜索内容" value="${esc(q)}" autocomplete="off" />
    </div>
    <button class="btn tiny" data-act="export-dataset" data-id="csv">${ICON.download} CSV</button>
    <button class="btn tiny" data-act="export-dataset" data-id="jsonl">JSONL</button>
    <button class="btn tiny" data-act="delete-dataset" data-id="${esc(dataset.id)}">${ICON.trash}</button>
  </div>
  <div class="data-table-wrap">
    <table class="data-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${columns.length + 2}" class="dim">没有匹配的行</td></tr>`}</tbody></table>
  </div>
  ${pager}`;
}

/** 单元格：对象压成一行 JSON；null 显示成 — 而不是 "null" */
function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function renderAudit() {
  if (!state.audit.length) return `<div class="empty"><p>暂无记录</p></div>`;
  const names = new Map(state.profiles.map((p) => [p.id, p.name]));
  const items = state.audit
    .map((entry) => {
      const bad = entry.action.includes('fail') || entry.action.includes('reject');
      const open = state.expandedAudit.has(String(entry.id));
      return `
      <div class="tl-item">
        <div class="tl-time">${clock(entry.createdAt)}</div>
        <div>
          <span class="chip ${bad ? 'bad' : ''}">${esc(entry.action)}</span>
          <span class="dim" style="margin-left:6px">${
            entry.profileId ? esc(names.get(entry.profileId) || entry.profileId) : '—'
          }</span>
          ${
            entry.detail
              ? `<div class="detail-line" data-act="audit-toggle" data-id="${entry.id}">
                   <span class="mono">${esc(summarizeDetail(entry.detail))}</span>
                   <span class="faint">${open ? '收起' : '展开'}</span>
                 </div>
                 ${
                   open
                     ? `<pre class="pre" style="margin:6px 0 0">${esc(JSON.stringify(entry.detail, null, 1))}</pre>`
                     : ''
                 }`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
  return `<div class="timeline">${items}</div>`;
}

/** 审计详情对人多半只需要"哪几个关键字段"，完整 JSON 留到点开时再看 */
function summarizeDetail(detail) {
  if (detail == null) return '';
  if (typeof detail !== 'object') return String(detail);
  const issues = Array.isArray(detail.issues) ? detail.issues : [];
  if (issues.length) {
    const first = issues[0];
    const more = issues.length > 1 ? ` 等 ${issues.length} 条` : '';
    return `${first.rule ? `[${first.rule}] ` : ''}${first.message || JSON.stringify(first)}${more}`;
  }
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) parts.push(`${key}[${value.length}]`);
    else if (typeof value === 'object') parts.push(`${key}{…}`);
    else parts.push(`${key}=${value}`);
    if (parts.length >= 5) break;
  }
  return parts.join(' · ');
}

function renderDrawer() {
  if (!state.drawer) return '';
  const profile = state.profiles.find((p) => p.id === state.drawer);
  if (!profile) return '';
  const data = state.drawerData;

  const tabs = [
    ['fingerprint', '指纹'],
    ['check', '一致性'],
    ['automation', '自动化'],
    ['history', '启动记录'],
  ]
    .map(
      ([key, label]) =>
        `<button class="tab" data-act="drawer-tab" data-id="${key}" aria-selected="${state.drawerTab === key}">${label}</button>`,
    )
    .join('');

  return `
  <div class="drawer-layer">
  <div class="drawer-mask ${state.drawerFresh ? '' : 'no-anim'}" data-act="drawer-close"></div>
  <aside class="drawer ${state.drawerFresh ? '' : 'no-anim'}">
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(profile.name)}</h2>
        <div class="faint mono" style="font-size:11px">${esc(profile.id)} · ${esc(OS_LABEL[profile.os])}</div>
      </div>
      <span class="status ${profile.status}"><span class="dot"></span>${STATUS_LABEL[profile.status]}</span>
      <button class="btn ghost sm" data-act="drawer-close">${ICON.close}</button>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="drawer-body">${renderDrawerBody(profile, data)}</div>
  </aside>
  </div>`;
}

function renderDrawerBody(profile, data) {
  if (state.drawerTab === 'history') return renderHistory(profile, data);
  if (state.drawerTab === 'check') return renderCheck(profile, data);
  if (state.drawerTab === 'automation') return renderAutomation(profile, data);
  return renderFingerprint(profile);
}

function geoText(p) {
  const g = p.geolocation || {};
  if (!Number.isFinite(g.latitude) || !Number.isFinite(g.longitude)) return '无效';
  const zero = Math.abs(g.latitude) < 0.01 && Math.abs(g.longitude) < 0.01;
  const base = `${g.latitude.toFixed(4)}, ${g.longitude.toFixed(4)}`;
  if (zero) return `${base} <span class="muted">· 未回填</span>`;
  return g.accuracy ? `${base} <span class="muted">±${Math.round(g.accuracy)}m</span>` : base;
}

function canvasNoiseText(profile) {
  if (profile.canvasNoise === true) return '强制覆盖（读回占位随机值）';
  if (profile.canvasNoise === false) return '<span class="warn-text">强制关闭（暴露宿主渲染）</span>';
  return '<span class="muted">自动</span>（身份与宿主渲染矛盾时覆盖）';
}

function renderFingerprint(profile) {
  const p = profile.preset;
  const proxy = state.proxies.find((x) => x.id === profile.proxyId);
  const rows = [
    ['User-Agent', p.ua],
    ['浏览器', `Firefox ${esc(browserShort(p.browserVersion))}`],
    ['系统', p.os === profile.os ? OS_LABEL[p.os] : `${OS_LABEL[p.os]}（引擎记录 ${esc(profile.os)}）`],
    ['语言', p.languages.join(', ')],
    ['时区', p.timezone],
    ['地理位置', geoText(p)],
    ['屏幕', `${p.screen.width}×${p.screen.height} · DPR ${p.screen.dpr} · ${p.screen.colorDepth}bit`],
    ['窗口内宽高', `${p.window.innerWidth}×${p.window.innerHeight}`],
    ['CPU 核心', String(p.hardwareConcurrency)],
    ['设备内存', `${p.deviceMemory} GB`],
    ['WebGL', `${esc(p.webgl.vendor)}｜${esc(p.webgl.renderer)}`],
    ['字体数', `${p.fonts.length} 个`],
    ['画布读数', canvasNoiseText(profile)],
    ['音频噪声', '不支持（引擎已移除 audio:seed）'],
    ['种子', profile.seed],
  ]
    .map(([k, v]) => `<div class="kv-row"><span>${k}</span><span>${v}</span></div>`)
    .join('');

  return `
    <div class="section">
      <h3>身份</h3>
      <div class="kv">${rows}</div>
    </div>
    <div class="section">
      <h3>代理</h3>
      <div class="kv">
        <div class="kv-row"><span>绑定</span><span>${
          proxy ? esc(`${proxy.name} · ${PROTO_LABEL[proxy.protocol]} · ${proxy.host}:${proxy.port}`) : '直连'
        }</span></div>
        <div class="kv-row"><span>出口</span><span>${
          proxy ? esc(`${proxy.lastExitIp || '—'} · ${proxy.lastCheckCountry || proxy.expectedCountry || '未预检'}`) : '本机网络'
        }</span></div>
        <div class="kv-row"><span>启动页</span><span>${esc(profile.startupUrl || 'about:blank')}</span></div>
        <div class="kv-row"><span>窗口</span><span>
          <label class="switch small" title="关掉无头，下次启动就会弹出浏览器窗口">
            <input type="checkbox" data-act="toggle-headless" data-id="${esc(profile.id)}"${
              profile.headless ? '' : ' checked'
            } /> 显示窗口
          </label>
        </span></div>
      </div>
    </div>
    <div class="section">
      <h3>为什么这个指纹可信</h3>
      <div class="note-box">
        这份身份由同一颗种子一次推导出三份数据：preset（校验基准）、CAMOU_CONFIG（引擎启动时真正读的配置）、
        engine fingerprint（让引擎跳过二次生成）。三者同源且都落库，所以每次启动读到的 UA、时区、屏幕完全一致——
        平台看到的是同一台设备，而不是一台每次见面都换零件的设备。
      </div>
    </div>`;
}

/**
 * 外部自动化：没有 CDP，如实说明，给可直接粘贴的调用方式。
 *
 * 这一页存在的意义是「别让人去翻文档猜怎么连」：地址、header、curl、Python
 * 都在这里，还有一个试跑按钮，点一下就能确认这条链路是通的。
 */
function renderAutomation(profile, data) {
  const info = data.automation;
  if (!info) {
    return `<div class="section"><div class="faint">没拿到自动化信息（后端可能是旧版本）。</div></div>`;
  }

  const block = (label, text, kind) => `
    <div class="code-head">
      <span>${esc(label)}</span>
      <button class="btn ghost sm" data-act="copy-text" data-id="${kind}">复制</button>
    </div>
    <pre class="code-block">${esc(text)}</pre>`;

  return `
    <div class="section">
      <h3>外部自动化</h3>
      <div class="note-box warn">没有 CDP 链接。${esc(info.cdpReason)}</div>
      <div class="faint" style="font-size:12px;margin-top:8px;line-height:1.6">
        可用的方式是 HTTP 脚本执行：把采集脚本 POST 给这个环境，由它自己启动、执行、回传 JSON。
        ${info.running ? '环境运行中，调用会直接复用当前窗口。' : '环境未运行，调用时会自动启动（首次约 5–7 秒）。'}
      </div>
    </div>
    <div class="section">
      <h3>端点</h3>
      <div class="mono" style="font-size:12px;word-break:break-all">POST ${esc(info.exec.url)}</div>
      <div class="faint" style="font-size:11px;margin-top:4px">authorization: Bearer &lt;token&gt;</div>
      ${block('curl', info.examples.curl, 'curl')}
    </div>
    <div class="section">
      <h3>Python</h3>
      ${block('requests', info.examples.python, 'python')}
    </div>
    <div class="section">
      <h3>脚本模式</h3>
      <ul class="issues">
        <li><b>page</b>：${esc(info.modes.page)}</li>
        <li><b>playwright</b>：${esc(info.modes.playwright)}</li>
      </ul>
      <button class="btn sm" data-act="try-script" ${state.busy.has('try-script') ? 'disabled' : ''}>
        ${state.busy.has('try-script') ? '执行中…' : '试跑（读当前页标题）'}
      </button>
      ${data.tryResult ? `<pre class="code-block" style="margin-top:8px">${esc(JSON.stringify(data.tryResult, null, 2))}</pre>` : ''}
    </div>`;
}

function renderCheck(profile, data) {
  if (data.loading) return `<div class="empty"><p>校验中…</p></div>`;
  const v = data.validate;
  if (!v) return `<div class="empty"><p>没有拿到校验结果</p></div>`;

  const issues = v.issues.length
    ? v.issues
        .map(
          (issue) => `
        <div class="issue">
          <span class="rule">${esc(issue.rule)}</span>
          <span>${esc(issue.message)}</span>
        </div>`,
        )
        .join('')
    : '<div class="note-box ok">所有一致性规则通过：系统与 UA、语言与时区、GPU 与系统、屏幕与 DPR 均自洽。</div>';

  // 身份健康：库里存的自检结果（启动时采的）。和下面的"运行时自检"不是一回事——
  // 那个是现在点一下测一次，这个是上次启动时的结论，关掉环境后依然可见。
  const health = profile.health;
  const healthHtml =
    health && Array.isArray(health.diff) && health.diff.length > 0
      ? `<div class="section">
          <h3>身份健康</h3>
          <div class="note-box bad">
            这个环境的身份和库里固化的预设对不上（${health.diff.length} 项）。
            常见于换过显示器、或更早版本创建的环境。
            不能局部修：改屏幕会让 mediaDevices / locale 等字段一起重抽（已验证），
            只能重建环境。
          </div>
          <ul class="issues">
            ${health.diff
              .map(
                (d) =>
                  `<li><b>${esc(d.key)}</b>：预期 ${esc(String(d.expected))}，实际 ${esc(String(d.actual))}</li>`,
              )
              .join('')}
          </ul>
          <div class="faint" style="font-size:11px;margin-top:6px">检查时间 ${relTime(health.checkedAt)}</div>
        </div>`
      : '';

  const selfcheck = data.selfcheck;
  const selfcheckHtml =
    profile.status === 'running'
      ? `<div class="section">
          <h3>运行时自检</h3>
          ${
            selfcheck
              ? selfcheck.ok
                ? '<div class="note-box ok">页面实测值与库内 preset 完全一致。</div>'
                : `<div class="note-box bad">发现 ${selfcheck.mismatches.length} 处偏差：</div>
                   ${explainMismatches(selfcheck.mismatches)}
                   <pre class="pre">${esc(JSON.stringify(selfcheck.mismatches, null, 1))}</pre>`
              : '<button class="btn" data-act="selfcheck">在运行中的实例里实测</button>'
          }
        </div>`
      : `<div class="section"><h3>运行时自检</h3>
          <div class="note-box">需要先启动这个环境，自检会在已打开的浏览器里采样，不重开窗口。</div></div>`;

  return `
    <div class="section">
      <h3>离线规则校验</h3>
      ${issues}
      <div class="faint" style="font-size:11px;margin-top:8px">校验时间 ${clock(v.checkedAt)} · 不启动浏览器</div>
    </div>
    ${healthHtml}
    ${selfcheckHtml}`;
}

/**
 * 偏差里有些不是"指纹坏了"，而是引擎能力边界（无 GPU 时拿不到 WebGL）。
 * 直接把原始 JSON 甩给用户，只会让人以为环境有问题。
 */
function explainMismatches(mismatches) {
  const notes = [];
  for (const m of mismatches || []) {
    if (m.key === 'webgl' && (m.actual == null || m.actual === 'null')) {
      notes.push('当前实例拿不到 WebGL（GPU 进程未启动，无头或无显卡环境常见）。指纹里的 GPU 值在这种环境下不会生效，有头启动才能验证。');
    }
    if (m.key === 'screen' && m.actual && m.actual.width) {
      notes.push(`窗口实际屏幕 ${m.actual.width}×${m.actual.height} 与库内记录不同，通常是宿主分辨率变化，不影响身份固化。`);
    }
  }
  return notes
    .map((text) => `<div class="note-box" style="margin-top:8px">${esc(text)}</div>`)
    .join('');
}

function renderHistory(profile, data) {
  if (data.loading) return `<div class="empty"><p>读取中…</p></div>`;
  if (!data.launches.length) return `<div class="empty"><p>还没有启动记录</p></div>`;
  const rows = data.launches
    .map((l) => {
      const failed = !!l.error;
      const dur = l.ended_at ? Math.max(0, Math.round((l.ended_at - l.started_at) / 1000)) : null;
      return `<div class="tl-item">
        <div class="tl-time">${clock(l.started_at)}</div>
        <div>
          <span class="chip ${failed ? 'bad' : 'ok'}">${failed ? '失败' : dur == null ? '运行中' : '正常退出'}</span>
          <span class="faint mono" style="margin-left:6px">pid ${l.pid ?? '—'}${dur != null ? ` · ${dur}s` : ''}</span>
          ${failed ? `<pre class="pre" style="margin:6px 0 0">${esc(l.error)}</pre>` : ''}
        </div>
      </div>`;
    })
    .join('');
  return `<div class="timeline">${rows}</div>`;
}

// ---------------------------------------------------------------- 交互

function toast(title, message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${message ? esc(message) : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

function setBusy(key, on) {
  if (on) state.busy.add(key);
  else state.busy.delete(key);
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  if (el.tagName === 'INPUT' && el.type === 'checkbox') {
    // checkbox 的 click 会先触发 change，这里只做拦截避免冒泡到行
    event.stopPropagation();
    return;
  }

  switch (act) {
    case 'view':
      state.view = id;
      state.drawer = null;
      render();
      if (id === 'audit' || id === 'tasks' || id === 'datasets' || id === 'automations') {
        await loadAll({ silent: true });
      }
      return;

    case 'reload':
      await loadAll();
      return;

    case 'filter-group':
      state.filter.groupId = id === '__ungrouped__' || !id ? null : id;
      state.filter.ungrouped = id === '__ungrouped__';
      state.selection.clear();
      await loadAll();
      return;

    case 'open':
      state.drawer = id;
      state.drawerTab = 'fingerprint';
      state.drawerFresh = true;
      state.drawerData = { validate: null, launches: [], selfcheck: null, loading: true };
      render();
      void refreshDrawer(id);
      return;

    case 'drawer-close':
      state.drawer = null;
      render();
      return;

    case 'drawer-tab':
      state.drawerTab = id;
      render();
      return;

    case 'copy-text': {
      const info = state.drawerData.automation;
      const text = info?.examples?.[id];
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制', id, 'ok');
      } catch {
        toast('复制失败', '浏览器不允许写剪贴板，手动选中代码块复制', 'bad');
      }
      return;
    }

    case 'try-script': {
      if (!state.drawer) return;
      setBusy('try-script', true);
      try {
        const res = await API.call(`/api/profiles/${state.drawer}/run-script`, {
          method: 'POST',
          body: {
            mode: 'page',
            script: '({ title: document.title, url: location.href })',
            screenshot: false,
          },
        });
        state.drawerData.tryResult = res.ok
          ? { ok: true, result: res.result, elapsedMs: res.elapsedMs }
          : { ok: false, error: res.error, elapsedMs: res.elapsedMs };
        if (!res.ok) toast('试跑失败', res.error || '', 'bad');
      } catch (error) {
        toast('试跑失败', error.message, 'bad');
      } finally {
        setBusy('try-script', false);
      }
      return;
    }

    case 'audit-toggle':
      if (state.expandedAudit.has(id)) state.expandedAudit.delete(id);
      else state.expandedAudit.add(id);
      render();
      return;

    case 'selfcheck':
      if (!state.drawer) return;
      setBusy('selfcheck', true);
      try {
        const result = await API.call(`/api/profiles/${state.drawer}/selfcheck`, { method: 'POST' });
        state.drawerData.selfcheck = result;
        render();
        toast(result.ok ? '自检通过' : '自检发现偏差', result.ok ? '页面实测与库内一致' : `${result.mismatches.length} 处不一致`, result.ok ? 'ok' : 'bad');
      } catch (error) {
        toast('自检失败', error.message, 'bad');
      } finally {
        setBusy('selfcheck', false);
      }
      return;

    case 'start':
    case 'stop': {
      setBusy(id, true);
      const target = state.profiles.find((p) => p.id === id);
      try {
        const res = await API.call(`/api/profiles/${id}/${act}`, { method: 'POST' });
        if (act === 'start' && target?.headless) {
          // 无头环境启动后屏幕上什么都不会出现。不说这一句，用户会以为没启动成功
          toast('已在无头模式启动', '这个环境不显示窗口，页面在后台跑（截图与自动化仍可用）', 'warn');
        } else if (act === 'start') {
          toast('已启动', `Firefox 窗口已打开 · ${res?.elapsedMs ?? '—'}ms`, 'ok');
        } else {
          toast('已关闭', '', 'ok');
        }
      } catch (error) {
        toast(act === 'start' ? '启动失败' : '关闭失败', error.message, 'bad');
      } finally {
        setBusy(id, false);
        await loadAll({ silent: true });
      }
      return;
    }

    case 'toggle-headless': {
      // 点开关本身不冒泡到行，但 input 的 click 需要显式拦一下，否则抽屉会重绘丢焦点
      const running = state.profiles.find((p) => p.id === id)?.status === 'running';
      try {
        await API.call(`/api/profiles/${id}`, {
          method: 'PATCH',
          body: { headless: !event.target.checked },
        });
        toast(
          event.target.checked ? '已改为显示窗口' : '已改为无头模式',
          running ? '当前实例不受影响，重新启动后生效' : '下次启动生效',
          'ok',
        );
      } catch (error) {
        toast('切换失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      // 抽屉里正看着这条环境的话，把抽屉数据也刷新一遍（否则开关状态是旧的）
      if (state.drawer === id) void refreshDrawer(id);
      return;
    }

    case 'delete': {
      const profile = state.profiles.find((p) => p.id === id);
      if (!(await confirmDialog('删除环境', `${profile?.name ?? id} 将从列表移除，配置文件与浏览器数据一并标记删除。`))) return;
      try {
        await API.call(`/api/profiles/${id}`, { method: 'DELETE' });
        toast('已删除', '', 'ok');
      } catch (error) {
        toast('删除失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      return;
    }

    case 'select-all': {
      if (state.selection.size === state.profiles.length) state.selection.clear();
      else state.profiles.forEach((p) => state.selection.add(p.id));
      render();
      return;
    }

    case 'clear-selection':
      state.selection.clear();
      render();
      return;

    case 'batch-start':
    case 'batch-stop':
    case 'batch-delete': {
      const ids = [...state.selection];
      const action = act.replace('batch-', '');
      if (action === 'delete') {
        if (!(await confirmDialog('批量删除', `将删除 ${ids.length} 个环境，正在运行的会被跳过并提示。`))) return;
      }
      await runBatch(action, ids);
      return;
    }

    case 'new-task':
      openTaskModal();
      return;
    case 'new-automation':
      // 任务列表平时只在「任务」页加载，建规则时按需补一次
      if (state.tasks.length === 0) {
        try {
          state.tasks = await API.call('/api/tasks');
        } catch {
          /* 没有任务时表单里会提示先去建一条 */
        }
      }
      openAutomationModal();
      return;

    case 'toggle-auto': {
      const wasOpen = state.expandedAutomation === id;
      state.expandedAutomation = wasOpen ? null : id;
      render();
      if (!wasOpen && !state.automationRuns[id]) void loadAutomationRuns(id);
      return;
    }

    case 'run-auto': {
      setBusy(`auto:${id}`, true);
      try {
        const outcome = await API.call(`/api/automations/${id}/run`, { method: 'POST' });
        const kind = outcome.status === 'ok' ? 'ok' : outcome.status === 'failed' ? 'bad' : 'warn';
        toast(
          outcome.status === 'ok' ? '已触发' : outcome.status === 'skipped' ? '本次跳过' : '触发失败',
          outcome.detail || '',
          kind,
        );
        state.expandedAutomation = id;
        delete state.automationRuns[id];
        await loadAutomationRuns(id);
      } catch (error) {
        toast('触发失败', error.message, 'bad');
      } finally {
        setBusy(`auto:${id}`, false);
        await loadAll({ silent: true });
      }
      return;
    }

    case 'delete-auto': {
      const rule = state.automations.find((a) => a.id === id);
      if (!(await confirmDialog('删除规则', `${rule?.name ?? id} 将停止调度；已经跑过的触发历史一并删除。`))) return;
      try {
        await API.call(`/api/automations/${id}`, { method: 'DELETE' });
        toast('已删除', '', 'ok');
      } catch (error) {
        toast('删除失败', error.message, 'bad');
      }
      if (state.expandedAutomation === id) state.expandedAutomation = null;
      await loadAll({ silent: true });
      return;
    }

    case 'session-check':
      openSessionModal();
      return;

    case 'toggle-task':
      state.expandedTask = state.expandedTask === id ? null : id;
      render();
      return;

    case 'run-task':
      try {
        await API.call(`/api/tasks/${id}/run`, { method: 'POST' });
        state.expandedTask = id;
        toast('任务已启动', '完成后结果会写回这条记录', 'ok');
      } catch (error) {
        toast('启动失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      return;

    case 'cancel-task':
      try {
        await API.call(`/api/tasks/${id}/cancel`, { method: 'POST' });
        toast('已请求取消', '正在收尾，已完成的目标不受影响', 'warn');
      } catch (error) {
        toast('取消失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      return;

    case 'delete-task': {
      const ok = await confirmDialog('删除任务', '只删除任务记录。已经打开的环境不会被关闭。');
      if (!ok) return;
      try {
        await API.call(`/api/tasks/${id}`, { method: 'DELETE' });
      } catch (error) {
        toast('删除失败', error.message, 'bad');
      }
      if (state.expandedTask === id) state.expandedTask = null;
      await loadAll({ silent: true });
      return;
    }

    case 'select-dataset': {
      const hit = state.datasets.find((d) => d.id === id);
      if (!hit) return;
      state.dataset = hit;
      state.datasetQuery.offset = 0;
      state.datasetQuery.q = '';
      await loadDatasetRows();
      render();
      return;
    }

    case 'dataset-page': {
      const { offset, limit } = state.datasetQuery;
      const total = state.datasetRows.total;
      const next = id === 'prev' ? Math.max(0, offset - limit) : Math.min(offset + limit, Math.max(0, total - 1));
      if (next === offset) return;
      state.datasetQuery.offset = next;
      await loadDatasetRows();
      render();
      return;
    }

    case 'export-dataset':
      await exportDataset(id === 'jsonl' ? 'jsonl' : 'csv');
      return;

    case 'delete-dataset': {
      const hit = state.datasets.find((d) => d.id === id);
      if (!hit) return;
      const ok = await confirmDialog(
        '删除数据集',
        `将删除「${hit.name}」及其 ${hit.rowCount} 行数据，且不可恢复。任务记录不受影响。`,
      );
      if (!ok) return;
      try {
        await API.call(`/api/datasets/${id}`, { method: 'DELETE' });
        state.dataset = null;
        state.datasetQuery = { q: '', offset: 0, limit: 50 };
        toast('已删除', `数据集「${hit.name}」及其数据已清理`, 'ok');
      } catch (error) {
        toast('删除失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      return;
    }

    case 'new-profile':
      openProfileModal();
      return;
    case 'new-proxy':
      openProxyModal();
      return;

    case 'new-group':
      openGroupModal();
      return;

    case 'check-proxy': {
      setBusy(`proxy:${id}`, true);
      render();
      try {
        const result = await API.call(`/api/proxies/${id}/check`, { method: 'POST' });
        toast(result.ok ? '代理可用' : '代理不可用', result.ok ? `${result.country} · ${result.latencyMs}ms` : result.error, result.ok ? 'ok' : 'bad');
      } catch (error) {
        toast('预检失败', error.message, 'bad');
      } finally {
        setBusy(`proxy:${id}`, false);
        await loadAll({ silent: true });
      }
      return;
    }

    case 'check-all': {
      setBusy('check-all', true);
      render();
      try {
        const result = await API.call('/api/proxies/check', { method: 'POST' });
        const bad = result.results.filter((r) => !r.ok).length;
        toast('全部预检完成', `${result.checked} 条，其中 ${bad} 条不可用`, bad ? 'bad' : 'ok');
      } catch (error) {
        toast('批量预检失败', error.message, 'bad');
      } finally {
        setBusy('check-all', false);
        await loadAll({ silent: true });
      }
      return;
    }

    case 'delete-proxy': {
      const proxy = state.proxies.find((p) => p.id === id);
      if (!(await confirmDialog('删除代理', `${proxy?.name ?? id}：被环境引用的代理无法删除，需要先解除绑定。`))) return;
      try {
        await API.call(`/api/proxies/${id}`, { method: 'DELETE' });
        toast('已删除', '', 'ok');
      } catch (error) {
        toast('删除失败', error.message, 'bad');
      }
      await loadAll({ silent: true });
      return;
    }
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target;

  if (el.matches('[data-act="toggle-select"]')) {
    event.stopPropagation();
    if (el.checked) state.selection.add(el.dataset.id);
    else state.selection.delete(el.dataset.id);
    render();
    return;
  }

  if (el.matches('[data-act="select-all"]')) {
    if (el.checked) state.profiles.forEach((p) => state.selection.add(p.id));
    else state.selection.clear();
    render();
    return;
  }

  if (el.matches('[data-act="toggle-auto-enabled"]')) {
    event.stopPropagation();
    const id = el.dataset.id;
    try {
      await API.call(`/api/automations/${id}`, { method: 'PATCH', body: { enabled: el.checked } });
      toast(el.checked ? '规则已启用' : '规则已停用', el.checked ? '' : '不会再自动触发，历史保留', 'ok');
    } catch (error) {
      toast('切换失败', error.message, 'bad');
    }
    await loadAll({ silent: true });
    return;
  }

  if (el.id === 'status-filter') {
    state.filter.status = el.value;
    state.selection.clear();
    await loadAll({ silent: true });
    return;
  }

  if (el.matches('[data-act="batch-move"]')) {
    const groupId = el.value === '__none__' ? null : el.value;
    if (!groupId && el.value !== '__none__') return;
    await runBatch('move', [...state.selection], groupId);
  }
});

let searchTimer;
document.addEventListener('input', (event) => {
  if (event.target.id === 'dataset-q') {
    state.datasetQuery.q = event.target.value.trim();
    state.datasetQuery.offset = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      await loadDatasetRows();
      render();
    }, 220);
    return;
  }
  if (event.target.id !== 'q') return;
  state.filter.q = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      await loadProfiles();
      render();
    } catch (error) {
      toast('搜索失败', error.message, 'bad');
    }
  }, 220);
});

async function runBatch(action, ids, groupId) {
  if (!ids.length) return;
  try {
    const result = await API.call('/api/profiles/batch', { method: 'POST', body: { action, ids, groupId } });
    if (result.failed.length) {
      toast(
        `${action} 部分失败`,
        `${result.succeeded.length}/${result.total} 成功；首个错误：${result.failed[0].name || result.failed[0].id} — ${result.failed[0].error}`,
        'bad',
      );
    } else {
      toast('批量完成', `${result.succeeded.length} 个环境已${actionLabel(action)}`, 'ok');
    }
    if (action === 'delete' || action === 'move') state.selection.clear();
  } catch (error) {
    toast('批量操作失败', error.message, 'bad');
  }
  await loadAll({ silent: true });
}

function actionLabel(action) {
  return { start: '启动', stop: '关闭', delete: '删除', move: '移动' }[action] ?? action;
}

// ---------------------------------------------------------------- 弹窗

function openModal(html, { wide = false } = {}) {
  // 任务编辑器一行要放「序号 + 类型 + 脚本 + 超时 + 删除」，520px 装不下，
  // 会被裁掉右侧的删除按钮（实测）。这类弹窗显式要宽版。
  $('#modal-root').innerHTML = `<div class="modal-mask" data-act="modal-close-bg"><div class="modal${wide ? ' wide' : ''}">${html}</div></div>`;
  const mask = $('#modal-root .modal-mask');
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeModal();
  });
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if ($('#modal-root').innerHTML) closeModal();
    else if (state.drawer) {
      state.drawer = null;
      render();
    }
  }
});

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
      <div class="modal-foot">
        <button class="btn" id="cf-no">取消</button>
        <button class="btn danger" id="cf-yes">确认</button>
      </div>`);
    $('#cf-no').onclick = () => {
      closeModal();
      resolve(false);
    };
    $('#cf-yes').onclick = () => {
      closeModal();
      resolve(true);
    };
  });
}

function openProfileModal() {
  const proxyOptions = state.proxies
    .map(
      (p) =>
        `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(
          p.lastCheckCountry || p.expectedCountry || '未预检',
        )}</option>`,
    )
    .join('');

  openModal(`
    <form id="profile-form">
      <div class="modal-head">
        <h2>新建环境</h2>
        <p>指纹在创建时一次性固化，之后每次启动完全复用——这是产品能力的核心约束。</p>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>环境名称</label>
          <input class="control" name="name" required maxlength="64" placeholder="例如：店铺A · 主账号" autofocus />
        </div>
        <div class="field-row">
          <div class="field">
            <label>操作系统身份</label>
            <select class="control" name="os">
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
          </div>
          <div class="field">
            <label>出口国家</label>
            <input class="control" name="country" maxlength="2" placeholder="留空则按代理推断（如 US）" />
          </div>
        </div>
        <div class="field">
          <label>绑定代理</label>
          <select class="control" name="proxyId">
            <option value="">不绑定（直连）</option>
            ${proxyOptions}
          </select>
          <span class="hint">绑代理时，时区与语言会按代理实测出口国家推导，避免"IP 在德国、时区在纽约"。</span>
        </div>
        <div class="field">
          <label>启动页</label>
          <input class="control" name="startupUrl" placeholder="https://example.com（可留空）" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>分组</label>
            <select class="control" name="groupId">
              <option value="">未分组</option>
              ${state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="justify-content:flex-end">
            <label class="switch"><input type="checkbox" name="headless" /> 无头模式</label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="pf-cancel">取消</button>
        <button type="submit" class="btn primary" id="pf-submit">创建</button>
      </div>
    </form>`);

  $('#pf-cancel').onclick = closeModal;
  $('#profile-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = $('#pf-submit');
    button.disabled = true;
    button.textContent = '生成身份中…';
    try {
      const created = await API.call('/api/profiles', {
        method: 'POST',
        body: {
          name: String(form.get('name') || '').trim(),
          os: form.get('os') || undefined,
          country: String(form.get('country') || '').trim().toUpperCase() || undefined,
          proxyId: form.get('proxyId') || null,
          groupId: form.get('groupId') || null,
          startupUrl: String(form.get('startupUrl') || '').trim() || null,
          headless: form.get('headless') === 'on',
        },
      });
      closeModal();
      toast('环境已创建', `${created.name} · ${created.preset.locale} · ${created.preset.timezone}`, 'ok');
      await loadAll({ silent: true });
    } catch (error) {
      button.disabled = false;
      button.textContent = '创建';
      const detail = error.payload?.issues?.map((i) => `[${i.rule}] ${i.message}`).join('\n');
      toast('创建失败', detail || error.message, 'bad');
    }
  };
}

function openProxyModal() {
  openModal(`
    <form id="proxy-form">
      <div class="modal-head">
        <h2>新建代理</h2>
        <p>保存后可以立刻预检；密码用本机密钥加密存储，不会进日志。</p>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>名称</label>
          <input class="control" name="name" required maxlength="64" placeholder="例如：HK-01" autofocus />
        </div>
        <div class="field-row">
          <div class="field">
            <label>协议</label>
            <select class="control" name="protocol">
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5（免认证）</option>
            </select>
            <span class="hint">Firefox 内核不支持带账号密码的 SOCKS5，需要认证请走 HTTP/HTTPS。</span>
          </div>
          <div class="field">
            <label>申报国家</label>
            <input class="control" name="country" maxlength="2" placeholder="如 HK（可留空）" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>主机</label>
            <input class="control" name="host" required placeholder="127.0.0.1" />
          </div>
          <div class="field">
            <label>端口</label>
            <input class="control" name="port" required type="number" min="1" max="65535" value="7890" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>用户名</label>
            <input class="control" name="username" placeholder="可留空" />
          </div>
          <div class="field">
            <label>密码</label>
            <input class="control" name="password" type="password" placeholder="可留空" />
          </div>
        </div>
        <label class="switch"><input type="checkbox" name="check" checked /> 保存后立即预检（约 1–3 秒）</label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="xf-cancel">取消</button>
        <button type="submit" class="btn primary" id="xf-submit">保存</button>
      </div>
    </form>`);

  $('#xf-cancel').onclick = closeModal;
  $('#proxy-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = $('#xf-submit');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      const body = {
        name: String(form.get('name') || '').trim(),
        protocol: form.get('protocol'),
        host: String(form.get('host') || '').trim(),
        port: Number(form.get('port')),
        username: String(form.get('username') || '').trim() || undefined,
        password: String(form.get('password') || '') || undefined,
        country: String(form.get('country') || '').trim().toUpperCase() || undefined,
        check: form.get('check') === 'on',
      };
      const saved = await API.call('/api/proxies', { method: 'POST', body });
      closeModal();
      const check = saved.check;
      toast(
        '代理已保存',
        check ? (check.ok ? `实测 ${check.country} · ${check.latencyMs}ms` : `预检失败：${check.error}`) : '',
        check && !check.ok ? 'bad' : 'ok',
      );
      await loadAll({ silent: true });
    } catch (error) {
      button.disabled = false;
      button.textContent = '保存';
      toast('保存失败', error.message, 'bad');
    }
  };
}

function openGroupModal() {
  openModal(`
    <form id="group-form">
      <div class="modal-head"><h2>新建分组</h2><p>分组只影响列表组织，不改变任何指纹字段。</p></div>
      <div class="modal-body">
        <div class="field">
          <label>分组名称</label>
          <input class="control" name="name" required maxlength="32" placeholder="例如：店铺A" autofocus />
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="gf-cancel">取消</button>
        <button type="submit" class="btn primary">创建</button>
      </div>
    </form>`);
  $('#gf-cancel').onclick = closeModal;
  $('#group-form').onsubmit = async (event) => {
    event.preventDefault();
    const name = String(new FormData(event.target).get('name') || '').trim();
    try {
      await API.call('/api/groups', { method: 'POST', body: { name } });
      closeModal();
      toast('分组已创建', name, 'ok');
      await loadAll({ silent: true });
    } catch (error) {
      toast('创建失败', error.message, 'bad');
    }
  };
}


// ---------------------------------------------------------------- 任务

const TASK_STATUS = {
  queued: { label: '未运行', cls: '' },
  running: { label: '执行中', cls: 'warn' },
  succeeded: { label: '已完成', cls: 'ok' },
  failed: { label: '有失败', cls: 'bad' },
  cancelled: { label: '已取消', cls: '' },
};

const STEP_TYPES = [
  { value: 'start', label: '启动环境' },
  { value: 'goto', label: '打开网址' },
  { value: 'wait', label: '等待' },
  { value: 'eval', label: '执行脚本' },
  { value: 'collect', label: '采集落表' },
  { value: 'screenshot', label: '截图' },
  { value: 'stop', label: '关闭环境' },
];

function stepLabel(type) {
  return STEP_TYPES.find((s) => s.value === type)?.label ?? type;
}

function renderTasks() {
  if (state.loading && state.tasks.length === 0) {
    return `<div class="empty"><p>加载中…</p></div>`;
  }
  if (state.tasks.length === 0) {
    return `<div class="empty">
      <h3>还没有任务</h3>
      <p>任务是一串可重放的动作：启动环境 → 打开页面 → 取数或截图 → 关闭。<br />
      对一批环境跑同一串动作，每一步的结果都留证，失败能定位到具体第几步。</p>
      <button class="btn primary" data-act="new-task">新建任务</button>
    </div>`;
  }

  const running = state.tasks.filter((t) => t.status === 'running').length;
  const done = state.tasks.filter((t) => t.status === 'succeeded' || t.status === 'failed');
  const okRate = done.length
    ? Math.round((done.filter((t) => t.status === 'succeeded').length / done.length) * 100)
    : null;

  return `
  <div class="stat-row">
    <div class="stat"><b>${state.tasks.length}</b><span>任务总数</span></div>
    <div class="stat"><b style="color:${running ? '#e8c96a' : 'inherit'}">${running}</b><span>执行中</span></div>
    <div class="stat"><b>${okRate === null ? '—' : okRate + '%'}</b><span>已完成成功率</span></div>
  </div>
  <div class="task-list">${state.tasks.map(renderTaskCard).join('')}</div>`;
}

function renderTaskCard(task) {
  const meta = TASK_STATUS[task.status] ?? { label: task.status, cls: '' };
  const open = state.expandedTask === task.id;
  const targetText = task.target.groupId
    ? `分组 · ${esc(groupName(task.target.groupId))}`
    : `${task.target.profileIds.length} 个环境`;
  const stepFlow = task.steps.map((s) => stepLabel(s.type)).join(' → ');
  const elapsed = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : null;

  return `
  <div class="task-card ${open ? 'open' : ''}">
    <div class="task-head" data-act="toggle-task" data-id="${esc(task.id)}">
      <span class="status-dot ${task.status === 'running' ? 'busy' : task.status === 'succeeded' ? 'on' : task.status === 'failed' ? 'err' : ''}"></span>
      <div class="task-title">
        <b>${esc(task.name)}</b>
        <div class="task-meta">${targetText} · ${esc(stepFlow)}${task.concurrency > 1 ? ` · 并发 ${task.concurrency}` : ''}</div>
      </div>
      <span class="chip ${meta.cls}">${meta.label}</span>
      <span class="task-time">${elapsed ? formatDuration(elapsed) : relTime(task.createdAt)}</span>
      <div class="row-actions">
        ${
          task.status === 'running'
            ? `<button class="btn tiny" data-act="cancel-task" data-id="${esc(task.id)}">取消</button>`
            : `<button class="btn tiny" data-act="run-task" data-id="${esc(task.id)}">${task.status === 'queued' ? '运行' : '重跑'}</button>`
        }
        <button class="btn tiny" data-act="delete-task" data-id="${esc(task.id)}">删除</button>
      </div>
    </div>
    ${open ? renderTaskResult(task) : ''}
  </div>`;
}

function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name ?? '未知分组';
}

function renderTaskResult(task) {
  if (task.status === 'running' || task.status === 'queued') {
    return `<div class="task-detail"><p class="dim">执行中，结果会在完成时一次性写入。刷新页面不会中断任务。</p></div>`;
  }
  if (!task.result) {
    return `<div class="task-detail"><p class="dim">${task.error ? esc(task.error) : '尚未执行'}</p></div>`;
  }

  const { runs, summary } = task.result;
  const runsHtml = runs
    .map(
      (run) => `
    <div class="run">
      <div class="run-head">
        <span class="run-dot ${run.status}"></span>
        <b>${esc(run.profileName)}</b>
        <span class="dim">${formatDuration(run.elapsedMs)}</span>
        ${run.screenshots.length ? `<span class="dim">${run.screenshots.length} 张截图</span>` : ''}
        ${run.error ? `<span class="run-err">${esc(run.error)}</span>` : ''}
      </div>
      <ol class="steps">
        ${run.steps
          .map(
            (s) => `<li class="step ${s.status}">
              <span class="step-type">${esc(stepLabel(s.type))}</span>
              <span class="step-out">${
                s.status === 'failed'
                  ? esc(s.error || '失败')
                  : esc(s.collect ? describeCollect(s.collect, s.note) : s.note || previewValue(s.output) || '')
              }</span>
              <span class="step-ms">${s.elapsedMs}ms</span>
            </li>`,
          )
          .join('')}
      </ol>
      ${
        run.screenshots.length
          ? `<div class="shots">${run.screenshots
              .map(
                (p) =>
                  `<a class="shot" href="/files/${esc(p)}?t=${encodeURIComponent(token)}" target="_blank" rel="noreferrer">${esc(
                    p.split('/').pop(),
                  )}</a>`,
              )
              .join('')}</div>
             <div class="shot-previews">${run.screenshots
               .map(
                 (p) =>
                   `<img class="shot-thumb" loading="lazy" alt="${esc(p.split('/').pop() ?? '')}" src="/files/${esc(p)}?t=${encodeURIComponent(token)}" />`,
               )
               .join('')}</div>`
          : ''
      }
      ${
        Object.keys(run.vars).length
          ? `<div class="vars">${Object.entries(run.vars)
              .map(([k, v]) => `<span class="var"><b>${esc(k)}</b>${esc(previewValue(v))}</span>`)
              .join('')}</div>`
          : ''
      }
    </div>`,
    )
    .join('');

  return `<div class="task-detail">
    <div class="summary-line">
      共 ${summary.total} 个目标 ·
      <span style="color:var(--ok)">成功 ${summary.succeeded}</span>
      ${summary.failed ? ` · <span style="color:var(--bad)">失败 ${summary.failed}</span>` : ''}
      ${summary.skipped ? ` · 跳过 ${summary.skipped}` : ''}
    </div>
    ${runsHtml}
  </div>`;
}

/** 采集回执：这是「采集真的发生了」的唯一证据，不能让用户去数据页里猜 */
function describeCollect(receipt, note) {
  const parts = [`写入「${receipt.dataset}」· 新增 ${receipt.inserted} / 更新 ${receipt.updated}`];
  if (receipt.skipped) parts.push(`跳过 ${receipt.skipped}（判重字段为空）`);
  if (note) parts.push(note);
  return parts.join(' · ');
}

function previewValue(value) {  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

// ---------- 新建任务

/**
 * 会话检测。
 *
 * 不做「探针列表 + 定时任务」那套完整管理：MVP2 阶段真正高频的是
 * 「我现在想看一眼这几十个环境还活着吗」，所以入口就是一次检测。
 * 检测会顺手存成探针，将来接定时巡检时有东西可复用。
 */
function openSessionModal() {
  const preselect = [...state.selection];
  openModal(`
    <form id="session-form">
      <div class="modal-head">
        <h2>检测登录态</h2>
        <p>在环境里打开一个「只有登录后才可见」的页面，看结果。打不开的环境记为「未知」，不会被当成掉登录。</p>
      </div>
      <div class="modal-body">
        <div class="field-row">
          <div class="field">
            <label>检测范围</label>
            <select class="control" name="scope">
              <option value="selected"${preselect.length ? ' selected' : ''}>已选 ${preselect.length} 个环境</option>
              <option value="group">按分组</option>
              <option value="all"${preselect.length ? '' : ' selected'}>全部环境（${state.profiles.length}）</option>
            </select>
          </div>
          <div class="field">
            <label>分组</label>
            <select class="control" name="groupId">
              ${state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('') || '<option value="">（暂无分组）</option>'}
            </select>
          </div>
        </div>
        <div class="field">
          <label>探针地址</label>
          <input class="control" name="url" required placeholder="https://后台地址/orders" autofocus />
          <p class="hint">要填「登录后才能打开」的那个页面。未登录会被重定向的页面最准。</p>
        </div>
        <div class="field-row">
          <div class="field">
            <label>判定方式</label>
            <select class="control" name="ruleType">
              <option value="url">落地地址不含登录特征（最稳）</option>
              <option value="selector">页面上有这个元素</option>
              <option value="script">自定义脚本返回 true</option>
            </select>
          </div>
          <div class="field">
            <label id="rule-value-label">正则，匹配到即视为未登录</label>
            <input class="control mono" name="ruleValue" required placeholder="/login" value="/login" />
          </div>
        </div>
        <p class="hint" id="rule-hint">
          选了「元素」就填 CSS 选择器（如 <code>#user-avatar</code>）；选了「脚本」就填一段返回 boolean 的代码。
        </p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" data-act="modal-close">取消</button>
        <button type="submit" class="btn primary">开始检测</button>
      </div>
    </form>`);

  const form = $('#session-form');
  const typeSel = form.querySelector('[name="ruleType"]');
  const valueInput = form.querySelector('[name="ruleValue"]');
  const label = $('#rule-value-label');

  const presets = {
    url: { label: '正则，匹配到即视为未登录', placeholder: '/login', value: '/login' },
    selector: { label: 'CSS 选择器', placeholder: '#orders .user-avatar', value: '' },
    script: { label: '返回 boolean 的脚本', placeholder: "!!document.querySelector('#orders')", value: '' },
  };
  typeSel.onchange = () => {
    const preset = presets[typeSel.value];
    label.textContent = preset.label;
    valueInput.placeholder = preset.placeholder;
    // 只在空着或还是上一个预设值时替换，避免把用户已经写好的内容冲掉
    if (!valueInput.value || Object.values(presets).some((p) => p.value === valueInput.value)) {
      valueInput.value = preset.value;
    }
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const type = String(data.get('ruleType'));
    const raw = String(data.get('ruleValue') ?? '').trim();
    if (!raw) return toast('还差一项', '判定值不能为空', 'bad');

    const rule =
      type === 'url'
        ? { type: 'url', mustNotMatch: raw }
        : type === 'selector'
          ? { type: 'selector', selector: raw }
          : { type: 'script', script: raw };

    const scope = String(data.get('scope'));
    const body = { url: String(data.get('url')), rule, saveProbe: true };
    if (scope === 'selected') {
      if (!preselect.length) return toast('没选环境', '先在列表里勾选环境，或把范围改成全部', 'bad');
      body.profileIds = preselect;
    } else if (scope === 'group') {
      body.groupId = String(data.get('groupId') ?? '') || null;
      if (!body.groupId) return toast('没有分组', '先建一个分组', 'bad');
    }

    closeModal();
    try {
      const job = await API.call('/api/session/check', { method: 'POST', body });
      toast('已开始检测', `${job.total} 个环境，预计 ${Math.ceil((job.total / 3) * 8)} 秒`, '');
      void pollSessionJob(job.id);
    } catch (error) {
      toast('发起失败', error.message, 'bad');
    }
  };
}

async function pollSessionJob(id) {
  for (let i = 0; i < 600; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    let job;
    try {
      job = await API.call(`/api/session/jobs/${id}`);
    } catch {
      return;
    }
    if (job.status === 'running') continue;
    const { alive, expired, unknown, skipped } = job.summary;
    const parts = [`有效 ${alive}`];
    if (expired) parts.push(`失效 ${expired}`);
    if (unknown) parts.push(`未知 ${unknown}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    toast(
      expired ? '检测完成：有环境需要重新登录' : '检测完成',
      `${parts.join(' · ')}${job.error ? ` · ${job.error}` : ''}`,
      expired ? 'bad' : 'ok',
    );
    await loadAll({ silent: true });
    return;
  }
}

function openTaskModal() {
  const preselect = [...state.selection];
  const draft = {
    steps: [
      { type: 'start' },
      { type: 'goto', url: 'https://example.com' },
      { type: 'screenshot' },
      { type: 'stop' },
    ],
  };

  openModal(
    `
    <form id="task-form">
      <div class="modal-head">
        <h2>新建任务</h2>
        <p>同一串动作对多个环境执行。每个目标独立跑完整条链，一条失败不影响其他。</p>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>任务名称</label>
          <input class="control" name="name" required maxlength="64" placeholder="例如：每日巡检 · 首页截图" autofocus />
        </div>
        <div class="field-row">
          <div class="field">
            <label>执行范围</label>
            <select class="control" name="scope">
              <option value="selected"${preselect.length ? ' selected' : ''}>已选 ${preselect.length} 个环境</option>
              <option value="group">按分组</option>
              <option value="all"${preselect.length ? '' : ' selected'}>全部环境（${state.profiles.length}）</option>
            </select>
          </div>
          <div class="field">
            <label>按分组时</label>
            <select class="control" name="groupId">
              ${state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('') || '<option value="">（暂无分组）</option>'}
            </select>
          </div>
          <div class="field" style="max-width:120px">
            <label>并发</label>
            <select class="control" name="concurrency">
              <option value="1">1（最稳）</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>
        </div>

        <div class="steps-head">
          <label>步骤</label>
          <div class="preset-row">
            <button type="button" class="btn tiny" data-preset="shot">打开并截图</button>
            <button type="button" class="btn tiny" data-preset="title">取标题</button>
            <button type="button" class="btn tiny" data-preset="startonly">只启动</button>
          </div>
        </div>
        <div id="step-list" class="step-list"></div>
        <button type="button" class="btn tiny add-step" id="add-step">+ 添加步骤</button>
        <p class="hint" style="margin-top:8px">
          网址与脚本里可以用 <code>{{profile.name}}</code>、<code>{{profile.id}}</code> 占位；
          eval 步骤若填了「存入变量」，后续步骤可用 <code>{{vars.变量名}}</code> 引用。
        </p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="task-cancel">取消</button>
        <button type="button" class="btn" id="task-save">仅保存</button>
        <button type="submit" class="btn primary" id="task-run">保存并运行</button>
      </div>
    </form>`,
    { wide: true },
  );

  const list = $('#step-list');

  function drawSteps() {
    list.innerHTML = draft.steps
      .map(
        (step, i) => `
      <div class="step-edit" data-i="${i}">
        <span class="step-no">${i + 1}</span>
        <select class="control step-kind" data-role="type">
          ${STEP_TYPES.map(
            (t) => `<option value="${t.value}"${t.value === step.type ? ' selected' : ''}>${t.label}</option>`,
          ).join('')}
        </select>
        <div class="step-fields">${stepFields(step)}</div>
        <button type="button" class="btn tiny ghost" data-role="del" title="删除这一步">×</button>
      </div>`,
      )
      .join('');
  }

  function syncFromDom() {
    list.querySelectorAll('.step-edit').forEach((row) => {
      const i = Number(row.dataset.i);
      const type = row.querySelector('[data-role="type"]').value;
      const next = { type };
      row.querySelectorAll('[data-field]').forEach((input) => {
        const key = input.dataset.field;
        if (input.type === 'checkbox') next[key] = input.checked;
        else if (input.type === 'number') next[key] = Number(input.value);
        else if (input.value !== '') next[key] = input.value;
        else if (key === 'fullPage') next[key] = false;
      });
      // 判重字段在界面上是一行逗号分隔的文本，提交时还原成数组
      if (type === 'collect') {
        const raw = String(next.dedupeBy ?? '').trim();
        if (raw) next.dedupeBy = raw.split(',').map((s) => s.trim()).filter(Boolean);
        else delete next.dedupeBy;
        if (!Number.isFinite(next.expectMinRows) || next.expectMinRows <= 0) delete next.expectMinRows;
      }
      draft.steps[i] = next;
    });
  }

  list.addEventListener('change', (event) => {
    const role = event.target.dataset.role;
    if (role !== 'type') return;
    syncFromDom();
    const row = event.target.closest('.step-edit');
    const i = Number(row.dataset.i);
    // 换类型时给一份合理的默认值，避免用户面对一个空表单
    draft.steps[i] = defaultStep(event.target.value);
    drawSteps();
    // 换完之后把焦点留在这一行，连续调步骤不用来回点
    list.querySelector(`.step-edit[data-i="${i}"] [data-role="type"]`)?.focus();
  });

  list.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-role="del"]');
    if (!btn) return;
    syncFromDom();
    const i = Number(btn.closest('.step-edit').dataset.i);
    draft.steps.splice(i, 1);
    drawSteps();
  });

  $('#add-step').onclick = () => {
    syncFromDom();
    if (draft.steps.length >= 20) return toast('步骤太多', '单条任务最多 20 步', 'bad');
    draft.steps.push({ type: 'wait', ms: 1000 });
    drawSteps();
  };

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      draft.steps = presetSteps(btn.dataset.preset);
      drawSteps();
    };
  });

  const submit = async (runNow) => {
    syncFromDom();
    const form = new FormData($('#task-form'));
    const scope = form.get('scope');
    const profileIds =
      scope === 'all'
        ? state.profiles.map((p) => p.id)
        : scope === 'selected'
          ? preselect
          : [];
    const groupId = scope === 'group' ? form.get('groupId') || null : null;

    if (!profileIds.length && !groupId) {
      return toast('没有目标', '请先勾选环境，或选择按分组执行', 'bad');
    }
    if (draft.steps.length === 0) return toast('没有步骤', '至少加一个步骤', 'bad');

    const button = runNow ? $('#task-run') : $('#task-save');
    button.disabled = true;
    try {
      await API.call('/api/tasks', {
        method: 'POST',
        body: {
          name: String(form.get('name') || '').trim() || '未命名任务',
          target: { profileIds, groupId },
          steps: draft.steps,
          concurrency: Number(form.get('concurrency') || 1),
          runNow,
        },
      });
      closeModal();
      toast(runNow ? '任务已启动' : '任务已保存', runNow ? '进度可在此页查看' : '随时可以点运行', 'ok');
      await loadAll({ silent: true });
    } catch (error) {
      button.disabled = false;
      const detail = error.payload?.issues?.map((i) => i.message).join('；');
      toast('保存失败', detail || error.message, 'bad');
    }
  };

  // 「按分组时」只有在执行范围选了按分组时才有意义，否则一律置灰，
  // 避免用户以为它也在生效
  const scopeSel = $('#task-form select[name="scope"]');
  const groupSel = $('#task-form select[name="groupId"]');
  const syncScope = () => {
    const isGroup = scopeSel.value === 'group';
    groupSel.disabled = !isGroup;
    groupSel.style.opacity = isGroup ? '' : '0.45';
  };
  scopeSel.addEventListener('change', syncScope);
  syncScope();

  $('#task-cancel').onclick = closeModal;
  $('#task-save').onclick = () => submit(false);
  $('#task-form').onsubmit = (event) => {
    event.preventDefault();
    submit(true);
  };

  drawSteps();
}

function defaultStep(type) {
  switch (type) {
    case 'goto':
      return { type: 'goto', url: 'https://example.com' };
    case 'wait':
      return { type: 'wait', ms: 1000 };
    case 'eval':
      return { type: 'eval', script: 'document.title' };
    case 'collect':
      return {
        type: 'collect',
        dataset: '',
        mode: 'upsert',
        script: "Array.from(document.querySelectorAll('tr')).map(function (el) {\n  return { name: el.textContent.trim() };\n})",
      };
    case 'screenshot':
      return { type: 'screenshot', fullPage: false };
    default:
      return { type };
  }
}

function presetSteps(name) {
  if (name === 'startonly') return [{ type: 'start' }];
  if (name === 'title') {
    return [
      { type: 'start' },
      { type: 'goto', url: 'https://example.com' },
      { type: 'eval', script: 'document.title', saveAs: 'title' },
      { type: 'stop' },
    ];
  }
  return [
    { type: 'start' },
    { type: 'goto', url: 'https://example.com' },
    { type: 'wait', ms: 1200 },
    { type: 'screenshot', fullPage: false },
    { type: 'stop' },
  ];
}

function stepFields(step) {
  switch (step.type) {
    case 'goto':
      return `
        <input class="control" data-field="url" placeholder="https://…（可用 {{profile.name}}）" value="${esc(step.url ?? '')}" />
        <select class="control narrow" data-field="waitUntil">
          ${['domcontentloaded', 'load', 'networkidle']
            .map((v) => `<option value="${v}"${(step.waitUntil ?? 'domcontentloaded') === v ? ' selected' : ''}>${v}</option>`)
            .join('')}
        </select>`;
    case 'wait':
      return `<input class="control narrow" type="number" min="0" data-field="ms" value="${esc(step.ms ?? 1000)}" /><span class="unit">毫秒</span>`;
    case 'eval':
      return `
        <input class="control mono" data-field="script" placeholder="document.title" value="${esc(step.script ?? '')}" />
        <input class="control narrow" data-field="saveAs" placeholder="存入变量" value="${esc(step.saveAs ?? '')}" />`;
    case 'collect':
      return `
        <div class="collect-fields">
          <div class="row">
            <input class="control narrow" data-field="dataset" placeholder="数据集名" value="${esc(step.dataset ?? '')}" />
            <input class="control narrow" data-field="dedupeBy" placeholder="判重字段，逗号分隔" value="${esc(
              Array.isArray(step.dedupeBy) ? step.dedupeBy.join(',') : step.dedupeBy ?? '',
            )}" title="留空则按全字段判重；同一数据集一旦定下判重规则就不能改" />
            <select class="control narrow" data-field="mode">
              <option value="upsert"${(step.mode ?? 'upsert') === 'upsert' ? ' selected' : ''}>有则更新</option>
              <option value="append"${step.mode === 'append' ? ' selected' : ''}>总是新增</option>
            </select>
            <input class="control narrow" type="number" min="0" data-field="expectMinRows" placeholder="至少N行" value="${
              step.expectMinRows ?? ''
            }" title="少于这么多行算失败；留空表示 0 行也算成功" />
          </div>
          <input class="control mono" data-field="script" placeholder="返回数组的脚本，例如 Array.from(document.querySelectorAll('tr')).map(el => ({ ... }))" value="${esc(
            step.script ?? '',
          )}" />
        </div>`;
    case 'screenshot':
      return `<label class="switch small"><input type="checkbox" data-field="fullPage"${
        step.fullPage ? ' checked' : ''
      } /> 整页</label>`;
    case 'start':
    case 'stop':
      return '<span class="step-hint">—</span>';
    default:
      return '';
  }
}


// ---------------------------------------------------------------- 自动化

const RUN_STATUS = {
  ok: { label: '成功', cls: 'ok' },
  skipped: { label: '跳过', cls: 'warn' },
  failed: { label: '失败', cls: 'bad' },
};
const TRIGGER_LABEL = { cron: '定时', watch: '巡检', manual: '手动' };

async function loadAutomationRuns(id) {
  try {
    state.automationRuns[id] = await API.call(`/api/automations/${id}/runs`);
  } catch (error) {
    state.automationRuns[id] = [];
    toast('读取触发历史失败', error.message, 'bad');
  }
  render();
}

function untilText(ts) {
  if (!ts) return '不会再触发';
  const diff = ts - Date.now();
  if (diff <= 0) return '即将触发';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟后`;
  if (diff < 86_400_000) return `${(diff / 3_600_000).toFixed(1)} 小时后`;
  return `${Math.round(diff / 86_400_000)} 天后`;
}

function autoActionText(rule) {
  if (!rule.actions || rule.actions.length === 0) return '无动作';
  return rule.actions
    .map((action) => {
      if (action.type === 'run_task') {
        const task = state.tasks.find((t) => t.id === action.taskId);
        return `跑任务「${task?.name ?? '已删除'}」`;
      }
      if (action.type === 'switch_proxy') {
        const proxy = state.proxies.find((p) => p.id === action.standbyProxyId);
        const guard = action.sameCountryOnly === false ? '' : '（同国家）';
        return `切到「${proxy?.name ?? '已删除'}」${guard}`;
      }
      if (action.type === 'stop_profiles') return '关闭相关环境';
      return '仅记录';
    })
    .join('、');
}

function renderAutomations() {
  if (state.loading && state.automations.length === 0) {
    return `<div class="empty"><p>加载中…</p></div>`;
  }
  if (state.automations.length === 0) {
    return `<div class="empty">
      <h3>还没有自动化规则</h3>
      <p>定时规则到点自动跑一条任务；巡检规则盯着代理，连续失败时自动切换或关闭环境。<br />
      调度器每 20 秒醒一次，错过的触发不补跑——宁可少跑一次，也不要在开机后一口气启停十遍。</p>
      <button class="btn primary" data-act="new-automation">新建规则</button>
    </div>`;
  }

  const enabled = state.automations.filter((a) => a.enabled).length;
  const nextAt = state.automationScheduler?.nextWakeAt ?? null;
  const failures = state.automations.filter((a) => a.lastStatus === 'failed').length;

  return `
  <div class="stat-row">
    <div class="stat"><b>${state.automations.length}</b><span>规则总数</span></div>
    <div class="stat"><b>${enabled}</b><span>启用中</span></div>
    <div class="stat"><b style="color:${failures ? 'var(--bad)' : 'inherit'}">${failures}</b><span>上次失败</span></div>
    <div class="stat"><b>${nextAt ? untilText(nextAt) : '—'}</b><span>下次触发</span></div>
  </div>
  <div class="task-list">${state.automations.map(renderAutomationCard).join('')}</div>`;
}

function renderAutomationCard(rule) {
  const open = state.expandedAutomation === rule.id;
  const dot = !rule.enabled ? '' : rule.lastStatus === 'failed' ? 'err' : 'on';
  const next = !rule.enabled
    ? '已停用'
    : rule.nextRunAt
      ? `下次 ${clock(rule.nextRunAt)} · ${untilText(rule.nextRunAt)}`
      : '不会触发';
  const last = rule.lastRunAt ? `上次 ${relTime(rule.lastRunAt)}` : '从未运行';

  return `
  <div class="task-card ${open ? 'open' : ''}">
    <div class="task-head" data-act="toggle-auto" data-id="${esc(rule.id)}">
      <span class="status-dot ${dot}"></span>
      <div class="task-title">
        <b>${esc(rule.name)}</b>
        <div class="task-meta">
          ${esc(rule.describe ?? '')} · ${esc(autoActionText(rule))} · ${esc(next)}
        </div>
      </div>
      ${
        rule.lastStatus
          ? `<span class="chip ${RUN_STATUS[rule.lastStatus]?.cls ?? ''}">上次${RUN_STATUS[rule.lastStatus]?.label ?? ''}</span>`
          : ''
      }
      <span class="task-time" title="${esc(last)}">${esc(last)}</span>
      <label class="switch small" title="启用 / 停用" data-act="noop">
        <input type="checkbox" data-act="toggle-auto-enabled" data-id="${esc(rule.id)}"${rule.enabled ? ' checked' : ''} />
      </label>
      <div class="row-actions">
        <button class="btn tiny" data-act="run-auto" data-id="${esc(rule.id)}">立即运行</button>
        <button class="btn tiny" data-act="delete-auto" data-id="${esc(rule.id)}">删除</button>
      </div>
    </div>
    ${open ? renderAutomationHistory(rule) : ''}
  </div>`;
}

function renderAutomationHistory(rule) {
  const runs = state.automationRuns[rule.id];
  if (!runs) return `<div class="task-detail"><p class="dim">读取触发历史…</p></div>`;
  if (runs.length === 0) {
    return `<div class="task-detail"><p class="dim">还没有触发记录。${
      rule.kind === 'proxy_watch' ? '代理巡检没有异常时不写历史，避免把真正的事件埋掉。' : ''
    }</p></div>`;
  }
  return `<div class="task-detail">
    <div class="auto-runs">
      ${runs
        .map(
          (run) => `<div class="auto-run">
            <span class="run-dot ${run.status === 'ok' ? 'succeeded' : run.status === 'failed' ? 'failed' : ''}"></span>
            <span class="chip ${RUN_STATUS[run.status]?.cls ?? ''}">${RUN_STATUS[run.status]?.label ?? run.status}</span>
            <span class="auto-run-trigger">${esc(TRIGGER_LABEL[run.trigger] ?? run.trigger)}</span>
            <span class="auto-run-detail">${esc(run.detail || (run.trigger === 'watch' ? '巡检无异常' : '—'))}</span>
            <span class="auto-run-time">${clock(run.startedAt)}</span>
          </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

let autoPreviewTimer;

function openAutomationModal() {
  const hasTask = state.tasks.length > 0;
  const hasProxy = state.proxies.length > 0;

  const taskOptions = hasTask
    ? state.tasks
        .map(
          (t) =>
            `<option value="${esc(t.id)}">${esc(t.name)} · ${t.steps.length} 步${
              t.target.groupId ? ` · 分组 ${esc(groupName(t.target.groupId))}` : ` · ${t.target.profileIds.length} 个环境`
            }</option>`,
        )
        .join('')
    : '<option value="">（还没有任务，先去「任务」页建一条）</option>';
  const proxyOptions = hasProxy
    ? state.proxies
        .map(
          (p) =>
            `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.lastCheckCountry || p.expectedCountry || '未预检')}</option>`,
        )
        .join('')
    : '<option value="">（还没有代理）</option>';

  openModal(`
    <form id="auto-form">
      <div class="modal-head">
        <h2>新建自动化</h2>
        <p>定时规则到点跑任务；巡检规则盯着代理，连续失败时按动作处理。两者都不补跑。</p>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>规则名</label>
          <input class="control" name="name" required maxlength="64" placeholder="例如：每天 9 点抓店铺数据" autofocus />
        </div>
        <div class="field">
          <label>触发方式</label>
          <select class="control" name="kind" id="auto-kind">
            <option value="cron">定时 — 按 cron 表达式到点触发</option>
            <option value="proxy_watch">代理巡检 — 连续失败时自动处理</option>
          </select>
        </div>

        <div class="auto-spec" id="auto-cron">
          <div class="field">
            <label>表达式（分 时 日 月 周）</label>
            <input class="control mono" name="expr" id="auto-expr" value="0 9 * * *" spellcheck="false" />
            <span class="hint" id="auto-preview">…</span>
          </div>
          <div class="auto-presets">
            <button type="button" data-preset="0 9 * * *">每天 09:00</button>
            <button type="button" data-preset="30 8 * * 1-5">工作日 08:30</button>
            <button type="button" data-preset="*/30 * * * *">每 30 分钟</button>
            <button type="button" data-preset="0 */6 * * *">每 6 小时</button>
            <button type="button" data-preset="0 10 * * 1">每周一 10:00</button>
          </div>
          <div class="field">
            <label>要执行的任务</label>
            <select class="control" name="taskId">${taskOptions}</select>
          </div>
        </div>

        <div class="auto-spec" id="auto-watch" hidden>
          <div class="field-row">
            <div class="field">
              <label>巡检间隔（分钟）</label>
              <input class="control" type="number" name="intervalMinutes" value="10" min="1" max="1440" />
            </div>
            <div class="field">
              <label>连续失败几次算失效</label>
              <input class="control" type="number" name="failThreshold" value="2" min="1" max="10" />
            </div>
          </div>
          <div class="field">
            <label>失效后切到这个代理</label>
            <select class="control" name="standbyProxyId">${proxyOptions}</select>
            <span class="hint">只在出口国家相同时切换——换国会让指纹里的时区与语言和 IP 自相矛盾。</span>
          </div>
          <label class="switch small"><input type="checkbox" name="sameCountry" checked /> 仅同国家才切换</label>
          <label class="switch small"><input type="checkbox" name="stopProfiles" /> 同时关闭正在使用它的环境</label>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="auto-cancel">取消</button>
        <button type="submit" class="btn primary" id="auto-submit">创建</button>
      </div>
    </form>`);

  const kindSelect = $('#auto-kind');
  const cronBox = $('#auto-cron');
  const watchBox = $('#auto-watch');
  const exprInput = $('#auto-expr');

  const syncKind = () => {
    const isCron = kindSelect.value === 'cron';
    cronBox.hidden = !isCron;
    watchBox.hidden = isCron;
  };

  const refreshPreview = () => {
    const hint = $('#auto-preview');
    if (!hint) return;
    const expr = exprInput.value.trim();
    if (!expr) {
      hint.textContent = '—';
      return;
    }
    clearTimeout(autoPreviewTimer);
    autoPreviewTimer = setTimeout(async () => {
      try {
        const data = await API.call(`/api/automations/preview?expr=${encodeURIComponent(expr)}`);
        hint.style.color = data.next.length ? '' : 'var(--bad)';
        hint.textContent = data.next.length
          ? `${data.human} · 接下来 ${data.next.map((t) => clock(t)).join('、')}`
          : `${data.human} · 5 年内不会触发`;
      } catch (error) {
        hint.style.color = 'var(--bad)';
        hint.textContent = error.message;
      }
    }, 220);
  };

  kindSelect.onchange = syncKind;
  exprInput.addEventListener('input', refreshPreview);
  for (const btn of document.querySelectorAll('.auto-presets button')) {
    btn.onclick = () => {
      exprInput.value = btn.dataset.preset;
      refreshPreview();
    };
  }
  syncKind();
  refreshPreview();

  $('#auto-cancel').onclick = closeModal;
  $('#auto-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const kind = String(form.get('kind'));
    const name = String(form.get('name') || '').trim();
    const body = { name, kind };

    if (kind === 'cron') {
      const taskId = String(form.get('taskId') || '');
      if (!taskId) {
        toast('没有可执行的任务', '先去「任务」页建一条，再回来设定时', 'bad');
        return;
      }
      body.spec = { expr: String(form.get('expr') || '').trim() };
      body.actions = [{ type: 'run_task', taskId }];
    } else {
      body.spec = {
        intervalMinutes: Number(form.get('intervalMinutes') || 10),
        failThreshold: Number(form.get('failThreshold') || 2),
      };
      const actions = [];
      const standby = String(form.get('standbyProxyId') || '');
      if (standby) {
        actions.push({
          type: 'switch_proxy',
          standbyProxyId: standby,
          sameCountryOnly: form.get('sameCountry') === 'on',
        });
      }
      if (form.get('stopProfiles') === 'on') actions.push({ type: 'stop_profiles' });
      if (actions.length === 0) {
        toast('巡检规则没有动作', '至少选一个备用代理，或勾选"关闭环境"', 'bad');
        return;
      }
      body.actions = actions;
    }

    const button = $('#auto-submit');
    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const created = await API.call('/api/automations', { method: 'POST', body });
      closeModal();
      toast('规则已创建', `${created.describe} · ${autoActionText(created)}`, 'ok');
      await loadAll({ silent: true });
    } catch (error) {
      button.disabled = false;
      button.textContent = '创建';
      toast('创建失败', error.message, 'bad');
    }
  };
}

// ---------------------------------------------------------------- 启动

render();
void loadAll();

// 轮询：只刷新数据，不动抽屉与选中态
setInterval(() => {
  if (document.hidden || state.busy.size > 0) return;
  void loadAll({ silent: true });
}, 4000);
