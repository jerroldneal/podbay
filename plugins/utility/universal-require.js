/**
 * PodBay Universal Require Plugin
 *
 * Provides Node.js-like require() in PodBay-bootstrapped browser windows.
 * Adapted from jerroldneal/require-extension polyfill — stripped of Chrome
 * extension specifics, integrated with PodBay's pod module registration.
 *
 * Must load as the FIRST plugin in any pod bundle so that subsequent
 * plugins can call require().
 *
 * Features:
 *   - CommonJS module.exports / exports pattern
 *   - Module caching (load once, reuse)
 *   - Relative path resolution
 *   - HTTP/HTTPS URL loading (sync XHR)
 *   - Pre-registered modules via require.cache (pod system integration)
 *   - require.resolve(), require.stats(), require.clear()
 */
; (function () {
  'use strict';

  // Avoid re-injection
  if (window.__PodBayRequire) return;

  var TAG = '[PodBay Require]';

  // Module cache: id/URL → { exports, id, loaded }
  var moduleCache = {};

  // Current module stack (for relative path resolution in nested requires)
  var moduleStack = [];

  // ── Path Resolution ──────────────────────────────────────────────

  function resolvePath(requestPath, fromPath) {
    // Absolute URL — return as-is
    if (/^[a-z]+:\/\//i.test(requestPath) || requestPath.indexOf('data:') === 0 || requestPath.indexOf('blob:') === 0) {
      return requestPath;
    }

    // Relative path (./ or ../)
    if (requestPath.indexOf('./') === 0 || requestPath.indexOf('../') === 0) {
      var base = fromPath || window.location.href;
      return new URL(requestPath, base).href;
    }

    // Bare module name — check cache first (pod-registered modules), else resolve relative to page
    if (moduleCache[requestPath]) {
      return requestPath; // exact cache key match
    }
    return requestPath;
  }

  // ── Sync Fetch ───────────────────────────────────────────────────

  function fetchModuleSync(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // synchronous
    xhr.send(null);
    if (xhr.status === 200 || xhr.status === 0) {
      return xhr.responseText;
    }
    throw new Error('HTTP ' + xhr.status + ': ' + xhr.statusText + ' — ' + url);
  }

  // ── Module Loader ────────────────────────────────────────────────

  function loadModule(modulePath, parentPath) {
    var resolved = resolvePath(modulePath, parentPath);

    // Cache hit
    if (moduleCache[resolved] && moduleCache[resolved].loaded) {
      return moduleCache[resolved].exports;
    }

    // Pre-registered but not yet executed (pod system inline cache)
    if (moduleCache[resolved] && moduleCache[resolved]._source) {
      var cached = moduleCache[resolved];
      var code = cached._source;
      delete cached._source; // prevent re-execution
      executeModule(cached, code, resolved);
      return cached.exports;
    }

    // URL-registered module (pod system dynamic mode)
    if (window.__podbayModuleUrls && window.__podbayModuleUrls[resolved]) {
      var url = window.__podbayModuleUrls[resolved];
      var source = fetchModuleSync(url);
      var mod = createModule(resolved);
      executeModule(mod, source, url);
      return mod.exports;
    }

    // Fetch from URL
    if (/^[a-z]+:\/\//i.test(resolved)) {
      var fetched = fetchModuleSync(resolved);
      var freshMod = createModule(resolved);
      executeModule(freshMod, fetched, resolved);
      return freshMod.exports;
    }

    throw new Error(TAG + ' Cannot find module: ' + modulePath);
  }

  function createModule(id) {
    var mod = {
      exports: {},
      id: id,
      loaded: false
    };
    moduleCache[id] = mod;
    return mod;
  }

  function executeModule(mod, code, filename) {
    var dirname = filename.substring(0, filename.lastIndexOf('/'));
    var wrapper = '(function(exports, require, module, __filename, __dirname) {\n' + code + '\n})';
    var fn;
    try {
      fn = (new Function('return ' + wrapper))();
    } catch (e) {
      delete moduleCache[mod.id];
      throw new Error(TAG + ' Compile error in ' + filename + ': ' + e.message);
    }

    moduleStack.push(filename);
    try {
      var boundRequire = function (childPath) {
        return loadModule(childPath, filename);
      };
      boundRequire.resolve = function (childPath) {
        return resolvePath(childPath, filename);
      };
      boundRequire.cache = moduleCache;
      fn(mod.exports, boundRequire, mod, filename, dirname);
      mod.loaded = true;
    } catch (e) {
      delete moduleCache[mod.id];
      throw new Error(TAG + ' Runtime error in ' + filename + ': ' + e.message);
    } finally {
      moduleStack.pop();
    }
  }

  // ── Main require() ──────────────────────────────────────────────

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
    for (var k in moduleCache) {
      if (moduleCache.hasOwnProperty(k)) delete moduleCache[k];
    }
    console.log(TAG, 'Cache cleared');
  };

  require.stats = function () {
    var keys = [];
    for (var k in moduleCache) {
      if (moduleCache.hasOwnProperty(k)) keys.push(k);
    }
    return { cached: keys.length, modules: keys };
  };

  /**
   * Pre-register a module by id and source code without executing it.
   * Used by the pod system's id+cache inline mode.
   * @param {string} id - Module identifier
   * @param {string} source - Module source code
   */
  require.register = function (id, source) {
    if (moduleCache[id]) return; // already loaded — don't overwrite
    moduleCache[id] = {
      exports: {},
      id: id,
      loaded: false,
      _source: source
    };
  };

  // ── Install ──────────────────────────────────────────────────────

  window.require = require;
  window.__PodBayRequire = {
    version: '1.0.0',
    cache: moduleCache,
    register: require.register
  };

  console.log(TAG, 'Initialized — require() is now available');
})();
