/* Egress Matrix console — native Web Component, zero dependencies, scoped CSS. */
'use strict';

const CHANNEL = 'openchamber.sdk';
const WIRE = 1;
const BUS_URL = 'http://127.0.0.1:19880/api/v1/egress';
const TAB_STORAGE_KEY = 'egress-matrix.tab.v2';

const ICONS = {
  overview:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  slots:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="1.6" fill="currentColor" stroke="none"/></svg>',
  nodes:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  subscriptions:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M8 12h8M12 8v8"/></svg>',
  upstream:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M12 15v6"/><path d="M8.5 6.5 12 3l3.5 3.5M8.5 17.5 12 21l3.5-3.5"/><circle cx="12" cy="12" r="3.2"/></svg>',
  rotation:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  play:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5v15l12-7.5z"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/></svg>',
};

const TABS = [
  { id: 'overview', label: '总览', icon: ICONS.overview },
  { id: 'slots', label: '槽位', icon: ICONS.slots },
  { id: 'nodes', label: '节点池', icon: ICONS.nodes },
  { id: 'subscriptions', label: '订阅', icon: ICONS.subscriptions },
  { id: 'upstream', label: '上游', icon: ICONS.upstream },
  { id: 'rotation', label: '轮转', icon: ICONS.rotation },
  { id: 'settings', label: '设置', icon: ICONS.settings },
];

const HEALTH_TONE = {
  ACTIVE: 'active',
  COOLDOWN: 'cooldown',
  QUARANTINED: 'quarantine',
  WARP_OVERFLOW: 'warp',
  ROTATING: 'rotating',
};

const HEALTH_LABEL = {
  ACTIVE: '可用',
  COOLDOWN: '冷却',
  QUARANTINED: '隔离',
  WARP_OVERFLOW: 'WARP 溢出',
  ROTATING: '旋转中',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(value, withDate) {
  const stamp = Number(value);
  if (!stamp) return '—';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '—';
  const time = date.toLocaleTimeString('zh-CN', { hour12: false });
  return withDate ? date.toLocaleDateString('zh-CN') + ' ' + time : time;
}

function ago(value) {
  const stamp = Number(value);
  if (!stamp) return '—';
  const diff = Date.now() - stamp;
  if (diff < 0) return fmtTime(stamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}

function shortId(value, size) {
  const text = String(value || '');
  if (!text) return '—';
  const limit = size || 18;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function healthBadge(state) {
  const key = String(state || 'COOLDOWN').toUpperCase();
  return '<span class="badge tone-' + (HEALTH_TONE[key] || 'cooldown') + '">'
    + esc(HEALTH_LABEL[key] || key) + '</span>';
}

function planeBadge(plane) {
  const strict = String(plane || '').toUpperCase() === 'STRICT_CONTROL';
  return '<span class="badge tone-' + (strict ? 'strict' : 'elastic') + '">'
    + (strict ? 'STRICT_CONTROL' : 'ELASTIC_DATA') + '</span>';
}

function emptyText(text) {
  return '<div class="empty">' + esc(text) + '</div>';
}

class EgressMatrixPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._seq = 0;
    this._pending = new Map();
    this._connected = false;
    this._booted = false;
    this._toastTimer = null;
    this._autoTimer = null;
    this.state = {
      tab: 'overview',
      config: null,
      matrix: null,
      events: [],
      loading: false,
      error: '',
      busy: '',
      toast: null,
      filter: { health: 'ALL', plane: 'ALL', q: '' },
      modal: null,
    };
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
      if (saved && TABS.some((tab) => tab.id === saved)) this.state.tab = saved;
    } catch (error) { /* private mode */ }

    this.shadowRoot.innerHTML = this.shellTemplate();
    this._onMessage = this.onMessage.bind(this);
    this.shadowRoot.addEventListener('click', (event) => this.onClick(event));
    this.shadowRoot.addEventListener('submit', (event) => this.onSubmit(event));
    this.shadowRoot.addEventListener('input', (event) => this.onInput(event));
    this.shadowRoot.addEventListener('change', (event) => this.onInput(event));
  }

  connectedCallback() {
    window.addEventListener('message', this._onMessage);
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = setInterval(() => {
      if (!this._connected) return;
      if (document.hidden) return;
      const active = this.shadowRoot.activeElement;
      const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      this.refresh({ quiet: true });
    }, 15000);
  }

  disconnectedCallback() {
    window.removeEventListener('message', this._onMessage);
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = null;
  }

  shellTemplate() {
    return [
      '<style>',
      this.styles(),
      '</style>',
      '<div class="shell">',
      '  <aside class="rail">',
      '    <div class="brand">',
      '      <div class="brand-mark">EM</div>',
      '      <div class="brand-text"><strong>Egress Matrix</strong><span>统一出口平面</span></div>',
      '    </div>',
      '    <nav class="nav" id="nav"></nav>',
      '    <div class="rail-foot">',
      '      <div class="conn" id="conn"><i></i><span>等待主程序</span></div>',
      '      <div class="rail-meta" id="rail-meta"></div>',
      '    </div>',
      '  </aside>',
      '  <main class="main">',
      '    <header class="topbar">',
      '      <div class="title-block"><h1 id="title">总览</h1><p id="subtitle">矩阵路由平面、槽位与契约状态</p></div>',
      '      <div class="top-actions">',
      '        <button class="btn ghost" data-act="refresh" title="刷新">' + ICONS.refresh + '<span>刷新</span></button>',
      '        <button class="btn primary" data-act="probe-all">' + ICONS.play + '<span>全部探测</span></button>',
      '      </div>',
      '    </header>',
      '    <div class="view" id="view"></div>',
      '    <footer class="statusbar" id="statusbar"></footer>',
      '  </main>',
      '</div>',
      '<div class="toast" id="toast" hidden></div>',
      '<div class="modal-wrap" id="modal" hidden></div>',
    ].join('');
  }

  /* ---------------------------------------------------------------- */
  /* host bridge                                                       */
  /* ---------------------------------------------------------------- */

  post(type, payload, id) {
    const message = { channel: CHANNEL, v: WIRE, type };
    if (id !== undefined) message.id = id;
    if (payload !== undefined) message.payload = payload;
    try { window.parent.postMessage(message, '*'); } catch (error) { /* parent gone */ }
  }

  call(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = 'm' + (++this._seq);
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const error = new Error('OpenChamber 主程序没有响应');
        error.code = 'HOST_TIMEOUT';
        reject(error);
      }, timeoutMs || 20000);
      this._pending.set(id, { resolve, reject, timer });
      this.post(type, payload, id);
    });
  }

  onMessage(event) {
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.v !== WIRE) return;
    if (data.type === 'result') {
      const entry = this._pending.get(data.id);
      if (!entry) return;
      this._pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: data.ok !== false, payload: data.payload, error: data.error, code: data.code });
      return;
    }
    if (data.type === 'ready') {
      this._connected = true;
      this.renderChrome();
      if (!this._booted) {
        this._booted = true;
        this.refresh();
      }
    }
  }

  service(method, path, body, timeoutMs) {
    const payload = { method, path };
    if (body !== undefined) payload.body = JSON.stringify(body);
    return this.call('service-request', payload, timeoutMs || 60000).then((result) => {
      if (!result.ok) {
        const error = new Error(this.hostHint(result.code) || result.error || '请求失败');
        error.code = result.code;
        throw error;
      }
      const envelope = result.payload || {};
      let data = null;
      if (envelope.body) {
        try { data = JSON.parse(envelope.body); } catch (error) { data = { raw: String(envelope.body) }; }
      }
      if (envelope.status >= 400 || (data && data.ok === false)) {
        const detail = (data && data.error) || {};
        const failure = new Error(detail.message || ('本地服务返回 HTTP ' + envelope.status));
        failure.code = detail.code || ('http_' + envelope.status);
        failure.status = envelope.status;
        throw failure;
      }
      return data;
    });
  }

  hostHint(code) {
    const hints = {
      HOST_TIMEOUT: 'OpenChamber 主程序响应超时，稍后重试',
      HOST_UNAVAILABLE: 'OpenChamber 主程序不可用',
      NO_SERVICE: '本地服务未启动或未授权：到 设置 → 扩展 → Egress Matrix 允许本地服务',
      SERVICE_FAILED: '本地服务启动失败：检查扩展日志后重试',
    };
    return hints[code] || '';
  }

  copy(text, label) {
    const value = String(text == null ? '' : text);
    if (!value) return;
    const done = () => this.toast((label ? label + ' ' : '') + '已复制', 'success');
    this.call('clipboard-write', { text: value }, 5000).then((result) => {
      if (result.ok) done();
      else throw new Error(result.error || '复制失败');
    }).catch(() => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done).catch(() => this.toast('复制失败', 'error'));
      } else {
        this.toast('复制失败', 'error');
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* data                                                              */
  /* ---------------------------------------------------------------- */

  async refresh(options) {
    const quiet = Boolean(options && options.quiet);
    if (!this._connected) return;
    if (!quiet) {
      this.state.loading = true;
      this.renderView();
    }
    const failures = [];
    const [config, matrix, events] = await Promise.all([
      this.service('GET', '/api/config').catch((error) => { failures.push(error.message); return null; }),
      this.service('GET', '/api/v1/egress/state').catch((error) => { failures.push(error.message); return null; }),
      this.service('GET', '/api/v1/egress/events?limit=120').catch(() => null),
    ]);
    this.state.config = config || this.state.config;
    this.state.matrix = matrix || this.state.matrix;
    if (events && Array.isArray(events.events)) this.state.events = events.events.slice().reverse();
    this.state.loading = false;
    this.state.error = failures.length && !config ? failures.join('；') : '';
    this.renderChrome();
    this.renderView();
  }

  act(label, task) {
    if (this.state.busy) return Promise.resolve(null);
    this.state.busy = label;
    this.renderStatus();
    return Promise.resolve()
      .then(task)
      .then(async (result) => {
        this.state.busy = '';
        this.toast(label + '完成', 'success');
        await this.refresh({ quiet: true });
        return result === undefined ? true : result;
      })
      .catch((error) => {
        this.state.busy = '';
        this.renderStatus();
        this.toast(error.message || String(error), 'error');
        return false;
      });
  }

  toast(text, tone) {
    const node = this.shadowRoot.getElementById('toast');
    if (!node) return;
    node.textContent = text;
    node.className = 'toast show tone-' + (tone || 'info');
    node.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      node.className = 'toast';
      node.hidden = true;
    }, 3600);
  }

  /* ---------------------------------------------------------------- */
  /* chrome                                                            */
  /* ---------------------------------------------------------------- */

  renderChrome() {
    const nav = this.shadowRoot.getElementById('nav');
    if (nav) {
      nav.innerHTML = TABS.map((tab) => {
        return '<button class="nav-item' + (this.state.tab === tab.id ? ' active' : '') + '" data-act="tab" data-tab="' + tab.id + '">'
          + tab.icon + '<span>' + tab.label + '</span>'
          + '<em class="nav-count">' + this.countFor(tab.id) + '</em></button>';
      }).join('');
    }
    const conn = this.shadowRoot.getElementById('conn');
    if (conn) {
      const ok = this._connected && !this.state.error;
      conn.className = 'conn' + (ok ? ' live' : this.state.error ? ' down' : '');
      conn.innerHTML = '<i></i><span>' + esc(ok ? '本地服务已连接' : this.state.error ? '连接异常' : '等待主程序') + '</span>';
    }
    const meta = this.shadowRoot.getElementById('rail-meta');
    if (meta) {
      const config = this.state.config;
      meta.innerHTML = config
        ? '<span>v' + esc(config.version || '') + '</span><span>' + esc((config.slots || []).length) + '/250 槽位</span>'
        : '';
    }
    const title = this.shadowRoot.getElementById('title');
    const subtitle = this.shadowRoot.getElementById('subtitle');
    const tab = TABS.find((item) => item.id === this.state.tab);
    if (title) title.textContent = tab ? tab.label : 'Egress Matrix';
    if (subtitle) subtitle.textContent = this.subtitleFor(this.state.tab);
    this.renderStatus();
  }

  countFor(id) {
    const config = this.state.config;
    if (!config) return '';
    if (id === 'slots') return String((config.slots || []).length);
    if (id === 'nodes') return String((config.nodes || []).length);
    if (id === 'subscriptions') return String((config.subscriptions || []).length);
    if (id === 'rotation') return String(this.state.events.length || '');
    return '';
  }

  subtitleFor(tab) {
    const map = {
      overview: '矩阵路由平面、槽位与契约状态',
      slots: '250 个确定性端口，一个槽位一条出口身份',
      nodes: '手动节点与订阅节点的上游池',
      subscriptions: '订阅导入、换血与批量建租约',
      upstream: 'proxygate 槽位与 WARP 弹性溢出池',
      rotation: '蓝绿轮转事件与冻结回调',
      settings: '默认网关、控制面域名与契约路径',
    };
    return map[tab] || '';
  }

  renderStatus() {
    const bar = this.shadowRoot.getElementById('statusbar');
    if (!bar) return;
    if (this.state.busy) {
      bar.innerHTML = '<span class="spin"></span><span>正在执行：' + esc(this.state.busy) + '</span>';
      return;
    }
    const matrix = this.state.matrix;
    const stamp = matrix && matrix.updatedAt ? fmtTime(Date.parse(matrix.updatedAt)) : '—';
    bar.innerHTML = '<span>契约 v2</span><span class="dot-sep"></span><span>总线 ' + esc(BUS_URL) + '</span>'
      + '<span class="grow"></span><span>更新 ' + esc(stamp) + '</span>';
  }

  /* ---------------------------------------------------------------- */
  /* view                                                              */
  /* ---------------------------------------------------------------- */

  renderView() {
    const view = this.shadowRoot.getElementById('view');
    if (!view) return;
    if (!this._connected) {
      view.innerHTML = '<div class="boot"><div class="boot-ring"></div><strong>等待 OpenChamber 主程序</strong><span>面板通过宿主桥访问本地 Egress Matrix 服务</span></div>';
      return;
    }
    if (this.state.loading && !this.state.config) {
      view.innerHTML = '<div class="boot"><div class="boot-ring"></div><strong>加载矩阵状态</strong><span>读取槽位、租约与契约文件</span></div>';
    } else if (this.state.error && !this.state.config) {
      view.innerHTML = '<div class="boot error"><strong>无法读取本地服务</strong><span>' + esc(this.state.error) + '</span><button class="btn ghost" data-act="refresh">重试</button></div>';
    } else {
      const focus = this.captureFocus();
      view.innerHTML = this.viewFor(this.state.tab);
      this.restoreFocus(focus);
    }
    this.renderModal();
  }

  captureFocus() {
    const active = this.shadowRoot.activeElement;
    if (!active || !active.dataset || !active.dataset.field) return null;
    return { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd };
  }

  restoreFocus(snapshot) {
    if (!snapshot) return;
    const node = this.shadowRoot.querySelector('[data-field="' + snapshot.field + '"]');
    if (!node) return;
    node.focus();
    if (typeof node.setSelectionRange === 'function' && snapshot.start != null) {
      try { node.setSelectionRange(snapshot.start, snapshot.end); } catch (error) { /* not a text input */ }
    }
  }

  viewFor(tab) {
    if (tab === 'overview') return this.viewOverview();
    if (tab === 'slots') return this.viewSlots();
    if (tab === 'nodes') return this.viewNodes();
    if (tab === 'subscriptions') return this.viewSubscriptions();
    if (tab === 'upstream') return this.viewUpstream();
    if (tab === 'rotation') return this.viewRotation();
    if (tab === 'settings') return this.viewSettings();
    return '';
  }

  slots() {
    return this.state.matrix && Array.isArray(this.state.matrix.slots)
      ? this.state.matrix.slots
      : (this.state.config && Array.isArray(this.state.config.slots) ? this.state.config.slots : []);
  }

  defaultLane() {
    const lanes = this.state.matrix && Array.isArray(this.state.matrix.lanes) ? this.state.matrix.lanes : [];
    return lanes.find((lane) => lane.key === 'default') || null;
  }

  viewOverview() {
    const slots = this.slots();
    const counts = { ACTIVE: 0, COOLDOWN: 0, QUARANTINED: 0, WARP_OVERFLOW: 0, ROTATING: 0 };
    let strict = 0;
    for (const slot of slots) {
      const state = String(slot.healthState || '').toUpperCase();
      if (counts[state] === undefined) counts[state] = 0;
      counts[state] += 1;
      if (slot.routingPlane === 'STRICT_CONTROL') strict += 1;
    }
    const elastic = slots.length - strict;
    const lane = this.defaultLane();
    const warp = (this.state.matrix && this.state.matrix.warp) || (this.state.config && this.state.config.warp) || null;
    const abuse = (this.state.matrix && this.state.matrix.abuse) || {};
    const locked = Object.keys(abuse).filter((key) => abuse[key] && abuse[key].lockUntil > Date.now()).length;

    const stats = [
      { label: '可用线路', value: counts.ACTIVE, tone: 'active', hint: 'healthState = ACTIVE' },
      { label: '冷却', value: counts.COOLDOWN, tone: 'cooldown', hint: '连续失败后自动冷却' },
      { label: '隔离', value: counts.QUARANTINED, tone: 'quarantine', hint: '污点冲突或防扫触发' },
      { label: 'WARP 溢出', value: counts.WARP_OVERFLOW, tone: 'warp', hint: 'ELASTIC_DATA 弹性路由' },
      { label: '旋转中', value: counts.ROTATING, tone: 'rotating', hint: '蓝绿换血窗口' },
      { label: '空闲槽位', value: 250 - slots.length, tone: 'muted', hint: '24001 - 24250' },
    ];

    const recent = this.state.events.slice(0, 6);
    return [
      '<section class="stack">',
      '<div class="stat-grid">',
      stats.map((item) => [
        '<div class="stat tone-' + item.tone + '">',
        '<span class="stat-label">' + esc(item.label) + '</span>',
        '<strong class="stat-value">' + item.value + '</strong>',
        '<span class="stat-hint">' + esc(item.hint) + '</span>',
        '</div>',
      ].join('')).join(''),
      '</div>',

      '<div class="split">',
      '<div class="card">',
      '<div class="card-head"><h2>默认网关</h2><span class="muted">default lane</span></div>',
      lane ? [
        '<div class="kv">',
        '<div><span>本地端口</span><code>' + esc(lane.port) + '</code></div>',
        '<div><span>出口 IP</span><code>' + esc(lane.exitIp || '待探测') + '</code></div>',
        '<div><span>槽位</span><code>' + esc(lane.matrixSlotId || '—') + '</code></div>',
        '<div><span>健康</span>' + healthBadge(lane.healthState) + '</div>',
        '</div>',
        '<div class="copy-row">',
        '<button class="chip" data-act="copy" data-copy="' + esc(lane.proxy) + '" data-label="HTTP 代理">' + ICONS.copy + 'HTTP ' + esc(lane.proxy) + '</button>',
        '<button class="chip" data-act="copy" data-copy="' + esc(lane.socks) + '" data-label="SOCKS5">' + ICONS.copy + 'SOCKS5 ' + esc(lane.socks) + '</button>',
        '</div>',
        lane.error ? '<p class="note warn">' + esc(lane.error) + '</p>' : '',
      ].join('') : '<p class="note">还没有主线路。添加节点并建租约后，默认网关会镜像主槽位。</p>',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>路由平面</h2><span class="muted">' + slots.length + ' 条线路</span></div>',
      '<div class="bars">',
      this.bar('STRICT_CONTROL', strict, slots.length, 'strict'),
      this.bar('ELASTIC_DATA', elastic, slots.length, 'elastic'),
      this.bar('WARP_OVERFLOW', counts.WARP_OVERFLOW || 0, slots.length, 'warp'),
      '</div>',
      '<div class="mini-grid">',
      '<div><span>WARP 池</span><strong>' + esc(warp ? (warp.healthy || 0) + '/' + (warp.total || 0) : '未配置') + '</strong></div>',
      '<div><span>防扫隔离</span><strong>' + locked + '</strong></div>',
      '<div><span>订阅</span><strong>' + esc((this.state.config.subscriptions || []).length) + '</strong></div>',
      '<div><span>节点</span><strong>' + esc((this.state.config.nodes || []).length) + '</strong></div>',
      '</div>',
      '</div>',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>最近轮转事件</h2><button class="btn ghost small" data-act="tab" data-tab="rotation">查看全部</button></div>',
      recent.length ? '<ul class="timeline">' + recent.map((event) => [
        '<li>',
        '<span class="event-type tone-' + this.eventTone(event.type) + '">' + esc(event.type) + '</span>',
        '<span class="event-slot">' + esc(event.matrixSlotId || '—') + '</span>',
        '<span class="event-time">' + esc(fmtTime(event.at)) + '</span>',
        '</li>',
      ].join('')).join('') + '</ul>' : emptyText('还没有轮转事件。换血时 PRE_ROTATION_FREEZE / POST_ROTATION_RESUME 会记录在这里。'),
      '</div>',
      '</section>',
    ].join('');
  }

  bar(label, value, total, tone) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return '<div class="bar-row"><span class="bar-label">' + esc(label) + '</span>'
      + '<div class="bar-track"><i class="tone-' + tone + '" style="width:' + pct + '%"></i></div>'
      + '<span class="bar-value">' + value + '</span></div>';
  }

  eventTone(type) {
    const value = String(type || '');
    if (value === 'ROTATION_FAILED') return 'quarantine';
    if (value === 'PRE_ROTATION_FREEZE') return 'rotating';
    if (value === 'POST_ROTATION_RESUME') return 'active';
    return 'elastic';
  }

  filteredSlots() {
    const filter = this.state.filter;
    const query = filter.q.trim().toLowerCase();
    return this.slots().filter((slot) => {
      if (filter.health !== 'ALL' && slot.healthState !== filter.health) return false;
      if (filter.plane !== 'ALL' && slot.routingPlane !== filter.plane) return false;
      if (!query) return true;
      return [slot.matrixSlotId, slot.key, slot.country, slot.egressFingerprint && slot.egressFingerprint.exitIp, slot.nodeId, slot.slotId]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }

  viewSlots() {
    const all = this.slots();
    const rows = this.filteredSlots();
    return [
      '<section class="stack">',
      '<div class="toolbar card">',
      '<div class="field inline"><label>健康状态</label><select data-filter="health">',
      ['ALL', 'ACTIVE', 'COOLDOWN', 'QUARANTINED', 'WARP_OVERFLOW', 'ROTATING'].map((value) => {
        return '<option value="' + value + '"' + (this.state.filter.health === value ? ' selected' : '') + '>'
          + (value === 'ALL' ? '全部' : esc(HEALTH_LABEL[value])) + '</option>';
      }).join(''),
      '</select></div>',
      '<div class="field inline"><label>路由平面</label><select data-filter="plane">',
      ['ALL', 'STRICT_CONTROL', 'ELASTIC_DATA'].map((value) => {
        return '<option value="' + value + '"' + (this.state.filter.plane === value ? ' selected' : '') + '>'
          + (value === 'ALL' ? '全部' : value) + '</option>';
      }).join(''),
      '</select></div>',
      '<div class="field inline grow"><label>搜索</label><input data-field="slot-search" data-filter="q" value="' + esc(this.state.filter.q) + '" placeholder="slot-001 / key / 出口 IP" /></div>',
      '<div class="toolbar-meta">' + rows.length + ' / ' + all.length + ' 条</div>',
      '</div>',
      rows.length ? '<div class="slot-grid">' + rows.map((slot) => this.slotCard(slot)).join('') + '</div>'
        : emptyText(all.length ? '没有符合筛选条件的槽位' : '还没有槽位。到节点池建租约，或在订阅页批量建租约。'),
      '</section>',
    ].join('');
  }

  slotCard(slot) {
    const fingerprint = slot.egressFingerprint || {};
    const busy = Boolean(this.state.busy);
    const cooldown = Number(slot.cooldownUntil) > Date.now() ? ' · 至 ' + fmtTime(slot.cooldownUntil) : '';
    return [
      '<article class="slot card tone-' + (HEALTH_TONE[slot.healthState] || 'muted') + '">',
      '<header>',
      '<div class="slot-id"><strong>' + esc(slot.matrixSlotId) + '</strong><button class="port" data-act="copy" data-copy="127.0.0.1:' + esc(slot.egressPort) + '" data-label="端口">127.0.0.1:' + esc(slot.egressPort) + '</button></div>',
      healthBadge(slot.healthState),
      '</header>',
      '<div class="slot-key">' + esc(slot.key || '—') + '</div>',
      '<div class="slot-badges">' + planeBadge(slot.routingPlane) + '<span class="badge tone-muted">' + esc(slot.provider || 'static') + '</span>' + (slot.country ? '<span class="badge tone-muted">' + esc(slot.country) + '</span>' : '') + '</div>',
      '<dl class="slot-meta">',
      '<div><dt>出口 IP</dt><dd>' + esc(fingerprint.exitIp || '待探测') + '</dd></div>',
      '<div><dt>/64</dt><dd title="' + esc(fingerprint.ipv6Prefix64 || '') + '">' + esc(fingerprint.ipv6Prefix64 || '—') + '</dd></div>',
      '<div><dt>ASN</dt><dd>' + esc(fingerprint.asn || '—') + '</dd></div>',
      '<div><dt>leaseId</dt><dd title="' + esc(fingerprint.leaseId || '') + '">' + esc(shortId(fingerprint.leaseId, 16)) + '</dd></div>',
      '</dl>',
      slot.lastError ? '<p class="note ' + (slot.healthState === 'QUARANTINED' ? 'danger' : 'warn') + '">' + esc(slot.lastError) + cooldown + '</p>' : '',
      '<footer>',
      '<button class="btn ghost small" data-act="slot-probe" data-slot="' + esc(slot.matrixSlotId) + '"' + (busy ? ' disabled' : '') + '>' + ICONS.play + '探测</button>',
      '<button class="btn ghost small" data-act="slot-rotate" data-slot="' + esc(slot.matrixSlotId) + '"' + (busy ? ' disabled' : '') + '>换血</button>',
      slot.healthState === 'QUARANTINED'
        ? '<button class="btn ghost small" data-act="slot-release" data-slot="' + esc(slot.matrixSlotId) + '"' + (busy ? ' disabled' : '') + '>' + ICONS.shield + '解除</button>'
        : '<button class="btn ghost small danger" data-act="slot-quarantine" data-slot="' + esc(slot.matrixSlotId) + '"' + (busy ? ' disabled' : '') + '>' + ICONS.shield + '隔离</button>',
      '</footer>',
      '<details class="slot-json"><summary>契约记录</summary><pre>' + esc(JSON.stringify({
        matrixSlotId: slot.matrixSlotId,
        egressPort: slot.egressPort,
        routingPlane: slot.routingPlane,
        healthState: slot.healthState,
        egressFingerprint: fingerprint,
        leaseId: slot.leaseId,
        intentId: slot.intentId,
        provider: slot.provider,
      }, null, 2)) + '</pre></details>',
      '</article>',
    ].join('');
  }

  viewNodes() {
    const nodes = this.state.config.nodes || [];
    return [
      '<section class="stack">',
      '<div class="card">',
      '<div class="card-head"><h2>添加节点</h2><span class="muted">vless:// · trojan:// · socks5://</span></div>',
      '<form class="form-grid" data-form="node-add">',
      '<label class="field span-2"><span>节点 URI</span><input name="uri" data-field="node-uri" placeholder="vless://uuid@host:443?security=tls&type=ws&path=/proxy#name" required /></label>',
      '<label class="field"><span>名称（可选）</span><input name="name" data-field="node-name" placeholder="TH-static-01" /></label>',
      '<div class="field actions"><button class="btn primary" type="submit">添加节点</button></div>',
      '</form>',
      '</div>',
      '<div class="card">',
      '<div class="card-head"><h2>节点池</h2><span class="muted">' + nodes.length + ' 个节点</span></div>',
      nodes.length ? '<div class="list">' + nodes.map((node) => {
        const info = node.node || {};
        const check = node.lastCheck || null;
        return [
          '<div class="row">',
          '<div class="row-main">',
          '<strong>' + esc(node.name) + '</strong>',
          '<span class="mono">' + esc((info.protocol || '?') + '://' + (info.server || '?') + ':' + (info.port || '?')) + '</span>',
          '</div>',
          '<div class="row-meta">',
          node.subscriptionId ? '<span class="badge tone-muted">订阅</span>' : '<span class="badge tone-muted">手动</span>',
          check ? (check.ok ? '<span class="badge tone-active">出口 ' + esc(check.exitIp || '?') + '</span>' : '<span class="badge tone-quarantine">探测失败</span>') : '<span class="badge tone-muted">未探测</span>',
          '</div>',
          '<div class="row-actions">',
          '<button class="btn ghost small" data-act="node-probe" data-node="' + esc(node.id) + '">' + ICONS.play + '探测</button>',
          '<button class="btn ghost small" data-act="node-lease" data-node="' + esc(node.id) + '" data-name="' + esc(node.name) + '">建租约</button>',
          '<button class="btn ghost small danger" data-act="node-delete" data-node="' + esc(node.id) + '">' + ICONS.trash + '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('') + '</div>' : emptyText('节点池为空。添加一个节点，或从订阅导入。'),
      '</div>',
      '</section>',
    ].join('');
  }

  viewSubscriptions() {
    const subs = this.state.config.subscriptions || [];
    return [
      '<section class="stack">',
      '<div class="card">',
      '<div class="card-head"><h2>导入订阅</h2><span class="muted">明文或 base64，自动去重</span></div>',
      '<form class="form-grid" data-form="sub-add">',
      '<label class="field span-2"><span>订阅地址</span><input name="url" data-field="sub-url" placeholder="https://example.com/sub?token=TOKEN" required /></label>',
      '<label class="field"><span>名称</span><input name="name" data-field="sub-name" placeholder="机场 A" /></label>',
      '<label class="field"><span>Key 前缀</span><input name="keyPrefix" data-field="sub-prefix" placeholder="airport-a" /></label>',
      '<label class="check"><input type="checkbox" name="autoLease" value="1" data-field="sub-auto" /> <span>导入后自动建租约</span></label>',
      '<div class="field actions"><button class="btn primary" type="submit">导入</button></div>',
      '</form>',
      '</div>',
      '<div class="card">',
      '<div class="card-head"><h2>批量建租约</h2><span class="muted">按订阅节点顺序分配槽位</span></div>',
      '<form class="form-grid" data-form="sub-batch">',
      '<label class="field"><span>订阅</span><select name="subscriptionId" data-field="batch-sub">',
      subs.length ? subs.map((sub) => '<option value="' + esc(sub.id) + '">' + esc(sub.name) + '（' + esc(sub.nodeCount) + ' 节点）</option>').join('') : '<option value="">先导入订阅</option>',
      '</select></label>',
      '<label class="field"><span>Key 前缀（可选）</span><input name="keyPrefix" data-field="batch-prefix" placeholder="留空用节点名" /></label>',
      '<label class="field"><span>国家（可选）</span><input name="country" data-field="batch-country" placeholder="TH" /></label>',
      '<div class="field actions"><button class="btn primary" type="submit"' + (subs.length ? '' : ' disabled') + '>批量建租约</button></div>',
      '</form>',
      '</div>',
      '<div class="card">',
      '<div class="card-head"><h2>订阅列表</h2><span class="muted">' + subs.length + ' 个</span></div>',
      subs.length ? '<div class="list">' + subs.map((sub) => [
        '<div class="row">',
        '<div class="row-main">',
        '<strong>' + esc(sub.name) + '</strong>',
        '<span class="mono">' + esc(sub.url) + '</span>',
        '</div>',
        '<div class="row-meta">',
        '<span class="badge tone-muted">' + esc(sub.nodeCount) + ' 节点</span>',
        '<span class="badge tone-muted">' + esc(sub.leaseCount) + ' 租约</span>',
        sub.autoLease ? '<span class="badge tone-elastic">autoLease</span>' : '',
        sub.lastError ? '<span class="badge tone-quarantine" title="' + esc(sub.lastError) + '">同步失败</span>' : '<span class="badge tone-active">' + esc(sub.lastSyncAt ? ago(Date.parse(sub.lastSyncAt)) + '同步' : '未同步') + '</span>',
        '</div>',
        '<div class="row-actions">',
        '<button class="btn ghost small" data-act="sub-sync" data-sub="' + esc(sub.id) + '">' + ICONS.refresh + '重同步</button>',
        '<button class="btn ghost small" data-act="sub-batch" data-sub="' + esc(sub.id) + '">建租约</button>',
        '<button class="btn ghost small danger" data-act="sub-delete" data-sub="' + esc(sub.id) + '">' + ICONS.trash + '</button>',
        '</div>',
        '</div>',
      ].join('')).join('') + '</div>' : emptyText('还没有订阅。'),
      '</div>',
      '</section>',
    ].join('');
  }

  viewUpstream() {
    const pg = this.state.config.proxygate || {};
    const warp = this.state.config.warp || { enabled: false, endpoints: [], cooldownMs: 60000 };
    const matrixWarp = (this.state.matrix && this.state.matrix.warp) || null;
    const endpoints = Array.isArray(warp.endpoints) ? warp.endpoints : [];
    return [
      '<section class="stack">',
      '<div class="card">',
      '<div class="card-head"><h2>proxygate 槽位</h2><span class="muted">/api/v1/pool/*</span></div>',
      '<form class="form-grid" data-form="pg-save">',
      '<label class="field span-2"><span>Base URL</span><input name="baseUrl" data-field="pg-base" value="' + esc(pg.baseUrl || '') + '" placeholder="http://127.0.0.1:8080" /></label>',
      '<label class="field"><span>认证头</span><input name="authHeader" data-field="pg-header" value="' + esc(pg.authHeader || 'x-api-key') + '" /></label>',
      '<label class="field"><span>认证值</span><input name="authValue" data-field="pg-value" value="' + esc(pg.authValue || '') + '" /></label>',
      '<label class="field"><span>默认国家</span><input name="country" data-field="pg-country" value="' + esc(pg.country || '') + '" placeholder="TH" /></label>',
      '<label class="field"><span>SOCKS 主机</span><input name="socksHost" data-field="pg-socks" value="' + esc(pg.socksHost || '') + '" placeholder="127.0.0.1" /></label>',
      '<label class="field"><span>SOCKS 密码</span><input name="socksPassword" data-field="pg-pass" value="' + esc(pg.socksPassword || '') + '" /></label>',
      '<label class="check"><input type="checkbox" name="enabled" value="1"' + (pg.enabled ? ' checked' : '') + ' /> <span>启用 proxygate 来源</span></label>',
      '<div class="field actions"><button class="btn primary" type="submit">保存</button></div>',
      '</form>',
      '<div class="toolbar">',
      '<button class="btn ghost small" data-act="pg-sync">' + ICONS.refresh + '同步槽位</button>',
      '<button class="btn ghost small" data-act="pg-allocate">分配一个槽位</button>',
      '</div>',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>WARP 弹性溢出池</h2><span class="muted">' + (matrixWarp ? esc(matrixWarp.healthy + '/' + matrixWarp.total + ' 可用') : '仅 ELASTIC_DATA') + '</span></div>',
      '<form class="form-grid" data-form="warp-save">',
      '<label class="check span-2"><input type="checkbox" name="enabled" value="1"' + (warp.enabled ? ' checked' : '') + ' /> <span>启用 WARP 溢出（控制面永不溢出）</span></label>',
      '<label class="field span-2"><span>端点（每行一个 socks5:// 或 vless://）</span><textarea name="endpoints" rows="4" data-field="warp-endpoints" placeholder="socks5://127.0.0.1:40000">' + esc(endpoints.join('\n')) + '</textarea></label>',
      '<label class="field"><span>冷却毫秒</span><input name="cooldownMs" data-field="warp-cooldown" type="number" min="1000" max="3600000" value="' + esc(warp.cooldownMs || 60000) + '" /></label>',
      '<div class="field actions"><button class="btn primary" type="submit">保存</button></div>',
      '</form>',
      matrixWarp && Array.isArray(matrixWarp.endpoints) && matrixWarp.endpoints.length ? '<div class="list compact">' + matrixWarp.endpoints.map((endpoint) => [
        '<div class="row">',
        '<div class="row-main"><span class="mono">' + esc(endpoint.host + ':' + endpoint.port) + '</span></div>',
        '<div class="row-meta">' + (endpoint.healthy ? '<span class="badge tone-active">healthy</span>' : '<span class="badge tone-cooldown">冷却</span>')
          + '<span class="badge tone-muted">' + esc(endpoint.protocol || '') + '</span></div>',
        '</div>',
      ].join('')).join('') + '</div>' : '',
      '</div>',
      '</section>',
    ].join('');
  }

  viewRotation() {
    const callbacks = (this.state.matrix && this.state.matrix.callbacks) || [];
    const events = this.state.events;
    return [
      '<section class="stack">',
      '<div class="card">',
      '<div class="card-head"><h2>冻结回调</h2><span class="muted">PRE_ROTATION_FREEZE 预算 200ms</span></div>',
      '<form class="form-grid" data-form="cb-add">',
      '<label class="field"><span>clientId</span><input name="clientId" data-field="cb-id" placeholder="openchamber-cloudflare" required /></label>',
      '<label class="field span-2"><span>回调 URL</span><input name="url" data-field="cb-url" placeholder="http://127.0.0.1:PORT/rotation" required /></label>',
      '<label class="check span-2"><input type="checkbox" name="PRE_ROTATION_FREEZE" value="1" checked /> <span>PRE_ROTATION_FREEZE</span></label>',
      '<label class="check"><input type="checkbox" name="POST_ROTATION_RESUME" value="1" checked /> <span>POST_ROTATION_RESUME</span></label>',
      '<label class="check"><input type="checkbox" name="ROTATION_FAILED" value="1" checked /> <span>ROTATION_FAILED</span></label>',
      '<label class="check"><input type="checkbox" name="LEASE_CHANGED" value="1" checked /> <span>LEASE_CHANGED</span></label>',
      '<div class="field actions"><button class="btn primary" type="submit">注册回调</button></div>',
      '</form>',
      callbacks.length ? '<div class="list compact">' + callbacks.map((callback) => [
        '<div class="row">',
        '<div class="row-main"><strong>' + esc(callback.clientId) + '</strong><span class="mono">' + esc(callback.url) + '</span></div>',
        '<div class="row-meta">' + (callback.events || []).map((event) => '<span class="badge tone-muted">' + esc(event) + '</span>').join('') + '</div>',
        '<div class="row-actions"><button class="btn ghost small danger" data-act="cb-delete" data-client="' + esc(callback.clientId) + '">' + ICONS.trash + '</button></div>',
        '</div>',
      ].join('')).join('') + '</div>' : '',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>轮转事件</h2><span class="muted">' + events.length + ' 条</span></div>',
      events.length ? '<ul class="timeline tall">' + events.map((event) => [
        '<li>',
        '<span class="event-type tone-' + this.eventTone(event.type) + '">' + esc(event.type) + '</span>',
        '<span class="event-slot">' + esc(event.matrixSlotId || '—') + '</span>',
        '<span class="event-detail">' + esc(event.reason || event.leaseId || '') + '</span>',
        '<span class="event-time">' + esc(fmtTime(event.at, true)) + '</span>',
        '</li>',
      ].join('')).join('') + '</ul>' : emptyText('还没有轮转事件。'),
      '</div>',
      '</section>',
    ].join('');
  }

  viewSettings() {
    const settings = this.state.config.settings || {};
    const leases = this.state.config.leases || [];
    const matrix = this.state.config.matrix || {};
    const files = this.state.config.files || {};
    return [
      '<section class="stack">',
      '<div class="card">',
      '<div class="card-head"><h2>矩阵设置</h2><span class="muted">保存后自动 reconcile</span></div>',
      '<form class="form-grid" data-form="settings-save">',
      '<label class="field"><span>默认网关端口</span><input name="defaultPort" data-field="set-default-port" type="number" min="1" max="65535" value="' + esc(settings.defaultPort || 25001) + '" /></label>',
      '<label class="field"><span>探针 URL</span><input name="probeUrl" data-field="set-probe" value="' + esc(settings.probeUrl || 'https://api.ipify.org') + '" /></label>',
      '<label class="field span-2"><span>控制面域名（每行一个，子域自动匹配）</span><textarea name="controlDomains" rows="4" data-field="set-domains" placeholder="api.cloudflare.com">' + esc((settings.controlDomains || []).join('\n')) + '</textarea></label>',
      '<label class="field"><span>主槽位</span><select name="primarySlot" data-field="set-primary">',
      '<option value="">自动（第一条租约）</option>',
      leases.map((lease) => '<option value="' + esc(lease.id) + '"' + (this.primaryLeaseId() === lease.id ? ' selected' : '') + '>'
        + esc(lease.matrixSlotId + ' · ' + lease.key) + '</option>').join(''),
      '</select></label>',
      '<div class="field actions"><button class="btn primary" type="submit">保存设置</button></div>',
      '</form>',
      '</div>',

      '<div class="split">',
      '<div class="card">',
      '<div class="card-head"><h2>契约文件</h2><span class="muted">其他扩展读这里</span></div>',
      '<div class="path-row"><span>endpoints.json</span><button class="chip" data-act="copy" data-copy="' + esc(files.endpoints || '') + '" data-label="路径">' + ICONS.copy + esc(files.endpoints || '—') + '</button></div>',
      '<div class="path-row"><span>proxies.txt</span><button class="chip" data-act="copy" data-copy="' + esc(files.proxies || '') + '" data-label="路径">' + ICONS.copy + esc(files.proxies || '—') + '</button></div>',
      '<div class="path-row"><span>egress-leases.json</span><code>' + esc(matrix.leases || '—') + '</code></div>',
      '<div class="path-row"><span>subnet-taint-ledger.json</span><code>' + esc(matrix.ledger || '—') + '</code></div>',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>协同总线</h2><span class="muted">只监听回环</span></div>',
      '<button class="chip wide" data-act="copy" data-copy="' + esc(BUS_URL) + '" data-label="总线地址">' + ICONS.copy + esc(BUS_URL) + '</button>',
      '<p class="note">供 openchamber-instabox 与 openchamber-cloudflare 实时查询租约、订阅换血事件。控制面请求携带 X-OC-Routing-Plane: STRICT_CONTROL。</p>',
      '<div class="mini-grid">',
      '<div><span>槽位端口</span><strong class="mono">24001-24250</strong></div>',
      '<div><span>默认网关</span><strong class="mono">' + esc(settings.defaultPort || 25001) + '</strong></div>',
      '<div><span>状态目录</span><strong class="mono">~/.openchamber/matrix-state</strong></div>',
      '<div><span>版本</span><strong>' + esc(this.state.config.version || '') + '</strong></div>',
      '</div>',
      '</div>',
      '</div>',

      '<div class="card">',
      '<div class="card-head"><h2>维护</h2><span class="muted">不改变出口身份</span></div>',
      '<div class="toolbar">',
      '<button class="btn ghost" data-act="reconcile">' + ICONS.refresh + '重建监听</button>',
      '<button class="btn ghost" data-act="probe-all">' + ICONS.play + '全部探测</button>',
      '</div>',
      '<p class="note">重建监听只同步 state.json 与 egress-leases.json，不改槽位端口；换血请在槽位页执行。</p>',
      '</div>',
      '</section>',
    ].join('');
  }

  primaryLeaseId() {
    const settings = (this.state.config && this.state.config.settings) || {};
    return settings.primary || '';
  }

  /* ---------------------------------------------------------------- */
  /* modal                                                             */
  /* ---------------------------------------------------------------- */

  renderModal() {
    const wrap = this.shadowRoot.getElementById('modal');
    if (!wrap) return;
    const modal = this.state.modal;
    if (!modal) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    if (modal.type === 'rotate') {
      const nodes = (this.state.config && this.state.config.nodes) || [];
      wrap.innerHTML = [
        '<div class="modal">',
        '<div class="card-head"><h2>换血 ' + esc(modal.matrixSlotId) + '</h2><button class="btn ghost small" data-act="modal-close">关闭</button></div>',
        '<form data-form="rotate">',
        '<p class="note">先进入 ROTATING，广播 PRE_ROTATION_FREEZE，写入污点账本后才恢复。控制面线路不会溢出到 WARP。</p>',
        '<label class="field"><span>来源</span><select name="mode" data-field="rotate-mode">',
        '<option value="nodeUri">直接粘贴节点 URI</option>',
        '<option value="nodeId">从节点池选择</option>',
        '<option value="slotId">proxygate 槽位轮转</option>',
        '</select></label>',
        '<label class="field"><span>节点 URI</span><textarea name="nodeUri" rows="3" data-field="rotate-uri" placeholder="vless://..."></textarea></label>',
        '<label class="field"><span>节点池</span><select name="nodeId" data-field="rotate-node">',
        '<option value="">—</option>',
        nodes.map((node) => '<option value="' + esc(node.id) + '">' + esc(node.name) + '</option>').join(''),
        '</select></label>',
        '<label class="field"><span>proxygate 槽位 ID</span><input name="slotId" data-field="rotate-slot" placeholder="slot id" /></label>',
        '<label class="field"><span>原因</span><input name="reason" data-field="rotate-reason" value="manual" /></label>',
        '<div class="modal-actions">',
        '<button class="btn ghost" type="button" data-act="modal-close">取消</button>',
        '<button class="btn primary" type="submit">开始换血</button>',
        '</div>',
        '</form>',
        '</div>',
      ].join('');
    }
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  onClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    if (act === 'tab') {
      this.state.tab = target.dataset.tab;
      try { window.localStorage.setItem(TAB_STORAGE_KEY, this.state.tab); } catch (error) { /* ignore */ }
      this.renderChrome();
      this.renderView();
      return;
    }
    if (act === 'refresh') { void this.refresh(); return; }
    if (act === 'modal-close') { this.state.modal = null; this.renderView(); return; }
    if (act === 'copy') { this.copy(target.dataset.copy, target.dataset.label); return; }
    if (act === 'probe-all') {
      void this.act('探测全部槽位', () => this.service('POST', '/api/v1/egress/probe', { deep: true }, 120000));
      return;
    }
    if (act === 'reconcile') {
      void this.act('重建监听', () => this.service('POST', '/api/reconcile'));
      return;
    }
    if (act === 'slot-probe') {
      const id = target.dataset.slot;
      void this.act('探测 ' + id, () => this.service('POST', '/api/v1/egress/slots/' + encodeURIComponent(id) + '/probe', { deep: true }, 90000));
      return;
    }
    if (act === 'slot-quarantine') {
      const id = target.dataset.slot;
      void this.act('隔离 ' + id, () => this.service('POST', '/api/v1/egress/slots/' + encodeURIComponent(id) + '/quarantine', { reason: 'manual' }));
      return;
    }
    if (act === 'slot-release') {
      const id = target.dataset.slot;
      void this.act('解除隔离 ' + id, () => this.service('POST', '/api/v1/egress/slots/' + encodeURIComponent(id) + '/release', {}));
      return;
    }
    if (act === 'slot-rotate') {
      this.state.modal = { type: 'rotate', matrixSlotId: target.dataset.slot };
      this.renderView();
      return;
    }
    if (act === 'node-probe') {
      const id = target.dataset.node;
      void this.act('探测节点', () => this.service('POST', '/api/nodes/' + encodeURIComponent(id) + '/probe', {}, 60000));
      return;
    }
    if (act === 'node-delete') {
      const id = target.dataset.node;
      void this.act('删除节点', () => this.service('DELETE', '/api/nodes/' + encodeURIComponent(id)));
      return;
    }
    if (act === 'node-lease') {
      const id = target.dataset.node;
      void this.act('建租约', () => this.service('POST', '/api/leases', {
        nodeId: id,
        key: 'node/' + (target.dataset.name || id),
        primary: false,
      }));
      return;
    }
    if (act === 'sub-sync') {
      const id = target.dataset.sub;
      void this.act('重同步订阅', () => this.service('POST', '/api/subscriptions/' + encodeURIComponent(id) + '/sync', {}, 90000));
      return;
    }
    if (act === 'sub-delete') {
      const id = target.dataset.sub;
      void this.act('删除订阅', () => this.service('DELETE', '/api/subscriptions/' + encodeURIComponent(id)));
      return;
    }
    if (act === 'sub-batch') {
      const id = target.dataset.sub;
      const form = this.shadowRoot.querySelector('form[data-form="sub-batch"]');
      const country = form && form.country ? form.country.value : '';
      void this.act('批量建租约', () => this.service('POST', '/api/leases/batch', {
        subscriptionId: id,
        country,
      }, 90000));
      return;
    }
    if (act === 'pg-sync') {
      void this.act('同步 proxygate 槽位', () => this.service('POST', '/api/proxygate/sync', {}, 60000));
      return;
    }
    if (act === 'pg-allocate') {
      const pg = (this.state.config && this.state.config.proxygate) || {};
      void this.act('分配 proxygate 槽位', () => this.service('POST', '/api/proxygate/allocate', { country: pg.country || '' }, 60000));
      return;
    }
    if (act === 'cb-delete') {
      const clientId = target.dataset.client;
      void this.act('删除回调', () => this.service('DELETE', '/api/v1/egress/callbacks?clientId=' + encodeURIComponent(clientId)));
      return;
    }
  }

  onSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    const data = new FormData(form);

    if (kind === 'node-add') {
      void this.act('添加节点', () => this.service('POST', '/api/nodes', {
        uri: String(data.get('uri') || '').trim(),
        name: String(data.get('name') || '').trim(),
      })).then(() => form.reset());
      return;
    }
    if (kind === 'sub-add') {
      void this.act('导入订阅', () => this.service('POST', '/api/subscriptions', {
        url: String(data.get('url') || '').trim(),
        name: String(data.get('name') || '').trim(),
        keyPrefix: String(data.get('keyPrefix') || '').trim(),
        autoLease: data.get('autoLease') === '1',
      }, 90000)).then(() => form.reset());
      return;
    }
    if (kind === 'sub-batch') {
      void this.act('批量建租约', () => this.service('POST', '/api/leases/batch', {
        subscriptionId: String(data.get('subscriptionId') || ''),
        keyPrefix: String(data.get('keyPrefix') || '').trim(),
        country: String(data.get('country') || '').trim(),
      }, 90000));
      return;
    }
    if (kind === 'pg-save') {
      void this.act('保存 proxygate', () => this.service('PUT', '/api/config', {
        proxygate: {
          baseUrl: String(data.get('baseUrl') || '').trim(),
          authHeader: String(data.get('authHeader') || '').trim(),
          authValue: String(data.get('authValue') || ''),
          country: String(data.get('country') || '').trim().toUpperCase(),
          socksHost: String(data.get('socksHost') || '').trim(),
          socksPassword: String(data.get('socksPassword') || ''),
          enabled: data.get('enabled') === '1',
        },
      }));
      return;
    }
    if (kind === 'warp-save') {
      void this.act('保存 WARP 池', () => this.service('PUT', '/api/config', {
        warp: {
          enabled: data.get('enabled') === '1',
          endpoints: String(data.get('endpoints') || '').split('\n').map((line) => line.trim()).filter(Boolean),
          cooldownMs: Number(data.get('cooldownMs') || 60000),
        },
      }));
      return;
    }
    if (kind === 'settings-save') {
      void this.act('保存设置', () => this.service('PUT', '/api/config', {
        settings: {
          defaultPort: Number(data.get('defaultPort') || 25001),
          probeUrl: String(data.get('probeUrl') || '').trim(),
          controlDomains: String(data.get('controlDomains') || '').split('\n').map((line) => line.trim()).filter(Boolean),
          primary: String(data.get('primarySlot') || ''),
        },
      }));
      return;
    }
    if (kind === 'cb-add') {
      const events = ['PRE_ROTATION_FREEZE', 'POST_ROTATION_RESUME', 'ROTATION_FAILED', 'LEASE_CHANGED']
        .filter((name) => data.get(name) === '1');
      void this.act('注册回调', () => this.service('POST', '/api/v1/egress/callbacks', {
        clientId: String(data.get('clientId') || '').trim(),
        url: String(data.get('url') || '').trim(),
        events,
      })).then(() => form.reset());
      return;
    }
    if (kind === 'rotate') {
      const mode = String(data.get('mode') || 'nodeUri');
      const body = { reason: String(data.get('reason') || 'manual') };
      if (mode === 'nodeUri') body.nodeUri = String(data.get('nodeUri') || '').trim();
      if (mode === 'nodeId') body.nodeId = String(data.get('nodeId') || '');
      if (mode === 'slotId') body.slotId = String(data.get('slotId') || '').trim();
      const matrixSlotId = this.state.modal ? this.state.modal.matrixSlotId : '';
      if ((mode === 'nodeUri' && !body.nodeUri) || (mode === 'nodeId' && !body.nodeId) || (mode === 'slotId' && !body.slotId)) {
        this.toast('换血目标不能为空', 'error');
        return;
      }
      this.state.modal = null;
      this.renderView();
      void this.act('换血 ' + matrixSlotId, () => this.service(
        'POST',
        '/api/v1/egress/slots/' + encodeURIComponent(matrixSlotId) + '/rotate',
        body,
        120000,
      ));
    }
  }

  onInput(event) {
    const target = event.target;
    if (!target || !target.dataset) return;
    const filter = target.dataset.filter;
    if (!filter) return;
    if (filter === 'q') {
      this.state.filter.q = target.value;
      this.renderView();
      return;
    }
    this.state.filter[filter] = target.value;
    this.renderView();
  }

  /* ---------------------------------------------------------------- */
  /* styles                                                            */
  /* ---------------------------------------------------------------- */

  styles() {
    return `
      :host {
        --oc-bg-base: #0d1117;
        --oc-bg-card: #161b22;
        --oc-bg-elevated: #1f242c;
        --oc-border: #30363d;
        --oc-text-primary: #f0f6fc;
        --oc-text-muted: #8b949e;
        --oc-status-active: #10b981;
        --oc-status-cooldown: #f59e0b;
        --oc-status-quarantine: #ef4444;
        --oc-status-warp: #8b5cf6;
        --oc-accent: #3b82f6;
        --oc-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        --oc-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
        display: block;
        height: 100%;
        min-height: 480px;
        background: var(--oc-bg-base);
        color: var(--oc-text-primary);
        font-family: var(--oc-font-sans);
        font-size: 13px;
        line-height: 1.5;
      }
      * { box-sizing: border-box; }
      button, input, select, textarea { font: inherit; color: inherit; }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-thumb { background: #2b323c; border-radius: 6px; border: 2px solid var(--oc-bg-base); }
      ::-webkit-scrollbar-track { background: transparent; }

      .shell { display: grid; grid-template-columns: 228px minmax(0, 1fr); height: 100%; }

      .rail {
        display: flex; flex-direction: column; gap: 14px;
        padding: 16px 12px 12px;
        border-right: 1px solid var(--oc-border);
        background: linear-gradient(180deg, #0f141b 0%, var(--oc-bg-base) 60%);
        min-height: 0;
      }
      .brand { display: flex; gap: 10px; align-items: center; padding: 4px 8px 10px; }
      .brand-mark {
        width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto;
        display: grid; place-items: center;
        font-weight: 700; font-size: 12px; letter-spacing: .5px;
        color: #fff;
        background: linear-gradient(135deg, var(--oc-accent), var(--oc-status-warp));
        box-shadow: 0 0 0 1px #ffffff14, 0 8px 22px -10px var(--oc-accent);
      }
      .brand-text { display: flex; flex-direction: column; line-height: 1.25; }
      .brand-text strong { font-size: 13px; letter-spacing: .2px; }
      .brand-text span { font-size: 11px; color: var(--oc-text-muted); }

      .nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }
      .nav-item {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px; border: 0; border-radius: 8px;
        background: transparent; color: var(--oc-text-muted);
        cursor: pointer; text-align: left; position: relative;
      }
      .nav-item svg { width: 17px; height: 17px; flex: 0 0 auto; opacity: .85; }
      .nav-item span { flex: 1; }
      .nav-item:hover { background: #ffffff08; color: var(--oc-text-primary); }
      .nav-item.active { background: #ffffff0d; color: var(--oc-text-primary); }
      .nav-item.active::before {
        content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px;
        width: 2px; border-radius: 2px; background: var(--oc-accent);
      }
      .nav-count { font-style: normal; font-size: 11px; color: var(--oc-text-muted); background: #ffffff0a; border-radius: 999px; padding: 0 6px; }
      .nav-item.active .nav-count { color: var(--oc-text-primary); }
      .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 8px 2px; border-top: 1px solid var(--oc-border); }
      .conn { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--oc-text-muted); }
      .conn i { width: 7px; height: 7px; border-radius: 50%; background: var(--oc-status-cooldown); box-shadow: 0 0 0 3px #f59e0b14; }
      .conn.live i { background: var(--oc-status-active); box-shadow: 0 0 0 3px #10b98114; }
      .conn.down i { background: var(--oc-status-quarantine); box-shadow: 0 0 0 3px #ef444414; }
      .rail-meta { display: flex; gap: 8px; font-size: 10.5px; color: var(--oc-text-muted); font-family: var(--oc-font-mono); }

      .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .topbar {
        display: flex; align-items: center; gap: 16px;
        padding: 16px 22px 12px; border-bottom: 1px solid var(--oc-border);
        background: linear-gradient(180deg, #ffffff05, transparent);
      }
      .title-block { min-width: 0; }
      .title-block h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .1px; }
      .title-block p { margin: 2px 0 0; font-size: 12px; color: var(--oc-text-muted); }
      .top-actions { margin-left: auto; display: flex; gap: 8px; }

      .view { flex: 1; overflow-y: auto; padding: 18px 22px 26px; min-height: 0; }
      .statusbar {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 22px; border-top: 1px solid var(--oc-border);
        font-size: 11px; color: var(--oc-text-muted); font-family: var(--oc-font-mono);
        background: #0f141b;
      }
      .statusbar .grow { flex: 1; }
      .dot-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--oc-border); }

      .stack { display: flex; flex-direction: column; gap: 14px; }
      .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }

      .card {
        background: var(--oc-bg-card);
        border: 1px solid var(--oc-border);
        border-radius: 10px;
        padding: 14px 16px;
        min-width: 0;
      }
      .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .card-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .1px; }
      .card-head .muted, .card-head button { margin-left: auto; }
      .muted { color: var(--oc-text-muted); font-size: 11.5px; font-weight: 400; }
      .mono, code, pre { font-family: var(--oc-font-mono); font-size: 11.5px; }

      .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
      .stat {
        background: var(--oc-bg-card); border: 1px solid var(--oc-border);
        border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px;
        position: relative; overflow: hidden;
      }
      .stat::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 2px; background: var(--oc-border); }
      .stat.tone-active::after { background: var(--oc-status-active); }
      .stat.tone-cooldown::after { background: var(--oc-status-cooldown); }
      .stat.tone-quarantine::after { background: var(--oc-status-quarantine); }
      .stat.tone-warp::after { background: var(--oc-status-warp); }
      .stat.tone-rotating::after { background: var(--oc-accent); }
      .stat-label { font-size: 11.5px; color: var(--oc-text-muted); }
      .stat-value { font-size: 24px; font-weight: 600; letter-spacing: -.4px; font-family: var(--oc-font-mono); }
      .stat-hint { font-size: 10.5px; color: #6e7681; }

      .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-bottom: 12px; }
      .kv > div { display: flex; flex-direction: column; gap: 3px; }
      .kv span { font-size: 10.5px; color: var(--oc-text-muted); text-transform: uppercase; letter-spacing: .4px; }
      .kv code { background: var(--oc-bg-elevated); border: 1px solid var(--oc-border); border-radius: 6px; padding: 2px 7px; align-self: flex-start; }

      .copy-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .chip {
        display: inline-flex; align-items: center; gap: 7px; max-width: 100%;
        background: var(--oc-bg-elevated); border: 1px solid var(--oc-border);
        border-radius: 7px; padding: 5px 9px; cursor: pointer;
        font-family: var(--oc-font-mono); font-size: 11px; color: var(--oc-text-primary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .chip svg { width: 13px; height: 13px; opacity: .7; flex: 0 0 auto; }
      .chip:hover { border-color: #4a5462; background: #242b35; }
      .chip.wide { width: 100%; justify-content: flex-start; margin-bottom: 8px; }

      .bars { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
      .bar-row { display: grid; grid-template-columns: 108px 1fr 34px; align-items: center; gap: 10px; }
      .bar-label { font-family: var(--oc-font-mono); font-size: 10.5px; color: var(--oc-text-muted); }
      .bar-track { height: 7px; border-radius: 99px; background: #ffffff0a; overflow: hidden; }
      .bar-track i { display: block; height: 100%; border-radius: 99px; background: var(--oc-accent); transition: width .3s ease; }
      .bar-track i.tone-strict { background: var(--oc-accent); }
      .bar-track i.tone-elastic { background: var(--oc-status-active); }
      .bar-track i.tone-warp { background: var(--oc-status-warp); }
      .bar-value { text-align: right; font-family: var(--oc-font-mono); font-size: 11px; }

      .mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .mini-grid > div { display: flex; flex-direction: column; gap: 2px; background: #0f141b; border: 1px solid var(--oc-border); border-radius: 8px; padding: 8px 10px; }
      .mini-grid span { font-size: 10.5px; color: var(--oc-text-muted); }
      .mini-grid strong { font-size: 12px; font-weight: 600; }

      .timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .timeline li {
        display: flex; align-items: center; gap: 10px;
        padding: 7px 0; border-bottom: 1px dashed #ffffff0a; font-size: 12px;
      }
      .timeline li:last-child { border-bottom: 0; }
      .timeline.tall { max-height: 460px; overflow-y: auto; }
      .event-type { font-family: var(--oc-font-mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--oc-border); color: var(--oc-text-muted); }
      .event-type.tone-active { color: var(--oc-status-active); border-color: #10b98144; }
      .event-type.tone-quarantine { color: var(--oc-status-quarantine); border-color: #ef444444; }
      .event-type.tone-rotating { color: var(--oc-accent); border-color: #3b82f644; }
      .event-type.tone-elastic { color: var(--oc-status-warp); border-color: #8b5cf644; }
      .event-slot { font-family: var(--oc-font-mono); font-size: 11px; }
      .event-detail { color: var(--oc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .event-time { margin-left: auto; color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: 10.5px; }

      .badge {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 10.5px; padding: 2px 7px; border-radius: 999px;
        border: 1px solid var(--oc-border); background: #ffffff06; color: var(--oc-text-muted);
        font-family: var(--oc-font-mono); white-space: nowrap;
      }
      .badge.tone-active { color: var(--oc-status-active); border-color: #10b98144; background: #10b98110; }
      .badge.tone-cooldown { color: var(--oc-status-cooldown); border-color: #f59e0b44; background: #f59e0b10; }
      .badge.tone-quarantine { color: var(--oc-status-quarantine); border-color: #ef444444; background: #ef444410; }
      .badge.tone-warp { color: var(--oc-status-warp); border-color: #8b5cf644; background: #8b5cf610; }
      .badge.tone-rotating { color: var(--oc-accent); border-color: #3b82f644; background: #3b82f610; }
      .badge.tone-strict { color: var(--oc-accent); border-color: #3b82f644; }
      .badge.tone-elastic { color: var(--oc-status-active); border-color: #10b98144; }
      .badge.tone-muted { color: var(--oc-text-muted); }

      .toolbar { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
      .toolbar.card { padding: 12px 14px; }
      .toolbar-meta { margin-left: auto; color: var(--oc-text-muted); font-size: 11px; font-family: var(--oc-font-mono); }

      .btn {
        display: inline-flex; align-items: center; gap: 6px;
        border-radius: 7px; border: 1px solid var(--oc-border);
        background: var(--oc-bg-elevated); color: var(--oc-text-primary);
        padding: 6px 11px; cursor: pointer; font-size: 12px;
        transition: background .12s ease, border-color .12s ease;
        white-space: nowrap;
      }
      .btn svg { width: 14px; height: 14px; }
      .btn:hover { background: #262e38; border-color: #48515e; }
      .btn:disabled { opacity: .45; cursor: not-allowed; }
      .btn.primary { background: var(--oc-accent); border-color: transparent; color: #fff; }
      .btn.primary:hover { background: #2f74e6; }
      .btn.ghost { background: transparent; }
      .btn.ghost:hover { background: #ffffff0a; }
      .btn.small { padding: 4px 8px; font-size: 11px; }
      .btn.danger { color: var(--oc-status-quarantine); border-color: #ef444433; }
      .btn.danger:hover { background: #ef444414; }

      .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(292px, 1fr)); gap: 12px; }
      .slot { display: flex; flex-direction: column; gap: 9px; padding: 13px 14px; position: relative; }
      .slot::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 2px; border-radius: 2px; background: var(--oc-border); }
      .slot.tone-active::before { background: var(--oc-status-active); }
      .slot.tone-cooldown::before { background: var(--oc-status-cooldown); }
      .slot.tone-quarantine::before { background: var(--oc-status-quarantine); }
      .slot.tone-warp::before { background: var(--oc-status-warp); }
      .slot.tone-rotating::before { background: var(--oc-accent); }
      .slot header { display: flex; align-items: center; gap: 8px; }
      .slot-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .slot-id strong { font-family: var(--oc-font-mono); font-size: 12px; letter-spacing: .3px; }
      .port { border: 0; background: transparent; padding: 0; cursor: pointer; color: var(--oc-accent); font-family: var(--oc-font-mono); font-size: 11px; text-align: left; }
      .port:hover { text-decoration: underline; }
      .slot header .badge { margin-left: auto; }
      .slot-key { font-size: 12px; color: var(--oc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .slot-badges { display: flex; flex-wrap: wrap; gap: 5px; }
      .slot-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin: 0; }
      .slot-meta > div { min-width: 0; }
      .slot-meta dt { font-size: 10px; color: var(--oc-text-muted); text-transform: uppercase; letter-spacing: .35px; }
      .slot-meta dd { margin: 0; font-family: var(--oc-font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .slot footer { display: flex; gap: 6px; margin-top: 2px; }
      .slot-json { border-top: 1px dashed #ffffff0d; padding-top: 6px; }
      .slot-json summary { cursor: pointer; font-size: 10.5px; color: var(--oc-text-muted); }
      .slot-json pre { margin: 6px 0 0; padding: 8px; background: #0f141b; border: 1px solid var(--oc-border); border-radius: 6px; overflow-x: auto; }

      .list { display: flex; flex-direction: column; }
      .list.compact .row { padding: 7px 0; }
      .row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ffffff0a; }
      .row:last-child { border-bottom: 0; }
      .row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 240px; }
      .row-main strong { font-size: 12.5px; font-weight: 600; }
      .row-main .mono { color: var(--oc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row-meta { display: flex; flex-wrap: wrap; gap: 5px; }
      .row-actions { display: flex; gap: 6px; margin-left: auto; }

      .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 12px; align-items: end; }
      .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .field.inline { flex: 0 0 auto; }
      .field.grow { flex: 1 1 180px; }
      .field > span, .field > label { font-size: 10.5px; color: var(--oc-text-muted); text-transform: uppercase; letter-spacing: .35px; }
      .field input, .field select, .field textarea {
        width: 100%; background: var(--oc-bg-elevated);
        border: 1px solid var(--oc-border); border-radius: 7px;
        padding: 7px 9px; outline: none; font-size: 12px;
      }
      .field input:focus, .field select:focus, .field textarea:focus {
        border-color: var(--oc-accent); box-shadow: 0 0 0 3px #3b82f61f;
      }
      .field textarea { resize: vertical; font-family: var(--oc-font-mono); font-size: 11.5px; }
      .span-2 { grid-column: span 2; }
      @media (max-width: 640px) { .span-2 { grid-column: span 1; } }
      .check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--oc-text-muted); padding-bottom: 8px; }
      .check input { accent-color: var(--oc-accent); width: 14px; height: 14px; }
      .actions { justify-content: flex-end; flex-direction: row; align-items: end; }
      .actions .btn { width: 100%; justify-content: center; }

      .path-row { display: flex; flex-direction: column; gap: 3px; padding: 7px 0; border-bottom: 1px dashed #ffffff0a; }
      .path-row:last-child { border-bottom: 0; }
      .path-row > span { font-size: 10.5px; color: var(--oc-text-muted); text-transform: uppercase; letter-spacing: .35px; }
      .path-row code { color: var(--oc-text-muted); word-break: break-all; }
      .path-row .chip { align-self: flex-start; }

      .note { margin: 8px 0 0; font-size: 11.5px; color: var(--oc-text-muted); }
      .note.warn { color: var(--oc-status-cooldown); }
      .note.danger { color: var(--oc-status-quarantine); }
      .empty {
        border: 1px dashed var(--oc-border); border-radius: 10px;
        padding: 26px 18px; text-align: center; color: var(--oc-text-muted); font-size: 12px;
      }

      .boot { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 90px 20px; color: var(--oc-text-muted); }
      .boot strong { color: var(--oc-text-primary); font-size: 14px; }
      .boot.error strong { color: var(--oc-status-quarantine); }
      .boot-ring { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--oc-border); border-top-color: var(--oc-accent); animation: spin .9s linear infinite; }
      .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--oc-border); border-top-color: var(--oc-accent); animation: spin .8s linear infinite; display: inline-block; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .toast {
        position: fixed; right: 22px; bottom: 40px; z-index: 40;
        background: var(--oc-bg-elevated); border: 1px solid var(--oc-border);
        border-left: 3px solid var(--oc-accent);
        border-radius: 8px; padding: 9px 14px; font-size: 12px;
        box-shadow: 0 16px 40px -16px #000000cc; max-width: 420px;
      }
      .toast.tone-success { border-left-color: var(--oc-status-active); }
      .toast.tone-error { border-left-color: var(--oc-status-quarantine); }

      .modal-wrap { position: fixed; inset: 0; z-index: 30; background: #010409cc; display: grid; place-items: center; padding: 20px; }
      .modal { width: min(560px, 100%); background: var(--oc-bg-card); border: 1px solid var(--oc-border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 30px 80px -30px #000; max-height: 88vh; overflow-y: auto; }
      .modal form { display: flex; flex-direction: column; gap: 10px; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

      @media (max-width: 860px) {
        .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
        .rail { flex-direction: row; align-items: center; gap: 10px; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--oc-border); overflow-x: auto; }
        .brand { padding: 0 6px 0 0; }
        .brand-text { display: none; }
        .nav { flex-direction: row; gap: 4px; }
        .nav-item { padding: 7px 9px; }
        .nav-item.active::before { display: none; }
        .nav-count { display: none; }
        .rail-foot { margin: 0 0 0 auto; border-top: 0; padding: 0; }
        .rail-meta { display: none; }
        .conn span { display: none; }
        .topbar { padding: 12px 14px 10px; flex-wrap: wrap; }
        .view { padding: 14px; }
        .statusbar { padding: 6px 14px; }
        .statusbar .mono, .statusbar span:nth-child(3) { display: none; }
        .row { flex-wrap: wrap; }
        .row-actions { margin-left: 0; }
      }
    `;
  }
}

if (!customElements.get('egress-matrix-panel')) {
  customElements.define('egress-matrix-panel', EgressMatrixPanel);
}
