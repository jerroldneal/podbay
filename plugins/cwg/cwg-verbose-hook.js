; (function () {
  'use strict';

  if (window.CWGVerboseHook) return;

  var TAG = '[CWGVerboseHook]';
  var MAX_VERBOSE_LOG = 2000;
  var verboseLog = [];
  var verboseEnabled = false;
  var _installed = false;

  // Skip lobby windows
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  function summarizeArg(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    var t = typeof a;
    if (t === 'number' || t === 'boolean') return String(a);
    if (t === 'string') return '"' + a + '"';
    if (t === 'function') return 'fn()';
    if (Array.isArray(a)) return '[len=' + a.length + ']';
    if (a._components !== undefined) return 'Node:' + (a.name || a._name || '?');
    if (a._id !== undefined) return 'Comp:' + a._id;
    return '{obj}';
  }

  /**
   * Called from cwg-flip-hook once the first flipCardAction fires on a
   * Holdem_Card_ts instance. Walks the full prototype chain and wraps every
   * method so verbose=true logs all invocations for debugging.
   * @param {object} cardComp — a Holdem_Card_ts component instance
   */
  function tryBootstrap(cardComp) {
    if (_installed) return;
    var count = 0;
    var p = Object.getPrototypeOf(cardComp);
    while (p && p !== Object.prototype) {
      var names = Object.getOwnPropertyNames(p);
      for (var ni = 0; ni < names.length; ni++) {
        (function (name, proto) {
          if (name === 'constructor') return;
          if (proto['__cwgVbHooked_' + name]) return;
          var orig = proto[name];
          if (typeof orig !== 'function') return;
          proto[name] = function () {
            if (verboseEnabled) {
              try {
                var args = [];
                for (var ai = 0; ai < arguments.length; ai++) args.push(summarizeArg(arguments[ai]));
                var handIdx = window.CWGHandLifecycle ? window.CWGHandLifecycle.getHandIndex() : 0;
                verboseLog.push({
                  clock: new Date().toTimeString().slice(0, 8),
                  ts: performance.now(),
                  fn: name,
                  args: args,
                  handIndex: handIdx
                });
                if (verboseLog.length > MAX_VERBOSE_LOG) verboseLog.shift();
              } catch (e) { /* never propagate */ }
            }
            return orig.apply(this, arguments);
          };
          proto['__cwgVbHooked_' + name] = true;
          count++;
        })(names[ni], p);
      }
      p = Object.getPrototypeOf(p);
    }
    _installed = true;
    console.log(TAG + ' installed — ' + count + ' functions wrapped (full prototype chain)');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGVerboseHook = {
    tryBootstrap: tryBootstrap,
    isInstalled: function () { return _installed; },
    enable: function (clearLog) { verboseEnabled = true; if (clearLog) verboseLog.length = 0; },
    disable: function () { verboseEnabled = false; },
    getLog: function (last) { return last ? verboseLog.slice(-last) : verboseLog.slice(); },
    clear: function () { verboseLog.length = 0; },
    status: function () {
      return {
        installed: _installed,
        enabled: verboseEnabled,
        logSize: verboseLog.length,
        maxLogSize: MAX_VERBOSE_LOG,
        ready: _installed
      };
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────
  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG + ' PodBayBridge not available'); return; }

  _bridge.addTool(
    'set_verbose_log',
    function (p) {
      var enabled = p && p.enabled !== undefined ? !!p.enabled : true;
      var clear = p && p.clear !== undefined ? !!p.clear : false;
      window.CWGVerboseHook.enable(clear);
      if (!enabled) window.CWGVerboseHook.disable();
      return { success: true, verboseEnabled: enabled, installed: _installed };
    },
    'Enable or disable verbose logging of all Holdem_Card_ts method calls',
    {
      enabled: { type: 'boolean', description: 'true = start logging, false = stop' },
      clear: { type: 'boolean', description: 'true = clear existing log at the same time' }
    }
  );

  _bridge.addTool(
    'get_verbose_log',
    function (p) {
      var last = p && p.last ? parseInt(p.last, 10) : null;
      return {
        success: true, verboseEnabled: verboseEnabled, installed: _installed,
        logSize: verboseLog.length,
        entries: last ? verboseLog.slice(-last) : verboseLog.slice()
      };
    },
    'Get the verbose Holdem_Card_ts function call log',
    { last: { type: 'number', description: 'Return last N entries (default: all)' } }
  );

  console.log(TAG + ' registered');
})();
