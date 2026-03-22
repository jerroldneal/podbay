// PodBay Bootstrap — Thin Orchestrator
// Injected into Electron renderer windows via ASAR patch.
//
// SRP: Bootstrap's ONLY job is to boot:
//   1. Derive client identity
//   2. Install CommonJS require() polyfill
//   3. Load extracted modules via require()
//   4. Wire them together
//
// All other concerns are in separate CommonJS modules:
//   - broker-transport.js  → WS connection, step notifications, reconnection
//   - tool-handler.js      → Tool definitions (execute, info, inspect) + dispatch
//   - mcp-client.js        → HTTP plugin pull from broker MCP endpoint
//
// Modules are pre-registered in window.__podbayModules by the opt-in assembler
// (index.js) and loaded via require() after the polyfill is installed.
; (function () {
  'use strict';
  if (window.__podBayInstalled) return;
  window.__podBayInstalled = true;

  var TAG = '[PodBay]';
  var BROKER = 'ws://localhost:3099';
  var BROKER_HTTP = 'http://localhost:3098/mcp';
  var BROKER_TIMEOUT = 5000;

  // ══════════════════════════════════════════════════════════════════
  // SECTION 0: Client Identity
  // ══════════════════════════════════════════════════════════════════

  var clientId = (function () {
    if (typeof __podbayName === 'string' && __podbayName) return __podbayName;
    try {
      var p = new URL(location.href).searchParams;
      if (p.get('windowType') === '1') return 'podbay-lobby';
      if (p.get('window_id')) return 'podbay-window-' + p.get('window_id');
    } catch (_) { }
    return 'podbay-' + Math.random().toString(36).substr(2, 8);
  })();

  // ══════════════════════════════════════════════════════════════════
  // SECTION 1: Install CommonJS Require Polyfill
  // ══════════════════════════════════════════════════════════════════
  // This MUST be inline — it's needed before any module can be loaded.

  if (!window.__PodBayRequire) {
    var RTAG = '[PodBay Require]';
    var moduleCache = {};
    var moduleStack = [];

    function resolvePath(requestPath, fromPath) {
      if (/^[a-z]+:\/\//i.test(requestPath) || requestPath.indexOf('data:') === 0 || requestPath.indexOf('blob:') === 0) {
        return requestPath;
      }
      if (requestPath.indexOf('./') === 0 || requestPath.indexOf('../') === 0) {
        var base = fromPath || window.location.href;
        return new URL(requestPath, base).href;
      }
      if (moduleCache[requestPath]) return requestPath;
      return requestPath;
    }

    function fetchModuleSync(url) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status === 200 || xhr.status === 0) return xhr.responseText;
      throw new Error('HTTP ' + xhr.status + ': ' + xhr.statusText + ' \u2014 ' + url);
    }

    function loadModule(modulePath, parentPath) {
      var resolved = resolvePath(modulePath, parentPath);
      if (moduleCache[resolved] && moduleCache[resolved].loaded) return moduleCache[resolved].exports;
      if (moduleCache[resolved] && moduleCache[resolved]._source) {
        var cached = moduleCache[resolved];
        var code = cached._source;
        delete cached._source;
        executeModule(cached, code, resolved);
        return cached.exports;
      }
      if (window.__podbayModuleUrls && window.__podbayModuleUrls[resolved]) {
        var url = window.__podbayModuleUrls[resolved];
        var source = fetchModuleSync(url);
        var mod = createModule(resolved);
        executeModule(mod, source, url);
        return mod.exports;
      }
      if (window.__podbayPlugins && window.__podbayPlugins[resolved]) {
        var pluginSource = window.__podbayPlugins[resolved];
        var pluginMod = createModule(resolved);
        executeModule(pluginMod, pluginSource, 'podbay-plugin://' + resolved);
        return pluginMod.exports;
      }
      if (/^[a-z]+:\/\//i.test(resolved)) {
        var fetched = fetchModuleSync(resolved);
        var freshMod = createModule(resolved);
        executeModule(freshMod, fetched, resolved);
        return freshMod.exports;
      }
      throw new Error(RTAG + ' Cannot find module: ' + modulePath);
    }

    function createModule(id) {
      var mod = { exports: {}, id: id, loaded: false };
      moduleCache[id] = mod;
      return mod;
    }

    function executeModule(mod, code, filename) {
      var dirname = filename.substring(0, filename.lastIndexOf('/'));
      var wrapper = '(function(exports, require, module, __filename, __dirname) {\n' + code + '\n})';
      var fn;
      try { fn = (new Function('return ' + wrapper))(); }
      catch (e) { delete moduleCache[mod.id]; throw new Error(RTAG + ' Compile error in ' + filename + ': ' + e.message); }
      moduleStack.push(filename);
      try {
        var boundRequire = function (childPath) { return loadModule(childPath, filename); };
        boundRequire.resolve = function (childPath) { return resolvePath(childPath, filename); };
        boundRequire.cache = moduleCache;
        fn(mod.exports, boundRequire, mod, filename, dirname);
        mod.loaded = true;
      } catch (e) { delete moduleCache[mod.id]; throw new Error(RTAG + ' Runtime error in ' + filename + ': ' + e.message); }
      finally { moduleStack.pop(); }
    }

    function require(modulePath) {
      var parentPath = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1] : undefined;
      return loadModule(modulePath, parentPath);
    }
    require.cache = moduleCache;
    require.resolve = function (modulePath) {
      var parentPath = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1] : undefined;
      return resolvePath(modulePath, parentPath);
    };
    require.clear = function () {
      for (var k in moduleCache) { if (moduleCache.hasOwnProperty(k)) delete moduleCache[k]; }
      console.log(RTAG, 'Cache cleared');
    };
    require.stats = function () {
      var keys = [];
      for (var k in moduleCache) { if (moduleCache.hasOwnProperty(k)) keys.push(k); }
      return { cached: keys.length, modules: keys };
    };
    require.register = function (id, source) {
      if (moduleCache[id]) return;
      moduleCache[id] = { exports: {}, id: id, loaded: false, _source: source };
    };

    window.require = require;
    window.__PodBayRequire = { version: '2.0.0', cache: moduleCache, register: require.register };
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 2: Register Pre-Loaded Modules
  // ══════════════════════════════════════════════════════════════════
  // The opt-in assembler (index.js) embeds module source code in
  // window.__podbayModules. Register them so require() can find them.

  if (window.__podbayModules) {
    for (var name in window.__podbayModules) {
      if (window.__podbayModules.hasOwnProperty(name)) {
        window.require.register(name, window.__podbayModules[name]);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 3: Load Modules & Wire Together
  // ══════════════════════════════════════════════════════════════════

  var transport = window.require('broker-transport');
  var toolHandler = window.require('tool-handler');
  var mcpClient = window.require('mcp-client');

  transport.step('bootstrap-init', 'ok', 'guard passed, clientId=' + clientId);

  // Connect to broker (fail-fast)
  transport.init({ broker: BROKER, clientId: clientId, timeout: BROKER_TIMEOUT });

  // When broker is ready: register tools + pull plugins
  transport.onReady(function () {
    transport.register(clientId, toolHandler.definitions());
  });

  // Handle incoming messages
  transport.onMessage(function (msg) {
    if (msg.type === 'registered') {
      transport.step('register', 'ok', 'confirmed as ' + (msg.clientId || clientId));
      mcpClient.pullPlugins({ httpUrl: BROKER_HTTP, clientId: clientId, transport: transport });
      return;
    }

    if (msg.type === 'tool_call') {
      var toolName = (msg.tool || '').replace(/_plugin$/, '');
      transport.step('tool-call', 'start', toolName + ' (callId: ' + msg.callId + ')');
      var result = toolHandler.handleCall(toolName, msg.arguments || {}, { clientId: clientId, transport: transport });
      transport.step('tool-result', result.error ? 'fail' : 'ok', 'callId: ' + msg.callId + (result.error ? ' error: ' + result.error : ''));
      transport.send({
        type: 'tool_result',
        callId: msg.callId,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !!result.error
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // SECTION 4: Element Clients — buttons become individual broker clients
  // ══════════════════════════════════════════════════════════════════

  var elementClients = window.require('element-clients');
  elementClients.init({ broker: BROKER, parentClientId: clientId });

  // Public API
  window.__podBay = {
    clientId: clientId,
    ws: function () { return transport.ws(); },
    steps: function () { return transport.steps(); },
    elementClients: elementClients
  };
})();
