/* Egress Matrix console — native Web Component, zero dependencies, scoped CSS. */
'use strict';

const CHANNEL = 'openchamber.sdk';
const WIRE = 1;
const BUS_URL = 'http://127.0.0.1:19880/api/v1/egress';
const WS_URL = BUS_URL.replace(/^http/, 'ws') + '/ws?clientId=openchamber-panel';
const WS_RETRY_MS = 8000;
const TAB_STORAGE_KEY = 'egress-matrix.tab.v2';
const SLOT_VIEW_KEY = 'egress-matrix.slot-view.v1';

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

const HEALTH_RAIL = {
  ACTIVE: 100,
  COOLDOWN: 45,
  QUARANTINED: 6,
  WARP_OVERFLOW: 72,
  ROTATING: 28,
};

function slotIndex(matrixSlotId) {
  const match = /(\d+)$/.exec(String(matrixSlotId || ''));
  return match ? Number(match[1]) : 0;
}

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
    this._ws = null;
    this._wsRetry = null;
    this._pushTimer = null;
    this.state = {
      tab: 'overview',
      config: null,
      matrix: null,
      events: [],
      loading: false,
      error: '',
      busy: '',
      toast: null,
      wsStatus: 'off',
      lastPushAt: 0,
      rotationFreeze: null,
      filter: { health: 'ALL', plane: 'ALL', q: '' },
      nodeFilter: { status: 'ALL', country: 'ALL', subscription: 'ALL', sort: 'name', q: '', page: 1, pageSize: 20 },
      nodePick: new Set(),
      probeConcurrency: 16,
      probeJob: null,
      modal: null,
      slotView: 'cards',
      armed: null,
    };
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
      if (saved && TABS.some((tab) => tab.id === saved)) this.state.tab = saved;
      const savedSlotView = window.localStorage.getItem(SLOT_VIEW_KEY);
      if (['cards', 'list', 'compact'].includes(savedSlotView)) this.state.slotView = savedSlotView;
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
    this.connectWs();
  }

  disconnectedCallback() {
    window.removeEventListener('message', this._onMessage);
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = null;
    if (this._jobTimer) clearInterval(this._jobTimer);
    this._jobTimer = null;
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = null;
    this.closeWs();
  }

  /* ---------------------------------------------------------------- */
  /* live link                                                         */
  /* ---------------------------------------------------------------- */

  /*
   * The WebSocket is an accelerator, never a dependency: when the iframe CSP
   * blocks it, the 15 s poll above stays the source of truth and the panel
   * keeps working with wsStatus = 'fallback'.
   */
  connectWs() {
    this.closeWs();
    if (typeof WebSocket === 'undefined' || !this.isConnected) return;
    let socket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (error) {
      this.state.wsStatus = 'fallback';
      this.renderChrome();
      return;
    }
    this._ws = socket;
    this.state.wsStatus = 'connecting';
    this.renderChrome();
    socket.onopen = () => {
      if (this._ws !== socket) return;
      this.state.wsStatus = 'live';
      this.renderChrome();
    };
    socket.onmessage = (event) => {
      let frame = null;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (error) {
        return;
      }
      this.handleWsFrame(frame);
    };
    socket.onerror = () => {
      if (this._ws !== socket) return;
      this.state.wsStatus = 'fallback';
    };
    socket.onclose = () => {
      if (this._ws !== socket) return;
      this._ws = null;
      if (this.state.wsStatus !== 'off') this.state.wsStatus = 'fallback';
      this.renderChrome();
      if (!this.isConnected) return;
      clearTimeout(this._wsRetry);
      this._wsRetry = setTimeout(() => this.connectWs(), WS_RETRY_MS);
    };
  }

  closeWs() {
    clearTimeout(this._wsRetry);
    this._wsRetry = null;
    const socket = this._ws;
    this._ws = null;
    this.state.wsStatus = 'off';
    if (socket) {
      try { socket.close(1000, 'panel detached'); } catch (error) { /* ignore */ }
    }
  }

  sendWsAck(eventId, ok) {
    const socket = this._ws;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify({ type: 'ACK_FREEZE', eventId, ok: ok !== false }));
      return true;
    } catch (error) {
      return false;
    }
  }

  handleWsFrame(frame) {
    if (!frame || !frame.type) return;
    if (frame.type === 'SLOT_STATE_UPDATED') {
      const slot = frame.slot || {};
      this.mergeSlotState(slot, Boolean(frame.removed));
      this.state.lastPushAt = Date.now();
      this.scheduleRender();
      return;
    }
    if (frame.type === 'PRE_ROTATION_FREEZE') {
      this.state.rotationFreeze = {
        matrixSlotId: frame.matrixSlotId,
        eventId: frame.eventId,
        deadlineMs: Number(frame.deadlineMs) || 0,
        at: Date.now(),
      };
      this.sendWsAck(frame.eventId, true);
      this.mergeSlotState({ matrixSlotId: frame.matrixSlotId, healthState: 'ROTATING' });
      this.toast('槽位 ' + frame.matrixSlotId + ' 冻结，等待换血', 'info');
      this.scheduleRender();
      return;
    }
    if (frame.type === 'POST_ROTATION_RESUME') {
      this.state.rotationFreeze = null;
      this.mergeSlotState({
        matrixSlotId: frame.matrixSlotId,
        healthState: 'ACTIVE',
        leaseId: frame.leaseId,
        egressFingerprint: frame.egressFingerprint,
      });
      this.toast('槽位 ' + frame.matrixSlotId + ' 换血完成', 'success');
      this.scheduleRender();
    }
  }

  mergeSlotState(slot, removed) {
    if (!slot || !slot.matrixSlotId) return;
    const apply = (list, push) => {
      if (!Array.isArray(list)) return list;
      const index = list.findIndex((item) => item.matrixSlotId === slot.matrixSlotId);
      if (removed) {
        if (index >= 0) list.splice(index, 1);
        return list;
      }
      if (index >= 0) list[index] = Object.assign({}, list[index], slot);
      else if (push) list.push(slot);
      list.sort((left, right) => slotIndex(left.matrixSlotId) - slotIndex(right.matrixSlotId));
      return list;
    };
    if (this.state.matrix) this.state.matrix.slots = apply(this.state.matrix.slots || [], true);
    if (this.state.config) this.state.config.slots = apply(this.state.config.slots || [], false);
  }

  scheduleRender() {
    if (this._pushTimer) return;
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this.renderChrome();
      this.renderView();
    }, 120);
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
    const [config, matrix, events, probe] = await Promise.all([
      this.service('GET', '/api/config').catch((error) => { failures.push(error.message); return null; }),
      this.service('GET', '/api/v1/egress/state').catch((error) => { failures.push(error.message); return null; }),
      this.service('GET', '/api/v1/egress/events?limit=120').catch(() => null),
      this.service('GET', '/api/nodes/probe-status').catch(() => null),
    ]);
    this.state.config = config || this.state.config;
    if (this.state.config) {
      const known = new Set((this.state.config.nodes || []).map((node) => node.id));
      for (const id of this.state.nodePick) if (!known.has(id)) this.state.nodePick.delete(id);
    }
    this.state.matrix = matrix || this.state.matrix;
    if (events && Array.isArray(events.events)) this.state.events = events.events.slice().reverse();
    if (probe && probe.job) {
      this.state.probeJob = probe.job;
      if (probe.job.running && !this._jobTimer) this.watchProbeJob(false);
    }
    this.state.loading = false;
    this.state.error = failures.length && !config ? failures.join('；') : '';
    this.renderChrome();
    this.renderView();
  }

  watchProbeJob(immediate) {
    if (this._jobTimer) clearInterval(this._jobTimer);
    const tick = async () => {
      if (!this._connected) return;
      try {
        const data = await this.service('GET', '/api/nodes/probe-status', undefined, 20000);
        this.state.probeJob = data.job || null;
        this.renderChrome();
        this.renderView();
        if (!data.job || !data.job.running) {
          clearInterval(this._jobTimer);
          this._jobTimer = null;
          await this.refresh({ quiet: true });
        }
      } catch (error) { /* next tick retries */ }
    };
    this._jobTimer = setInterval(tick, 1500);
    if (immediate !== false) void tick();
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
      const ws = this.state.wsStatus;
      conn.className = 'conn' + (ok ? ' live' : this.state.error ? ' down' : '');
      const label = ok
        ? (ws === 'live' ? '实时链路已连接' : ws === 'connecting' ? '实时链路握手中' : '本地服务已连接 · 轮询')
        : this.state.error ? '连接异常' : '等待主程序';
      conn.innerHTML = '<i></i><span>' + esc(label) + '</span>'
        + (ok && ws !== 'live' ? '<em class="conn-badge">POLL</em>' : '')
        + (ok && this.state.lastPushAt ? '<em class="conn-badge" title="最近推送">' + esc(fmtTime(this.state.lastPushAt)) + '</em>' : '');
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

  isArmed(act, id) {
    const armed = this.state.armed;
    return Boolean(armed && armed.act === act && armed.id === id && Date.now() - armed.at < 6000);
  }

  viewSlots() {
    const all = this.slots();
    const rows = this.filteredSlots();
    const view = this.state.slotView;
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
      '<div class="seg" role="group" aria-label="显示样式">',
      [['cards', '卡片'], ['list', '列表'], ['compact', '紧凑']].map((pair) => {
        return '<button class="seg-btn' + (view === pair[0] ? ' active' : '') + '" data-act="slot-view" data-view="' + pair[0] + '">' + pair[1] + '</button>';
      }).join(''),
      '</div>',
      '<div class="toolbar-meta">' + rows.length + ' / ' + all.length + ' 条</div>',
      '</div>',
      rows.length ? this.slotBody(rows, view)
        : emptyText(all.length ? '没有符合筛选条件的槽位' : '还没有槽位。到节点池建租约，或在订阅页批量建租约。'),
      '</section>',
    ].join('');
  }

  slotBody(rows, view) {
    if (view === 'list') return this.slotList(rows);
    if (view === 'compact') return this.slotCompact(rows);
    return '<div class="slot-grid">' + rows.map((slot) => this.slotCard(slot)).join('') + '</div>';
  }

  slotActions(slot, dense) {
    const busy = Boolean(this.state.busy);
    const armed = this.isArmed('slot-remove', slot.matrixSlotId);
    const cls = 'btn ghost small' + (dense ? ' icon' : '');
    return [
      '<button class="' + cls + '" data-act="slot-probe" data-slot="' + esc(slot.matrixSlotId) + '" title="探测出口"' + (busy ? ' disabled' : '') + '>' + ICONS.play + (dense ? '' : '探测') + '</button>',
      '<button class="' + cls + '" data-act="slot-rotate" data-slot="' + esc(slot.matrixSlotId) + '" title="蓝绿换血"' + (busy ? ' disabled' : '') + '>' + (dense ? ICONS.refresh : '换血') + '</button>',
      slot.healthState === 'QUARANTINED'
        ? '<button class="' + cls + '" data-act="slot-release" data-slot="' + esc(slot.matrixSlotId) + '" title="解除隔离"' + (busy ? ' disabled' : '') + '>' + ICONS.shield + (dense ? '' : '解除') + '</button>'
        : '<button class="' + cls + ' danger" data-act="slot-quarantine" data-slot="' + esc(slot.matrixSlotId) + '" title="隔离槽位"' + (busy ? ' disabled' : '') + '>' + ICONS.shield + (dense ? '' : '隔离') + '</button>',
      '<button class="' + cls + ' danger' + (armed ? ' armed' : '') + '" data-act="slot-remove" data-slot="' + esc(slot.matrixSlotId) + '" title="删除租约并移除槽位"' + (busy ? ' disabled' : '') + '>' + ICONS.trash + (dense ? '' : (armed ? '确认移除' : '移除')) + '</button>',
    ].join('');
  }

  /*
   * Two rails per card: health availability (contract healthState) and the
   * routing plane the slot is pinned to. Both come straight from the pushed
   * slot record, so a WS update repaints without a full refresh.
   */
  slotRails(slot) {
    const health = String(slot.healthState || 'COOLDOWN').toUpperCase();
    const healthTone = HEALTH_TONE[health] || 'muted';
    const healthPct = HEALTH_RAIL[health] === undefined ? 40 : HEALTH_RAIL[health];
    const plane = String(slot.routingPlane || 'ELASTIC_DATA').toUpperCase();
    const strict = plane === 'STRICT_CONTROL';
    return [
      '<div class="slot-rails">',
      '<div class="slot-rail"><span class="rail-label">健康</span><span class="rail-track"><i class="tone-' + healthTone + '" style="width:' + healthPct + '%"></i></span><span class="rail-value">' + esc(HEALTH_LABEL[health] || health) + '</span></div>',
      '<div class="slot-rail"><span class="rail-label">平面</span><span class="rail-track"><i class="' + (strict ? 'tone-strict' : 'tone-elastic') + '" style="width:' + (strict ? 100 : 64) + '%"></i></span><span class="rail-value">' + (strict ? 'STRICT' : 'ELASTIC') + '</span></div>',
      '</div>',
    ].join('');
  }

  slotCard(slot) {
    const fingerprint = slot.egressFingerprint || {};
    const cooldown = Number(slot.cooldownUntil) > Date.now() ? ' · 至 ' + fmtTime(slot.cooldownUntil) : '';
    return [
      '<article class="slot card tone-' + (HEALTH_TONE[slot.healthState] || 'muted') + '">',
      '<header>',
      '<span class="slot-pulse" aria-hidden="true"></span>',
      '<div class="slot-id"><strong>' + esc(slot.matrixSlotId) + '</strong><button class="port" data-act="copy" data-copy="127.0.0.1:' + esc(slot.egressPort) + '" data-label="端口">127.0.0.1:' + esc(slot.egressPort) + '</button></div>',
      healthBadge(slot.healthState),
      '</header>',
      '<div class="slot-key">' + esc(slot.key || '—') + '</div>',
      '<div class="slot-badges">' + planeBadge(slot.routingPlane) + '<span class="badge tone-muted">' + esc(slot.provider || 'static') + '</span>' + (slot.country ? '<span class="badge tone-muted">' + esc(slot.country) + '</span>' : '') + '</div>',
      this.slotRails(slot),
      '<dl class="slot-meta">',
      '<div><dt>出口 IP</dt><dd>' + esc(fingerprint.exitIp || '待探测') + '</dd></div>',
      '<div><dt>/64</dt><dd title="' + esc(fingerprint.ipv6Prefix64 || '') + '">' + esc(fingerprint.ipv6Prefix64 || '—') + '</dd></div>',
      '<div><dt>ASN</dt><dd>' + esc(fingerprint.asn || '—') + '</dd></div>',
      '<div><dt>leaseId</dt><dd title="' + esc(fingerprint.leaseId || '') + '">' + esc(shortId(fingerprint.leaseId, 16)) + '</dd></div>',
      '</dl>',
      slot.lastError ? '<p class="note ' + (slot.healthState === 'QUARANTINED' ? 'danger' : 'warn') + '">' + esc(slot.lastError) + cooldown + '</p>' : '',
      '<footer>' + this.slotActions(slot, false) + '</footer>',
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

  slotList(rows) {
    return [
      '<div class="card slot-table-card">',
      '<div class="slot-tr slot-tr-head">',
      '<span>槽位</span><span>端口</span><span>健康</span><span>平面</span><span>出口 IP</span><span>国家 / ASN</span><span>租约</span><span class="right">操作</span>',
      '</div>',
      rows.map((slot) => {
        const fp = slot.egressFingerprint || {};
        return [
          '<div class="slot-tr">',
          '<div class="cell-stack"><strong class="mono">' + esc(slot.matrixSlotId) + '</strong><span class="muted nowrap" title="' + esc(slot.key || '') + '">' + esc(slot.key || '—') + '</span></div>',
          '<button class="port" data-act="copy" data-copy="127.0.0.1:' + esc(slot.egressPort) + '" data-label="端口">' + esc(slot.egressPort) + '</button>',
          '<div>' + healthBadge(slot.healthState) + '</div>',
          '<div>' + planeBadge(slot.routingPlane) + '</div>',
          '<span class="mono nowrap">' + esc(fp.exitIp || '待探测') + '</span>',
          '<span class="muted nowrap">' + esc(slot.country || '—') + (fp.asn ? ' · ' + esc(String(fp.asn).split(' ')[0]) : '') + '</span>',
          '<span class="mono muted nowrap" title="' + esc(fp.leaseId || '') + '">' + esc(shortId(fp.leaseId, 14) || '—') + '</span>',
          '<div class="row-actions">' + this.slotActions(slot, true) + '</div>',
          '</div>',
        ].join('');
      }).join(''),
      '</div>',
    ].join('');
  }

  slotCompact(rows) {
    return [
      '<div class="card slot-compact">',
      rows.map((slot) => {
        const fp = slot.egressFingerprint || {};
        return [
          '<div class="compact-row tone-' + (HEALTH_TONE[slot.healthState] || 'muted') + '">',
          '<span class="compact-dot"></span>',
          '<strong class="mono">' + esc(slot.matrixSlotId) + '</strong>',
          '<button class="port" data-act="copy" data-copy="127.0.0.1:' + esc(slot.egressPort) + '" data-label="端口">' + esc(slot.egressPort) + '</button>',
          healthBadge(slot.healthState),
          '<span class="muted compact-key" title="' + esc(slot.key || '') + '">' + esc(slot.key || '—') + '</span>',
          '<span class="mono muted nowrap">' + esc(fp.exitIp || '待探测') + '</span>',
          '<span class="badge tone-muted">' + esc(slot.country || '—') + '</span>',
          '<span class="row-actions">' + this.slotActions(slot, true) + '</span>',
          '</div>',
        ].join('');
      }).join(''),
      '</div>',
    ].join('');
  }

  nodeCheckState(node) {
    const check = node && node.lastCheck;
    if (!check) return 'NEW';
    return check.ok ? 'PASS' : 'FAIL';
  }

  nodeLatency(node) {
    const check = node && node.lastCheck;
    const ms = check && check.ok ? Number(check.latencyMs) : NaN;
    return Number.isFinite(ms) && ms > 0 ? ms : Infinity;
  }

  nodeCountries(nodes) {
    const codes = new Set();
    for (const node of nodes) {
      const check = node.lastCheck;
      const code = check && check.ok ? String(check.countryCode || '').toUpperCase() : '';
      if (code) codes.add(code);
    }
    return [...codes].sort();
  }

  filteredNodes() {
    const nodes = this.state.config.nodes || [];
    const filter = this.state.nodeFilter;
    const query = filter.q.trim().toLowerCase();
    const rows = nodes.filter((node) => {
      const state = this.nodeCheckState(node);
      if (filter.status !== 'ALL' && state !== filter.status) return false;
      if (filter.subscription !== 'ALL' && (node.subscriptionId || '') !== filter.subscription) return false;
      const check = node.lastCheck || {};
      const code = check.ok ? String(check.countryCode || '').toUpperCase() : '';
      if (filter.country !== 'ALL' && code !== filter.country) return false;
      if (!query) return true;
      return [node.name, node.id, check.exitIp, check.countryCode, check.asn, check.country, node.node && node.node.server]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    });
    rows.sort((a, b) => {
      if (filter.sort === 'latency') {
        const left = this.nodeLatency(a);
        const right = this.nodeLatency(b);
        if (left !== right) {
          if (!Number.isFinite(left)) return 1;
          if (!Number.isFinite(right)) return -1;
          return left - right;
        }
      }
      if (filter.sort === 'country') {
        const diff = String((a.lastCheck && a.lastCheck.countryCode) || 'ZZ')
          .localeCompare(String((b.lastCheck && b.lastCheck.countryCode) || 'ZZ'));
        if (diff) return diff;
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return rows;
  }

  latencyBadge(check) {
    if (!check || !check.ok) return '';
    const ms = Number(check.latencyMs);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const tone = ms < 400 ? 'active' : ms < 1200 ? 'cooldown' : 'quarantine';
    return '<span class="badge tone-' + tone + '">' + Math.round(ms) + ' ms</span>';
  }

  nodeById(id) {
    return ((this.state.config && this.state.config.nodes) || []).find((node) => node.id === id) || null;
  }

  nodeTitle(node) {
    if (!node) return '';
    if (node.uri) return node.uri;
    const info = node.node || {};
    return (info.protocol || '?') + '://' + (info.server || '?') + ':' + (info.port || '?');
  }

  nodePageRows(rows) {
    const size = Number(this.state.nodeFilter.pageSize) || 0;
    const pages = size > 0 ? Math.max(1, Math.ceil(rows.length / size)) : 1;
    const page = Math.min(Math.max(1, Number(this.state.nodeFilter.page) || 1), pages);
    const start = size > 0 ? (page - 1) * size : 0;
    return { page, pages, start, size, items: size > 0 ? rows.slice(start, start + size) : rows };
  }

  nodeRow(node, index) {
    const check = node.lastCheck || null;
    const code = check && check.ok ? String(check.countryCode || '').toUpperCase() : '';
    const picked = this.state.nodePick.has(node.id);
    const armed = this.isArmed('node-delete', node.id);
    const busy = Boolean(this.state.busy);
    return [
      '<div class="node-tr' + (picked ? ' picked' : '') + '">',
      '<label class="pick"><input type="checkbox" data-node-pick="' + esc(node.id) + '"' + (picked ? ' checked' : '') + ' /></label>',
      '<span class="col-idx">' + index + '</span>',
      '<div class="node-main">',
      '<div class="node-name"><strong>' + esc(node.name) + '</strong>' + (node.subscriptionId ? '<span class="badge tone-muted">订阅</span>' : '<span class="badge tone-muted">手动</span>') + '</div>',
      '<span class="mono node-uri" title="' + esc(this.nodeTitle(node)) + '">' + esc(this.nodeTitle(node)) + '</span>',
      '</div>',
      '<div class="row-meta">',
      check ? (check.ok ? '<span class="badge tone-active">出口 ' + esc(check.exitIp || '?') + '</span>' : '<span class="badge tone-quarantine" title="' + esc(check.error || '') + '">探测失败</span>') : '<span class="badge tone-muted">未探测</span>',
      this.latencyBadge(check),
      code ? '<span class="badge tone-muted" title="' + esc(check.country || code) + '">' + esc(code) + '</span>' : '',
      check && check.ok && check.asn ? '<span class="badge tone-muted" title="' + esc(check.asn) + '">' + esc(String(check.asn).split(' ')[0]) + '</span>' : '',
      check && check.checkedAt ? '<span class="badge tone-muted">' + esc(ago(Date.parse(check.checkedAt))) + '</span>' : '',
      '</div>',
      '<div class="row-actions">',
      '<button class="btn ghost small" data-act="node-edit" data-node="' + esc(node.id) + '"' + (busy ? ' disabled' : '') + '>编辑</button>',
      '<button class="btn ghost small" data-act="node-probe" data-node="' + esc(node.id) + '"' + (busy ? ' disabled' : '') + '>' + ICONS.play + '探测</button>',
      '<button class="btn ghost small" data-act="node-lease" data-node="' + esc(node.id) + '" data-name="' + esc(node.name) + '"' + (busy ? ' disabled' : '') + '>建租约</button>',
      '<button class="btn ghost small" data-act="node-copy" data-node="' + esc(node.id) + '">复制</button>',
      '<button class="btn ghost small danger' + (armed ? ' armed' : '') + '" data-act="node-delete" data-node="' + esc(node.id) + '"' + (busy ? ' disabled' : '') + '>' + ICONS.trash + (armed ? '确认删除' : '') + '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  nodePager(total, page) {
    const filter = this.state.nodeFilter;
    const sizes = [[20, '20'], [50, '50'], [100, '100'], [0, '全部']];
    return [
      '<div class="pager">',
      '<span class="muted">共 ' + total + ' 条 · 第 ' + page.page + ' / ' + page.pages + ' 页</span>',
      '<label class="field inline"><span>每页</span><select data-node-page-size>',
      sizes.map((pair) => '<option value="' + pair[0] + '"' + (Number(filter.pageSize) === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>').join(''),
      '</select></label>',
      '<button class="btn ghost small" data-act="nodes-page" data-page="' + (page.page - 1) + '"' + (page.page <= 1 ? ' disabled' : '') + '>上一页</button>',
      '<button class="btn ghost small" data-act="nodes-page" data-page="' + (page.page + 1) + '"' + (page.page >= page.pages ? ' disabled' : '') + '>下一页</button>',
      '</div>',
    ].join('');
  }

  viewNodes() {
    const all = this.state.config.nodes || [];
    const rows = this.filteredNodes();
    const subs = this.state.config.subscriptions || [];
    const job = this.state.probeJob;
    const running = Boolean(job && job.running);
    const stats = { PASS: 0, FAIL: 0, NEW: 0 };
    for (const node of all) stats[this.nodeCheckState(node)] += 1;
    const countries = this.nodeCountries(all);
    const filter = this.state.nodeFilter;
    const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
    const page = this.nodePageRows(rows);
    const pageIds = page.items.map((node) => node.id);
    const allPagePicked = pageIds.length > 0 && pageIds.every((id) => this.state.nodePick.has(id));
    const picked = this.state.nodePick.size;
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
      '<div class="toolbar card">',
      '<div class="field inline"><label>订阅</label><select data-node-filter="subscription">',
      '<option value="ALL"' + (filter.subscription === 'ALL' ? ' selected' : '') + '>全部</option>',
      subs.map((sub) => '<option value="' + esc(sub.id) + '"' + (filter.subscription === sub.id ? ' selected' : '') + '>' + esc(sub.name) + '</option>').join(''),
      '</select></div>',
      '<div class="field inline"><label>体检</label><select data-node-filter="status">',
      [['ALL', '全部'], ['PASS', '通过'], ['FAIL', '失败'], ['NEW', '未测']].map((pair) => {
        return '<option value="' + pair[0] + '"' + (filter.status === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>';
      }).join(''),
      '</select></div>',
      '<div class="field inline"><label>国家</label><select data-node-filter="country">',
      '<option value="ALL"' + (filter.country === 'ALL' ? ' selected' : '') + '>全部</option>',
      countries.map((code) => '<option value="' + esc(code) + '"' + (filter.country === code ? ' selected' : '') + '>' + esc(code) + '</option>').join(''),
      '</select></div>',
      '<div class="field inline"><label>排序</label><select data-node-filter="sort">',
      [['name', '名称'], ['latency', '延迟'], ['country', '国家']].map((pair) => {
        return '<option value="' + pair[0] + '"' + (filter.sort === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>';
      }).join(''),
      '</select></div>',
      '<div class="field inline grow"><label>搜索</label><input data-field="node-search" data-node-filter="q" value="' + esc(filter.q) + '" placeholder="名称 / 出口 IP / ASN" /></div>',
      '<div class="toolbar-meta">' + rows.length + ' / ' + all.length + ' 条</div>',
      '<label class="field inline"><span>并发</span><select data-probe-concurrency>',
      [8, 16, 32, 64].map((value) => '<option value="' + value + '"' + (Number(this.state.probeConcurrency) === value ? ' selected' : '') + '>' + value + '</option>').join(''),
      '</select></label>',
      '<button class="btn primary small" data-act="nodes-probe-all"' + (running || this.state.busy ? ' disabled' : '') + '>' + ICONS.play + (running ? '体检中' : '测全池') + '</button>',
      '</div>',
      picked ? [
        '<div class="bulkbar card">',
        '<strong>已选 ' + picked + ' 个节点</strong>',
        '<button class="btn ghost small" data-act="nodes-probe"' + (this.state.busy ? ' disabled' : '') + '>' + ICONS.play + '探测所选</button>',
        '<button class="btn ghost small" data-act="nodes-lease"' + (this.state.busy ? ' disabled' : '') + '>建租约</button>',
        '<button class="btn ghost small" data-act="nodes-copy">复制 URI</button>',
        '<button class="btn ghost small danger' + (this.isArmed('nodes-delete', 'pick') ? ' armed' : '') + '" data-act="nodes-delete"' + (this.state.busy ? ' disabled' : '') + '>' + ICONS.trash + (this.isArmed('nodes-delete', 'pick') ? '确认删除 ' + picked + ' 个' : '删除所选') + '</button>',
        '<button class="btn ghost small" data-act="nodes-pick-filtered">全选筛选结果</button>',
        '<button class="btn ghost small" data-act="nodes-clear">清除选择</button>',
        '</div>',
      ].join('') : '',
      running ? [
        '<div class="probe-strip card">',
        '<div class="probe-head"><strong>节点池体检 ' + esc(job.done) + ' / ' + esc(job.total || '?') + '</strong>',
        '<span class="muted">通过 ' + esc(job.passed) + ' · 失败 ' + esc(job.failed) + '</span></div>',
        '<div class="bar-track"><i class="tone-active" style="width:' + pct + '%"></i></div>',
        '</div>',
      ].join('') : '',
      '<div class="card">',
      '<div class="card-head"><h2>节点池</h2><span class="muted">通过 ' + stats.PASS + ' · 失败 ' + stats.FAIL + ' · 未测 ' + stats.NEW + '</span></div>',
      rows.length ? [
        '<div class="node-table">',
        '<div class="node-tr node-tr-head">',
        '<label class="pick"><input type="checkbox" data-node-all="1"' + (allPagePicked ? ' checked' : '') + ' /></label>',
        '<span class="col-idx">#</span>',
        '<span>节点</span>',
        '<span>状态</span>',
        '<span class="right">操作</span>',
        '</div>',
        page.items.map((node, index) => this.nodeRow(node, page.start + index + 1)).join(''),
        '</div>',
        this.nodePager(rows.length, page),
      ].join('') : emptyText(all.length ? '没有符合筛选条件的节点' : '节点池为空。添加一个节点，或从订阅导入。'),
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
      '<div class="card-head"><h2>批量建租约</h2><span class="muted">默认只取体检通过的节点，可用起始槽位固定端口</span></div>',
      '<form class="form-grid" data-form="sub-batch">',
      '<label class="field"><span>订阅</span><select name="subscriptionId" data-field="batch-sub">',
      subs.length ? subs.map((sub) => '<option value="' + esc(sub.id) + '">' + esc(sub.name) + '（' + esc(sub.nodeCount) + ' 节点）</option>').join('') : '<option value="">先导入订阅</option>',
      '</select></label>',
      '<label class="field"><span>Key 前缀（可选）</span><input name="keyPrefix" data-field="batch-prefix" placeholder="留空用节点名" /></label>',
      '<label class="field"><span>国家（可选）</span><input name="country" data-field="batch-country" placeholder="留空用体检结果" /></label>',
      '<label class="field"><span>起始槽位（可选）</span><input name="startPort" data-field="batch-start" placeholder="slot-010 或 24010" /></label>',
      '<label class="check"><input type="checkbox" name="onlyPassed" value="1" data-field="batch-only-passed" checked /> <span>只取体检通过的节点</span></label>',
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
      '<label class="field"><span>回调 URL</span><input name="url" data-field="cb-url" placeholder="http://127.0.0.1:PORT/rotation" required /></label>',
      '<label class="check"><input type="checkbox" name="PRE_ROTATION_FREEZE" value="1" checked /> <span>PRE_ROTATION_FREEZE</span></label>',
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
    if (modal.type === 'node-edit') {
      const node = this.nodeById(modal.id);
      if (!node) {
        wrap.hidden = true;
        wrap.innerHTML = '';
        return;
      }
      wrap.innerHTML = [
        '<div class="modal">',
        '<div class="card-head"><h2>编辑节点</h2><button class="btn ghost small" data-act="modal-close">关闭</button></div>',
        '<form data-form="node-edit" data-id="' + esc(node.id) + '">',
        '<label class="field"><span>名称</span><input name="name" data-field="edit-node-name" value="' + esc(node.name) + '" /></label>',
        '<label class="field"><span>节点 URI</span><textarea name="uri" rows="4" data-field="edit-node-uri" placeholder="vless://...">' + esc(this.nodeTitle(node)) + '</textarea></label>',
        '<p class="note">保存后会立即重建该节点对应的监听，出口身份可能变化。</p>',
        '<div class="modal-actions">',
        '<button class="btn ghost" type="button" data-act="modal-close">取消</button>',
        '<button class="btn primary" type="submit">保存</button>',
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
    if (act === 'slot-remove') {
      const id = target.dataset.slot;
      if (!this.isArmed('slot-remove', id)) {
        this.state.armed = { act: 'slot-remove', id, at: Date.now() };
        this.renderView();
        this.toast('再点一次「确认移除」会删除 ' + id + ' 的租约并关闭监听', 'info');
        return;
      }
      this.state.armed = null;
      void this.act('移除槽位 ' + id, () => this.service('POST', '/api/v1/egress/slots/' + encodeURIComponent(id) + '/remove', {}, 120000));
      return;
    }
    if (act === 'slot-view') {
      this.state.slotView = target.dataset.view;
      this.state.armed = null;
      try { window.localStorage.setItem(SLOT_VIEW_KEY, this.state.slotView); } catch (error) { /* ignore */ }
      this.renderView();
      return;
    }
    if (act === 'slot-rotate') {
      this.state.modal = { type: 'rotate', matrixSlotId: target.dataset.slot };
      this.renderView();
      return;
    }
    if (act === 'nodes-probe-all') {
      void this.act('节点池体检', () => this.service('POST', '/api/nodes/probe-all', { concurrency: this.state.probeConcurrency }, 20000));
      return;
    }
    if (act === 'node-probe') {
      const id = target.dataset.node;
      void this.act('探测节点', () => this.service('POST', '/api/nodes/' + encodeURIComponent(id) + '/probe', { deep: true }, 90000));
      return;
    }
    if (act === 'node-edit') {
      this.state.modal = { type: 'node-edit', id: target.dataset.node };
      this.renderView();
      return;
    }
    if (act === 'node-copy') {
      const node = this.nodeById(target.dataset.node);
      if (node) this.copy(this.nodeTitle(node), '节点 URI');
      return;
    }
    if (act === 'node-delete') {
      const id = target.dataset.node;
      if (!this.isArmed('node-delete', id)) {
        this.state.armed = { act: 'node-delete', id, at: Date.now() };
        this.renderView();
        this.toast('再点一次「确认删除」会移除该节点及其租约', 'info');
        return;
      }
      this.state.armed = null;
      void this.act('删除节点', () => this.service('DELETE', '/api/nodes/' + encodeURIComponent(id)));
      return;
    }
    if (act === 'nodes-page') {
      this.state.nodeFilter.page = Math.max(1, Number(target.dataset.page) || 1);
      this.renderView();
      return;
    }
    if (act === 'nodes-clear') {
      this.state.nodePick.clear();
      this.state.armed = null;
      this.renderView();
      return;
    }
    if (act === 'nodes-pick-filtered') {
      for (const node of this.filteredNodes()) this.state.nodePick.add(node.id);
      this.renderView();
      return;
    }
    if (act === 'nodes-probe') {
      const ids = Array.from(this.state.nodePick);
      if (!ids.length) return;
      void this.act('探测所选 ' + ids.length + ' 个节点', async () => {
        for (const id of ids) {
          await this.service('POST', '/api/nodes/' + encodeURIComponent(id) + '/probe', { deep: true }, 90000);
        }
      });
      return;
    }
    if (act === 'nodes-lease') {
      const ids = Array.from(this.state.nodePick);
      if (!ids.length) return;
      void this.act('为所选 ' + ids.length + ' 个节点建租约', async () => {
        for (const id of ids) {
          const node = this.nodeById(id);
          await this.service('POST', '/api/leases', {
            nodeId: id,
            key: 'node/' + ((node && node.name) || id),
            primary: false,
          });
        }
      });
      return;
    }
    if (act === 'nodes-copy') {
      const text = Array.from(this.state.nodePick)
        .map((id) => this.nodeTitle(this.nodeById(id)))
        .filter(Boolean)
        .join('\n');
      if (text) this.copy(text, '节点 URI');
      return;
    }
    if (act === 'nodes-delete') {
      const ids = Array.from(this.state.nodePick);
      if (!ids.length) return;
      if (!this.isArmed('nodes-delete', 'pick')) {
        this.state.armed = { act: 'nodes-delete', id: 'pick', at: Date.now() };
        this.renderView();
        this.toast('再点一次「确认删除 ' + ids.length + ' 个」会删除节点及其租约', 'info');
        return;
      }
      this.state.armed = null;
      this.state.nodePick.clear();
      void this.act('删除所选 ' + ids.length + ' 个节点', async () => {
        for (const id of ids) {
          await this.service('DELETE', '/api/nodes/' + encodeURIComponent(id));
        }
      });
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
      const onlyPassed = form && form.onlyPassed ? form.onlyPassed.checked : true;
      const startPort = form && form.startPort ? form.startPort.value.trim() : '';
      const keyPrefix = form && form.keyPrefix ? form.keyPrefix.value.trim() : '';
      void this.act('批量建租约', () => this.service('POST', '/api/leases/batch', {
        subscriptionId: id,
        keyPrefix,
        country,
        startPort,
        onlyPassed,
      }, 120000)).then((result) => {
        if (result && Number(result.skipped) > 0) {
          this.toast('已建 ' + result.created + ' 条，跳过未通过 ' + result.skipped + ' 条', 'info');
        }
      });
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
    if (kind === 'node-edit') {
      const id = form.dataset.id;
      const name = String(data.get('name') || '').trim();
      const uri = String(data.get('uri') || '').trim();
      if (!uri) {
        this.toast('节点 URI 不能为空', 'error');
        return;
      }
      this.state.modal = null;
      this.renderView();
      void this.act('保存节点', () => this.service('PATCH', '/api/nodes/' + encodeURIComponent(id), { name, uri }));
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
        startPort: String(data.get('startPort') || '').trim(),
        onlyPassed: data.get('onlyPassed') === '1',
      }, 120000)).then((result) => {
        if (result && Number(result.skipped) > 0) {
          this.toast('已建 ' + result.created + ' 条，跳过未通过 ' + result.skipped + ' 条', 'info');
        }
      });
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
    const pickId = target.dataset.nodePick;
    if (pickId) {
      if (target.checked) this.state.nodePick.add(pickId);
      else this.state.nodePick.delete(pickId);
      this.renderView();
      return;
    }
    if (target.dataset.nodeAll) {
      for (const node of this.nodePageRows(this.filteredNodes()).items) {
        if (target.checked) this.state.nodePick.add(node.id);
        else this.state.nodePick.delete(node.id);
      }
      this.renderView();
      return;
    }
    if (target.dataset.nodePageSize !== undefined) {
      this.state.nodeFilter.pageSize = Number(target.value);
      this.state.nodeFilter.page = 1;
      this.renderView();
      return;
    }
    if (target.dataset.probeConcurrency !== undefined) {
      this.state.probeConcurrency = Number(target.value) || 16;
      this.renderView();
      return;
    }
    const nodeFilter = target.dataset.nodeFilter;
    if (nodeFilter) {
      this.state.nodeFilter[nodeFilter] = target.value;
      this.state.nodeFilter.page = 1;
      this.renderView();
      return;
    }
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
      .slot-pulse { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--oc-border); opacity: .7; }
      .slot.tone-active .slot-pulse { background: #10b981; opacity: 1; animation: slot-breathe 2.4s ease-in-out infinite; }
      .slot.tone-cooldown .slot-pulse { background: var(--oc-status-cooldown); }
      .slot.tone-quarantine .slot-pulse { background: var(--oc-status-quarantine); }
      .slot.tone-warp .slot-pulse { background: var(--oc-status-warp); }
      .slot.tone-rotating .slot-pulse { background: var(--oc-accent); animation: slot-breathe 1s ease-in-out infinite; }
      @keyframes slot-breathe {
        0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, .55); }
        50% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      }
      .slot-rails { display: grid; gap: 4px; margin: 2px 0 1px; }
      .slot-rail { display: grid; grid-template-columns: 30px minmax(0, 1fr) 62px; align-items: center; gap: 7px; }
      .rail-label { font-size: 9.5px; letter-spacing: .35px; text-transform: uppercase; color: var(--oc-text-muted); }
      .rail-track { position: relative; height: 4px; border-radius: 999px; background: #ffffff12; overflow: hidden; }
      .rail-track i { display: block; height: 100%; border-radius: inherit; background: var(--oc-border); transition: width .25s ease; }
      .rail-track i.tone-active { background: #10b981; }
      .rail-track i.tone-cooldown { background: var(--oc-status-cooldown); }
      .rail-track i.tone-quarantine { background: var(--oc-status-quarantine); }
      .rail-track i.tone-warp { background: var(--oc-status-warp); }
      .rail-track i.tone-rotating { background: var(--oc-accent); }
      .rail-track i.tone-strict { background: #f59e0b; }
      .rail-track i.tone-elastic { background: #38bdf8; }
      .rail-value { font-family: var(--oc-font-mono); font-size: 9.5px; color: var(--oc-text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .conn-badge { margin-left: 6px; padding: 1px 5px; border-radius: 5px; border: 1px solid var(--oc-border); font-size: 9.5px; font-style: normal; color: var(--oc-text-muted); font-family: var(--oc-font-mono); }
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

      .node-table { display: flex; flex-direction: column; overflow-x: auto; }
      .node-tr { display: grid; grid-template-columns: 30px 40px minmax(180px, 1.2fr) minmax(220px, 1fr) 250px; align-items: center; gap: 10px; padding: 8px 6px; border-bottom: 1px solid #ffffff0a; border-radius: 7px; min-width: 760px; }
      .node-tr:last-child { border-bottom: 0; }
      .node-tr.picked { background: #3b82f60d; }
      .node-tr-head { font-size: 10.5px; text-transform: uppercase; letter-spacing: .35px; color: var(--oc-text-muted); border-bottom: 1px solid var(--oc-border); padding-bottom: 6px; }
      .node-tr-head .right, .right { text-align: right; }
      .pick { display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .pick input { accent-color: var(--oc-accent); width: 14px; height: 14px; }
      .col-idx { font-family: var(--oc-font-mono); font-size: 10.5px; color: var(--oc-text-muted); text-align: right; }
      .node-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .node-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .node-name strong { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .node-uri { color: var(--oc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bulkbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-color: #3b82f644; background: #3b82f60a; }
      .bulkbar strong { font-size: 12px; color: var(--oc-accent); }
      .pager { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid #ffffff0a; margin-top: 6px; }
      .pager .muted { margin-right: auto; font-family: var(--oc-font-mono); }
      .nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .seg { display: inline-flex; background: var(--oc-bg-elevated); border: 1px solid var(--oc-border); border-radius: 8px; padding: 2px; gap: 2px; }
      .seg-btn { border: 0; background: transparent; color: var(--oc-text-muted); font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
      .seg-btn:hover { color: var(--oc-text-primary); }
      .seg-btn.active { background: var(--oc-accent); color: #fff; }
      .btn.icon { padding: 4px 6px; }
      .btn.armed { background: #ef444420; border-color: #ef444466; color: #fca5a5; }

      .slot-table-card { padding: 8px 12px; overflow-x: auto; }
      .slot-tr { display: grid; grid-template-columns: 132px 62px 76px 108px minmax(110px, 1fr) 96px 108px auto; align-items: center; gap: 10px; padding: 8px 6px; border-bottom: 1px solid #ffffff0a; min-width: 820px; }
      .slot-tr:last-child { border-bottom: 0; }
      .slot-tr-head { font-size: 10.5px; text-transform: uppercase; letter-spacing: .35px; color: var(--oc-text-muted); border-bottom: 1px solid var(--oc-border); padding-bottom: 6px; }
      .cell-stack { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .cell-stack strong { font-size: 11.5px; }
      .cell-stack .muted { font-size: 10.5px; }
      .slot-tr .row-actions { margin-left: 0; flex-wrap: nowrap; justify-content: flex-end; gap: 4px; }

      .slot-compact { display: flex; flex-direction: column; padding: 4px 10px; overflow-x: auto; }
      .compact-row { display: flex; align-items: center; gap: 8px; padding: 6px 2px; border-bottom: 1px solid #ffffff0a; min-width: 640px; }
      .compact-row:last-child { border-bottom: 0; }
      .compact-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--oc-border); flex: 0 0 auto; }
      .compact-row.tone-active .compact-dot { background: #10b981; animation: slot-breathe 2.4s ease-in-out infinite; }
      .compact-row.tone-cooldown .compact-dot { background: var(--oc-status-cooldown); }
      .compact-row.tone-quarantine .compact-dot { background: var(--oc-status-quarantine); }
      .compact-row.tone-warp .compact-dot { background: var(--oc-status-warp); }
      .compact-row.tone-rotating .compact-dot { background: var(--oc-accent); }
      .compact-row strong.mono { font-size: 11px; width: 76px; flex: 0 0 auto; }
      .compact-row .port { width: 48px; flex: 0 0 auto; }
      .compact-key { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
      .compact-row .row-actions { margin-left: auto; flex-wrap: nowrap; }

      .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; align-items: end; }
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
      @media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } .span-2 { grid-column: span 1; } }
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
      .modal-wrap[hidden] { display: none; }
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
        .node-table { overflow-x: auto; }
        .node-tr { min-width: 720px; }
      }
    `;
  }
}

if (!customElements.get('egress-matrix-panel')) {
  customElements.define('egress-matrix-panel', EgressMatrixPanel);
}
