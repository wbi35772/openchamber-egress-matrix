/* Egress Matrix — zero-build OpenChamber panel. Classic IIFE on purpose. */
(function () {
  'use strict';

  var CHANNEL = 'openchamber.sdk';
  var WIRE = 1;
  var TAB_KEY = 'egress-matrix.tab';

  var seq = 0;
  var pending = new Map();
  var connected = false;
  var booted = false;
  var state = { status: null, config: null, error: null, busy: false, tab: 'overview' };
  var toastTimer = null;

  try {
    var saved = window.localStorage.getItem(TAB_KEY);
    if (saved) state.tab = saved;
  } catch (error) { /* private mode */ }

  /* ---------------------------------------------------------------- */
  /* host bridge                                                       */
  /* ---------------------------------------------------------------- */

  function post(type, payload, id) {
    var message = { channel: CHANNEL, v: WIRE, type: type };
    if (id !== undefined) message.id = id;
    if (payload !== undefined) message.payload = payload;
    try { window.parent.postMessage(message, '*'); } catch (error) { /* parent gone */ }
  }

  function call(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'g' + (++seq);
      var timer = setTimeout(function () {
        pending.delete(id);
        var error = new Error('OpenChamber 主程序没有响应');
        error.code = 'HOST_TIMEOUT';
        reject(error);
      }, timeoutMs || 20000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post(type, payload, id);
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.v !== WIRE) return;
    if (data.type === 'result') {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: data.ok !== false, payload: data.payload, error: data.error, code: data.code });
      return;
    }
    if (data.type === 'ready') {
      connected = true;
      if (!booted) {
        booted = true;
        refresh();
      }
    }
  });

  var CODE_HINTS = {
    HOST_TIMEOUT: 'OpenChamber 主程序响应超时，稍后重试',
    HOST_UNAVAILABLE: 'OpenChamber 主程序不可用',
    NO_SERVICE: '本地服务未启动或未授权：到 设置 → 扩展 → Egress Matrix 允许本地服务',
    SERVICE_FAILED: '本地服务启动失败：检查扩展日志后重试',
  };

  function hostError(result) {
    var hint = CODE_HINTS[result.code];
    var error = new Error(hint || result.error || '请求失败');
    error.code = result.code;
    return error;
  }

  function service(method, path, body, timeoutMs) {
    var payload = { method: method, path: path };
    if (body !== undefined) payload.body = JSON.stringify(body);
    return call('service-request', payload, timeoutMs || 45000).then(function (result) {
      if (!result.ok) throw hostError(result);
      var envelope = result.payload || {};
      var data = null;
      if (envelope.body) {
        try { data = JSON.parse(envelope.body); } catch (error) { data = { raw: String(envelope.body) }; }
      }
      if (envelope.status >= 400 || (data && data.ok === false)) {
        var detail = (data && data.error) || {};
        var failure = new Error(detail.message || ('本地服务返回 HTTP ' + envelope.status));
        failure.code = detail.code || ('http_' + envelope.status);
        failure.status = envelope.status;
        throw failure;
      }
      return data;
    });
  }

  function copyText(text, label) {
    var value = String(text == null ? '' : text);
    if (!value) return;
    call('clipboard-write', { text: value }, 5000).then(function (result) {
      if (result.ok) toast(label ? label + '已复制' : '已复制', 'success');
      else throw new Error(result.error || '复制失败');
    }).catch(function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          toast(label ? label + '已复制' : '已复制', 'success');
        }).catch(function () { toast('复制失败', 'error'); });
      } else {
        toast('复制失败', 'error');
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* dom helpers                                                       */
  /* ---------------------------------------------------------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'class') node.className = attrs[key];
        else if (key === 'dataset') Object.assign(node.dataset, attrs[key]);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
        else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function dot(ok) {
    var cls = ok === true ? 'ok' : ok === false ? 'bad' : 'idle';
    return el('span', { class: 'dot ' + cls });
  }

  function fmtTime(value) {
    if (!value) return '未探测';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function fmtDateTime(value) {
    if (!value) return '尚未同步';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function toast(message, tone) {
    var node = document.getElementById('toast');
    node.textContent = message;
    node.className = 'toast ' + (tone || 'neutral');
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2800);
  }

  function setBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle('busy', busy);
  }

  function run(label, task) {
    if (state.busy) return Promise.resolve(null);
    setBusy(true);
    return Promise.resolve()
      .then(task)
      .then(function (result) {
        if (label) toast(label, 'success');
        return result;
      })
      .catch(function (error) {
        toast(error.message || String(error), 'error');
        return null;
      })
      .finally(function () { setBusy(false); });
  }

  /* ---------------------------------------------------------------- */
  /* data                                                              */
  /* ---------------------------------------------------------------- */

  function refresh() {
    return Promise.resolve()
      .then(function () {
        return Promise.all([
          service('GET', '/api/status', undefined, 30000).catch(function (error) {
            if (error.code === 'NO_SERVICE') state.error = error;
            throw error;
          }),
          service('GET', '/api/config', undefined, 30000),
        ]);
      })
      .then(function (results) {
        state.status = results[0];
        state.config = results[1];
        state.error = null;
        render();
      })
      .catch(function (error) {
        state.error = error;
        render();
      });
  }

  function lanes() {
    return (state.status && state.status.engine && state.status.engine.lanes) || [];
  }

  function laneFor(leaseId) {
    return lanes().find(function (lane) { return lane.leaseId === leaseId; }) || null;
  }

  function defaultLane() {
    return lanes().find(function (lane) { return lane.kind === 'default'; }) || null;
  }

  function nodeById(id) {
    return ((state.config && state.config.nodes) || []).find(function (node) { return node.id === id; }) || null;
  }

  function nodeLabel(nodeId) {
    var node = nodeById(nodeId);
    return node ? node.name : '外部槽位';
  }

  function subLabel(id) {
    var sub = ((state.config && state.config.subscriptions) || []).find(function (item) { return item.id === id; }) || null;
    return sub ? sub.name : '';
  }

  /* ---------------------------------------------------------------- */
  /* render                                                            */
  /* ---------------------------------------------------------------- */

  function render() {
    var banner = document.getElementById('banner');
    if (state.error) {
      banner.hidden = false;
      banner.textContent = state.error.message;
      banner.className = 'banner ' + (state.error.code === 'NO_SERVICE' ? 'warn' : 'bad');
    } else {
      banner.hidden = true;
    }

    var version = (state.status && state.status.version) || '0.1.0';
    document.getElementById('version-pill').textContent = 'v' + version;
    document.getElementById('foot-note').textContent = state.config
      ? '装入即用 · ' + state.config.dataDir
      : '装入即用 · 无外部配置文件';
    document.getElementById('foot-state').textContent = state.busy ? '处理中…' : '';

    renderTabs();
    renderSummary();
    renderHero();
    renderOverviewLanes();
    renderPaths('overview-paths');
    renderPaths('paths');
    renderOverviewNote();
    renderLeases();
    fillLeaseForm();
    renderNodes();
    renderSubscriptions();
    fillProxygate();
    fillSettings();
  }

  function renderTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var index = 0; index < tabs.length; index += 1) {
      var active = tabs[index].dataset.tab === state.tab;
      tabs[index].classList.toggle('active', active);
      tabs[index].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    var views = document.querySelectorAll('.view');
    for (var view = 0; view < views.length; view += 1) {
      views[view].hidden = views[view].dataset.view !== state.tab;
    }
  }

  function setTab(tab) {
    state.tab = tab;
    try { window.localStorage.setItem(TAB_KEY, tab); } catch (error) { /* ignore */ }
    renderTabs();
  }

  function renderSummary() {
    var root = document.getElementById('summary');
    clear(root);
    var config = state.config;
    if (!config) return;
    var live = lanes().filter(function (lane) { return lane.ok === true; }).length;
    var leases = config.leases || [];
    var nodes = config.nodes || [];
    var subs = config.subscriptions || [];
    [
      ['租约', String(leases.length)],
      ['在线线路', String(live)],
      ['节点', String(nodes.length)],
      ['订阅', String(subs.length)],
    ].forEach(function (pair) {
      root.appendChild(el('div', { class: 'summary-item' }, [
        el('span', { class: 'summary-label', text: pair[0] }),
        el('strong', { class: 'summary-value', text: pair[1] }),
      ]));
    });
  }

  function renderHero() {
    var root = document.getElementById('hero');
    clear(root);
    var lane = defaultLane();

    if (!lane) {
      root.appendChild(el('div', { class: 'hero-empty' }, [
        el('div', { class: 'hero-kicker', text: 'NO EGRESS YET' }),
        el('h1', { text: '还没有可用的本机出口' }),
        el('p', { text: '添加一个静态节点、导入订阅，或填好 proxygate 后同步槽位。之后这里的端口就能直接填进任何支持 HTTP / SOCKS5 代理的软件。' }),
      ]));
      return;
    }

    var copyProxy = el('button', {
      class: 'primary',
      type: 'button',
      dataset: { act: 'copy', value: lane.proxy },
      text: '复制 HTTP',
    });
    var copySocks = el('button', {
      class: 'ghost',
      type: 'button',
      dataset: { act: 'copy', value: lane.socks },
      text: '复制 SOCKS5',
    });

    root.appendChild(el('div', { class: 'hero-left' }, [
      el('div', { class: 'hero-kicker' }, [
        dot(lane.ok),
        el('span', { text: 'DEFAULT GATEWAY' }),
        lane.country ? el('span', { class: 'chip', text: lane.country }) : null,
      ]),
      el('div', { class: 'hero-port' }, [
        el('span', { class: 'mono', text: '127.0.0.1' }),
        el('span', { class: 'colon', text: ':' }),
        el('strong', { text: String(lane.port) }),
      ]),
      el('div', { class: 'hero-urls' }, [
        el('code', { text: lane.proxy }),
        el('code', { text: lane.socks }),
      ]),
      el('div', { class: 'hero-actions' }, [copyProxy, copySocks]),
    ]));

    root.appendChild(el('div', { class: 'hero-right' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label', text: '出口 IP' }),
        el('strong', { class: 'mono', text: lane.exitIp || '—' }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label', text: '最近探测' }),
        el('strong', { text: fmtTime(lane.checkedAt) }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label', text: '连接 / 活跃' }),
        el('strong', { class: 'mono', text: String((lane.stats && lane.stats.connections) || 0) + ' / ' + String((lane.stats && lane.stats.active) || 0) }),
      ]),
      lane.error ? el('div', { class: 'hero-error', text: lane.error }) : null,
    ]));
  }

  function laneRow(lease, options) {
    var lane = laneFor(lease.id);
    var ok = lane ? lane.ok : lease.ok;
    var port = lane ? lane.port : lease.port;
    var exitIp = (lane && lane.exitIp) || lease.exitIp || '';
    var actions = [];

    if (lane) {
      actions.push(el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'copy', value: lane.proxy }, text: '复制' }));
      actions.push(el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'copy-socks', value: lane.socks }, text: 'SOCKS' }));
    }
    if (options && options.full) {
      actions.push(el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'port-lease', id: lease.id, port: String(lease.port || '') }, text: '端口' }));
      actions.push(el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'primary', id: lease.id }, text: '设为主' }));
      actions.push(el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'probe-lease', id: lease.id }, text: '探测' }));
      actions.push(el('button', { class: 'danger sm', type: 'button', dataset: { act: 'del-lease', id: lease.id }, text: '删除' }));
    }

    return el('div', { class: 'lane' }, [
      el('div', { class: 'lane-main' }, [
        dot(ok),
        el('div', { class: 'lane-id' }, [
          el('strong', { text: lease.key }),
          el('span', { text: lease.provider + (lease.country ? ' · ' + lease.country : '') + ' · ' + nodeLabel(lease.nodeId) }),
        ]),
        el('code', { class: 'lane-port', text: port ? '127.0.0.1:' + port : '端口待分配' }),
        el('span', { class: 'lane-exit mono', text: exitIp || (lane && lane.error) || '—' }),
      ]),
      actions.length ? el('div', { class: 'lane-actions' }, actions) : null,
    ]);
  }

  function renderOverviewLanes() {
    var root = document.getElementById('overview-lanes');
    clear(root);
    var leases = (state.config && state.config.leases) || [];
    if (!leases.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有租约。先添加节点或导入订阅。' }));
      return;
    }
    leases.slice(0, 6).forEach(function (lease) { root.appendChild(laneRow(lease, { full: false })); });
    if (leases.length > 6) {
      root.appendChild(el('p', { class: 'hint', text: '还有 ' + (leases.length - 6) + ' 条线路，去「出口线路」查看全部。' }));
    }
  }

  function renderLeases() {
    var root = document.getElementById('leases');
    clear(root);
    var leases = (state.config && state.config.leases) || [];
    if (!leases.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有租约。先添加节点，或同步 proxygate 槽位。' }));
      return;
    }
    leases.forEach(function (lease) { root.appendChild(laneRow(lease, { full: true })); });
  }

  function fillLeaseForm() {
    var form = document.getElementById('lease-form');
    if (!form) return;
    var select = form.elements.nodeId;
    var nodes = (state.config && state.config.nodes) || [];
    var current = select.value;
    clear(select);
    nodes.forEach(function (node) {
      select.appendChild(el('option', { value: node.id, text: node.name }));
    });
    if (!nodes.length) select.appendChild(el('option', { value: '', text: '先添加节点' }));
    if (current && nodes.some(function (node) { return node.id === current; })) select.value = current;
  }

  function renderNodes() {
    var root = document.getElementById('nodes');
    clear(root);
    var nodes = (state.config && state.config.nodes) || [];
    var count = document.getElementById('node-count');
    if (count) count.textContent = nodes.length + ' 个';
    if (!nodes.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有节点。粘贴一条节点 URI，或去「订阅」整池导入。' }));
      return;
    }
    nodes.forEach(function (node) {
      var info = node.node || {};
      var check = node.lastCheck;
      var source = node.subscriptionId ? '订阅 · ' + subLabel(node.subscriptionId) : '手动';
      root.appendChild(el('div', { class: 'node' }, [
        el('div', { class: 'node-main' }, [
          dot(check ? check.ok : null),
          el('div', { class: 'node-id' }, [
            el('strong', { text: node.name }),
            el('span', { text: source + ' · ' + (info.protocol || '?') + ' · ' + (info.server || '?') + ':' + (info.port || '?') + (info.wsPath || '') }),
          ]),
          el('span', { class: 'node-exit mono', text: (check && check.exitIp) || '未探测' }),
        ]),
        el('div', { class: 'node-actions' }, [
          el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'probe-node', id: node.id }, text: '测试' }),
          el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'lease-node', id: node.id, name: node.name }, text: '建租约' }),
          el('button', { class: 'danger sm', type: 'button', dataset: { act: 'del-node', id: node.id }, text: '删除' }),
        ]),
      ]));
    });
  }

  function renderSubscriptions() {
    var root = document.getElementById('subscriptions');
    clear(root);
    var subs = (state.config && state.config.subscriptions) || [];
    if (!subs.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有订阅。填一个订阅 URL 后整池导入节点。' }));
      return;
    }
    subs.forEach(function (sub) {
      root.appendChild(el('div', { class: 'node sub' }, [
        el('div', { class: 'node-main' }, [
          dot(sub.lastError ? false : (sub.nodeCount ? true : null)),
          el('div', { class: 'node-id' }, [
            el('strong', { text: sub.name }),
            el('span', { text: sub.url }),
            el('span', {
              class: sub.lastError ? 'sub-error' : '',
              text: '节点 ' + sub.nodeCount + ' · 租约 ' + sub.leaseCount + ' · ' + fmtDateTime(sub.lastSyncAt) + (sub.lastError ? ' · ' + sub.lastError : ''),
            }),
          ]),
        ]),
        el('div', { class: 'node-actions' }, [
          el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'sub-sync', id: sub.id }, text: '同步' }),
          el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'sub-leases', id: sub.id, prefix: sub.keyPrefix || '', name: sub.name }, text: '批量建租约' }),
          el('button', { class: 'danger sm', type: 'button', dataset: { act: 'del-sub', id: sub.id }, text: '删除' }),
        ]),
      ]));
    });
  }

  function fillProxygate() {
    var config = state.config && state.config.proxygate;
    if (!config) return;
    var form = document.getElementById('pg-form');
    form.elements.baseUrl.value = config.baseUrl || '';
    form.elements.socksHost.value = config.socksHost || '';
    form.elements.country.value = config.country || '';
    form.elements.authValue.value = '';
    form.elements.authValue.placeholder = config.authValue ? '已保存（留空保持不变）' : 'API Key';
    form.elements.socksPassword.value = '';
    form.elements.socksPassword.placeholder = config.socksPassword ? '已保存（留空保持不变）' : 'SOCKS 密码';
  }

  function fillSettings() {
    var settings = state.config && state.config.settings;
    if (!settings) return;
    var form = document.getElementById('settings-form');
    form.elements.defaultPort.value = settings.defaultPort;
    form.elements.portBase.value = settings.portBase;
    form.elements.portSize.value = settings.portSize;
    form.elements.probeUrl.value = settings.probeUrl || '';
  }

  function renderPaths(targetId) {
    var root = document.getElementById(targetId);
    if (!root) return;
    clear(root);
    var files = (state.config && state.config.files) || {};
    if (!files.endpoints) return;
    [
      ['共享契约', files.endpoints],
      ['纯文本列表', files.proxies],
    ].forEach(function (pair) {
      root.appendChild(el('div', { class: 'path-row' }, [
        el('span', { class: 'path-label', text: pair[0] }),
        el('code', { text: pair[1] }),
        el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'copy-path', value: pair[1] }, text: '复制' }),
      ]));
    });
  }

  function renderOverviewNote() {
    var note = document.getElementById('overview-note');
    if (!note) return;
    var endpoints = state.status && state.status.endpoints;
    if (!endpoints) {
      note.textContent = '契约文件尚未生成：添加租约后自动写入。';
      return;
    }
    var lanesList = endpoints.lanes || [];
    var okCount = lanesList.filter(function (item) { return item.ok === true; }).length;
    note.textContent = '更新于 ' + fmtDateTime(endpoints.updatedAt) + ' · 在线 ' + okCount + '/' + lanesList.length + ' 条。';
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                           */
  /* ---------------------------------------------------------------- */

  var actions = {
    refresh: function () {
      return refresh();
    },
    copy: function (button) {
      copyText(button.dataset.value, '代理地址');
    },
    'copy-socks': function (button) {
      copyText(button.dataset.value, 'SOCKS5 地址');
    },
    'copy-path': function (button) {
      copyText(button.dataset.value, '路径');
    },
    'pg-sync': function () {
      return run('槽位已同步', function () {
        return service('POST', '/api/proxygate/sync', {}, 90000).then(function (result) {
          document.getElementById('pg-result').textContent =
            '槽位 ' + result.slots + ' · 新增 ' + result.added + ' · 更新 ' + result.updated + ' · 移除 ' + result.removed;
          return refresh();
        });
      });
    },
    'pg-allocate': function () {
      var config = state.config && state.config.proxygate;
      var country = window.prompt('按国家分配（留空用默认）', (config && config.country) || '');
      if (country === null) return null;
      return run('已分配槽位', function () {
        return service('POST', '/api/proxygate/allocate', { country: country.trim() }, 90000).then(function (result) {
          document.getElementById('pg-result').textContent = '槽位 ' + (result.lease && result.lease.key ? result.lease.key : '已创建');
          return refresh();
        });
      });
    },
    'pg-rotate': function () {
      var slotId = window.prompt('要换 IP 的槽位 ID', '');
      if (!slotId) return null;
      return run('已请求换 IP', function () {
        return service('POST', '/api/proxygate/rotate', { slotId: slotId.trim() }, 90000).then(function (result) {
          document.getElementById('pg-result').textContent = '槽位 ' + slotId + ' → ' + ((result.slot && (result.slot.exitIp || result.slot.activeIp)) || '已轮换');
          return refresh();
        });
      });
    },
    'probe-node': function (button) {
      return run('节点可用', function () {
        return service('POST', '/api/nodes/' + encodeURIComponent(button.dataset.id) + '/probe', {}, 60000)
          .then(refresh);
      });
    },
    'del-node': function (button) {
      if (!window.confirm('删除这个节点？引用它的租约也会移除。')) return null;
      return run('节点已删除', function () {
        return service('DELETE', '/api/nodes/' + encodeURIComponent(button.dataset.id))
          .then(refresh);
      });
    },
    'lease-node': function (button) {
      var key = window.prompt('租约 key（给其他扩展用）', 'node/' + button.dataset.name);
      if (key === null) return null;
      var port = window.prompt('指定端口（留空自动分配）', '');
      if (port === null) return null;
      var body = { provider: 'static', nodeId: button.dataset.id, key: key };
      if (port.trim()) body.port = Number(port.trim());
      return run('租约已创建', function () {
        return service('POST', '/api/leases', body).then(refresh);
      });
    },
    'port-lease': function (button) {
      var port = window.prompt('新端口（留空取消）', button.dataset.port || '');
      if (!port) return null;
      return run('端口已更新', function () {
        return service('PATCH', '/api/leases/' + encodeURIComponent(button.dataset.id), { port: Number(port) })
          .then(refresh);
      });
    },
    primary: function (button) {
      return run('已设为主出口', function () {
        return service('PATCH', '/api/leases/' + encodeURIComponent(button.dataset.id), { primary: true })
          .then(refresh);
      });
    },
    'probe-lease': function (button) {
      return run('出口可用', function () {
        return service('POST', '/api/leases/' + encodeURIComponent(button.dataset.id) + '/probe', {}, 60000)
          .then(refresh);
      });
    },
    'del-lease': function (button) {
      if (!window.confirm('删除这个租约？对应端口会立即关闭。')) return null;
      return run('租约已删除', function () {
        return service('DELETE', '/api/leases/' + encodeURIComponent(button.dataset.id))
          .then(refresh);
      });
    },
    'sub-sync': function (button) {
      return run('订阅已同步', function () {
        return service('POST', '/api/subscriptions/' + encodeURIComponent(button.dataset.id) + '/sync', {}, 90000)
          .then(function (result) {
            var stats = result.result || {};
            toast('新增 ' + (stats.added || 0) + ' · 更新 ' + (stats.updated || 0) + ' · 租约 ' + (stats.createdLeases || 0), 'success');
            return refresh();
          });
      });
    },
    'sub-leases': function (button) {
      var prefix = window.prompt('租约 key 前缀', button.dataset.prefix || 'sub/' + button.dataset.name);
      if (prefix === null) return null;
      var start = window.prompt('起始端口（留空自动分配）', '');
      if (start === null) return null;
      var body = { keyPrefix: prefix.trim() };
      if (start.trim()) body.startPort = Number(start.trim());
      return run('已批量建租约', function () {
        return service('POST', '/api/subscriptions/' + encodeURIComponent(button.dataset.id) + '/leases', body, 60000)
          .then(function (result) {
            toast('新建租约 ' + (result.created || 0), 'success');
            return refresh();
          });
      });
    },
    'del-sub': function (button) {
      if (!window.confirm('删除这个订阅？它导入的节点和租约都会移除，手动节点不受影响。')) return null;
      return run('订阅已删除', function () {
        return service('DELETE', '/api/subscriptions/' + encodeURIComponent(button.dataset.id))
          .then(refresh);
      });
    },
    reconcile: function () {
      return run('已重新协调', function () {
        return service('POST', '/api/reconcile', {}, 60000).then(refresh);
      });
    },
    'probe-all': function () {
      return run('探测完成', function () {
        return service('POST', '/api/probe', {}, 120000).then(refresh);
      });
    },
  };

  document.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-tab]');
    if (tab) {
      event.preventDefault();
      setTab(tab.dataset.tab);
      return;
    }
    var button = event.target.closest('[data-act]');
    if (!button) return;
    var handler = actions[button.dataset.act];
    if (!handler) return;
    event.preventDefault();
    handler(button);
  });

  document.getElementById('node-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var uri = String(form.elements.uri.value || '').trim();
    if (!uri) return;
    run('节点已添加', function () {
      return service('POST', '/api/nodes', { name: String(form.elements.name.value || '').trim(), uri: uri })
        .then(function () {
          form.reset();
          return refresh();
        });
    });
  });

  document.getElementById('lease-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var nodeId = String(form.elements.nodeId.value || '');
    if (!nodeId) {
      toast('先添加节点', 'error');
      return;
    }
    var body = {
      provider: 'static',
      nodeId: nodeId,
      key: String(form.elements.key.value || '').trim(),
      country: String(form.elements.country.value || '').trim(),
    };
    var port = String(form.elements.port.value || '').trim();
    if (port) body.port = Number(port);
    run('租约已创建', function () {
      return service('POST', '/api/leases', body).then(function () {
        form.elements.key.value = '';
        form.elements.port.value = '';
        form.elements.country.value = '';
        return refresh();
      });
    });
  });

  document.getElementById('sub-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var url = String(form.elements.url.value || '').trim();
    if (!url) return;
    run('订阅已导入', function () {
      return service('POST', '/api/subscriptions', {
        name: String(form.elements.name.value || '').trim(),
        url: url,
        keyPrefix: String(form.elements.keyPrefix.value || '').trim(),
        autoLease: Boolean(form.elements.autoLease.checked),
      }, 90000).then(function (result) {
        if (!result.synced) toast('订阅已保存但同步失败：' + ((result.result && result.result.error) || '未知错误'), 'error');
        form.reset();
        return refresh();
      });
    });
  });

  document.getElementById('pg-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var patch = {
      baseUrl: String(form.elements.baseUrl.value || '').trim(),
      socksHost: String(form.elements.socksHost.value || '').trim(),
      country: String(form.elements.country.value || '').trim(),
      enabled: true,
    };
    var key = String(form.elements.authValue.value || '').trim();
    var socksPassword = String(form.elements.socksPassword.value || '').trim();
    if (key) patch.authValue = key;
    if (socksPassword) patch.socksPassword = socksPassword;
    run('proxygate 配置已保存', function () {
      return service('PUT', '/api/config', { proxygate: patch }).then(refresh);
    });
  });

  document.getElementById('settings-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var patch = {
      defaultPort: Number(form.elements.defaultPort.value),
      portBase: Number(form.elements.portBase.value),
      portSize: Number(form.elements.portSize.value),
      probeUrl: String(form.elements.probeUrl.value || '').trim(),
    };
    run('监听配置已保存', function () {
      return service('PUT', '/api/config', { settings: patch }).then(refresh);
    });
  });

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  render();
  post('ready?', {});
  setTimeout(function () {
    if (!booted) {
      booted = true;
      refresh();
    }
  }, 1200);
})();
