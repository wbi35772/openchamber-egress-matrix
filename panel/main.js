/* Egress Matrix — zero-build OpenChamber panel. Classic IIFE on purpose. */
(function () {
  'use strict';

  var CHANNEL = 'openchamber.sdk';
  var WIRE = 1;

  var seq = 0;
  var pending = new Map();
  var connected = false;
  var booted = false;
  var state = { status: null, config: null, error: null, busy: false };
  var toastTimer = null;

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

    renderHero();
    renderLanes();
    renderNodes();
    fillProxygate();
    fillSettings();
    renderPaths();
  }

  function renderHero() {
    var root = document.getElementById('hero');
    clear(root);
    var lane = defaultLane();

    if (!lane) {
      root.appendChild(el('div', { class: 'hero-empty' }, [
        el('div', { class: 'hero-kicker', text: 'NO EGRESS YET' }),
        el('h1', { text: '还没有可用的本机出口' }),
        el('p', { text: '添加一个静态节点，或填好 proxygate 后同步槽位。之后这里的端口就能直接填进任何支持 HTTP / SOCKS5 代理的软件。' }),
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

  function renderLanes() {
    var root = document.getElementById('lanes');
    clear(root);
    var leases = (state.config && state.config.leases) || [];

    if (!leases.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有租约。先添加节点，或同步 proxygate 槽位。' }));
      return;
    }

    leases.forEach(function (lease) {
      var lane = laneFor(lease.id);
      var ok = lane ? lane.ok : lease.ok;
      var port = lane ? lane.port : lease.port;
      var exitIp = (lane && lane.exitIp) || lease.exitIp || '';

      root.appendChild(el('div', { class: 'lane' }, [
        el('div', { class: 'lane-main' }, [
          dot(ok),
          el('div', { class: 'lane-id' }, [
            el('strong', { text: lease.key }),
            el('span', { text: lease.provider + (lease.country ? ' · ' + lease.country : '') }),
          ]),
          el('code', { class: 'lane-port', text: port ? '127.0.0.1:' + port : '端口待分配' }),
          el('span', { class: 'lane-exit mono', text: exitIp || (lane && lane.error) || '—' }),
        ]),
        el('div', { class: 'lane-actions' }, [
          lane ? el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'copy', value: lane.proxy }, text: '复制' }) : null,
          el('button', {
            class: 'ghost sm',
            type: 'button',
            dataset: { act: 'primary', id: lease.id },
            text: '设为主',
          }),
          el('button', {
            class: 'ghost sm',
            type: 'button',
            dataset: { act: 'probe-lease', id: lease.id },
            text: '探测',
          }),
          el('button', {
            class: 'danger sm',
            type: 'button',
            dataset: { act: 'del-lease', id: lease.id },
            text: '删除',
          }),
        ]),
      ]));
    });
  }

  function renderNodes() {
    var root = document.getElementById('nodes');
    clear(root);
    var nodes = (state.config && state.config.nodes) || [];
    if (!nodes.length) {
      root.appendChild(el('p', { class: 'empty', text: '还没有静态节点。粘贴一条节点 URI 即可。' }));
      return;
    }
    nodes.forEach(function (node) {
      var info = node.node || {};
      var check = node.lastCheck;
      root.appendChild(el('div', { class: 'node' }, [
        el('div', { class: 'node-main' }, [
          dot(check ? check.ok : null),
          el('div', { class: 'node-id' }, [
            el('strong', { text: node.name }),
            el('span', { text: (info.protocol || '?') + ' · ' + (info.server || '?') + ':' + (info.port || '?') + (info.wsPath || '') }),
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

  function renderPaths() {
    var root = document.getElementById('paths');
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
        el('button', { class: 'ghost sm', type: 'button', dataset: { act: 'copy', value: pair[1] }, text: '复制路径' }),
      ]));
    });
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                           */
  /* ---------------------------------------------------------------- */

  var actions = {
    refresh: function () {
      return refresh();
    },
    copy: function (button) {
      copyText(button.dataset.value, button.textContent === '复制路径' ? '路径' : '代理地址');
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
      return run('租约已创建', function () {
        return service('POST', '/api/leases', { provider: 'static', nodeId: button.dataset.id, key: key })
          .then(function () { setPrimaryIfFirst(); })
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
  };

  function setPrimaryIfFirst() {
    if (state.config && state.config.settings && state.config.settings.primary) return Promise.resolve();
    return Promise.resolve();
  }

  document.addEventListener('click', function (event) {
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
