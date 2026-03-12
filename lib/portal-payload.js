// PodBay Portal — plugin-enabled payload
// Injected into every renderer window via ASAR patch.
// Provides require() polyfill, plugin loading, and broker tools.
;(function () {
  'use strict';

  if (window.__podBayInstalled) return;
  window.__podBayInstalled = true;

  // ── Require Polyfill (from jerroldneal/require-extension) ──────────────
  // Provides Node.js-style require() in the renderer main world.
  // Uses sync XHR for HTTP/HTTPS URLs. Local file paths require the
  // podbay-file:// protocol registered by the main process patch.
  ;(function () {
    if (typeof window.require === 'function') return;

    var moduleCache = {};
    var moduleStack = [];

    function resolvePath(requestPath, fromPath) {
      if (/^[a-z]+:\/\//i.test(requestPath) || requestPath.indexOf('data:') === 0) return requestPath;
      if (requestPath.charAt(0) === '.' && (requestPath.charAt(1) === '/' || requestPath.substr(0, 3) === '../')) {
        var base = fromPath || window.location.href;
        return new URL(requestPath, base).href;
      }
      return requestPath;
    }

    function fetchSync(url) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status === 200 || xhr.status === 0) return xhr.responseText;
      throw new Error('HTTP ' + xhr.status + ': ' + url);
    }

    function loadModule(modulePath, parentPath) {
      var resolved = resolvePath(modulePath, parentPath);
      if (moduleCache[resolved]) return moduleCache[resolved].exports;
      var source = fetchSync(resolved);
      var mod = { exports: {}, id: resolved, loaded: false };
      moduleCache[resolved] = mod;
      moduleStack.push(resolved);
      try {
        var wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
        var dirname = resolved.substring(0, resolved.lastIndexOf('/'));
        var childRequire = function (p) { return loadModule(p, resolved); };
        childRequire.resolve = function (p) { return resolvePath(p, resolved); };
        childRequire.cache = moduleCache;
        wrapper(mod.exports, childRequire, mod, resolved, dirname);
        mod.loaded = true;
      } catch (e) {
        delete moduleCache[resolved];
        throw new Error('Module ' + resolved + ': ' + e.message);
      } finally {
        moduleStack.pop();
      }
      return mod.exports;
    }

    window.require = function (path) {
      var parent = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1] : undefined;
      return loadModule(path, parent);
    };
    window.require.cache = moduleCache;
    window.require.resolve = function (p) { return resolvePath(p); };
    window.require.clear = function () { for (var k in moduleCache) delete moduleCache[k]; };
  })();

  // ── Plugin Storage ─────────────────────────────────────────────────────
  var PLUGINS_KEY = 'podbay-plugins';

  function getPluginList() {
    try { return JSON.parse(localStorage.getItem(PLUGINS_KEY)) || []; }
    catch (_) { return []; }
  }

  function setPluginList(list) {
    localStorage.setItem(PLUGINS_KEY, JSON.stringify(list));
    // Signal main process to persist to config file
    console.log('__PODBAY_SET_PLUGINS__:' + JSON.stringify(list));
  }

  // ── Broker Connection ──────────────────────────────────────────────────
  var BROKER = 'ws://localhost:3099';
  var MIN_DELAY = 3000;
  var MAX_DELAY = 30000;

  var clientId = (function () {
    try {
      var p = new URL(location.href).searchParams;
      var wt = p.get('windowType');
      var wid = p.get('window_id');
      if (wt === '1') return 'podbay-lobby';
      if (wid) return 'podbay-window-' + wid;
    } catch (_) {}
    return 'podbay-' + Math.random().toString(36).substr(2, 8);
  })();

  var ws = null;
  var delay = MIN_DELAY;
  var reconnectTimer = null;

  var tools = [
    {
      name: 'execute_plugin',
      description: 'Execute JavaScript in the renderer main world',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript to execute' } },
        required: ['code']
      }
    },
    {
      name: 'plugin',
      description: 'Manage the plugin list. Omit plugins to get current list. Provide plugins array to replace the list.',
      inputSchema: {
        type: 'object',
        properties: {
          plugins: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of plugin require paths/URLs. Omit to get current list.'
          }
        }
      }
    }
  ];

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function handleToolCall(tool, args) {
    if (tool === 'execute_plugin') {
      if (!args || !args.code) return { error: 'code is required' };
      try {
        var r = new Function(args.code)();
        if (r && typeof r.then === 'function') return { async: true, note: 'Promise returned' };
        return { result: r };
      } catch (e) {
        return { error: e.message };
      }
    }
    if (tool === 'plugin') {
      if (args && Array.isArray(args.plugins)) {
        setPluginList(args.plugins);
        return { plugins: args.plugins, note: 'Updated. Restart app to load new plugins.' };
      }
      return { plugins: getPluginList() };
    }
    return { error: 'Unknown tool: ' + tool };
  }

  function connect() {
    try { if (ws) ws.close(); } catch (_) {}
    try { ws = new WebSocket(BROKER); } catch (_) { schedule(); return; }

    ws.onopen = function () {
      delay = MIN_DELAY;
      send({
        type: 'register',
        clientId: clientId,
        tools: tools,
        metadata: { product: 'podbay', url: location.href, title: document.title || '' }
      });
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === 'tool_call') {
        var result = handleToolCall(msg.tool, msg.arguments);
        send({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !!result.error
        });
      }
    };

    ws.onclose = function () { ws = null; schedule(); };
    ws.onerror = function () {};
  }

  function schedule() {
    if (reconnectTimer) return;
    var wait = Math.min(delay + Math.random() * 1000, MAX_DELAY);
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, wait);
    delay = Math.min(delay * 1.5, MAX_DELAY);
  }

  // Expose for downstream tools (cwg-table-helper, etc.)
  window.__portal = { ws: function () { return ws; }, clientId: clientId };

  connect();
})();
