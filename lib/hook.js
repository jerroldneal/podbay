/**
 * PodBay Hook Plugin
 *
 * Generalized method interception. Wraps methods on any object, calling the
 * original then forwarding formatted arguments to a callback.
 *
 * Usage:
 *   window.PodBayHook(console, ['log', 'error', 'warn', 'info'], function (method, args) {
 *     bridge.notify({ method: 'console', level: method, args: args, timestamp: Date.now() });
 *   });
 *
 * Returns an object mapping each method name to its original function.
 */
;(function () {
  'use strict';

  if (window.PodBayHook) return;

  function fmt(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }

  /**
   * @param {object} target - object whose methods to hook (e.g. console)
   * @param {string[]} methods - method names to intercept
   * @param {function} callback - called with (methodName, formattedArgs[])
   * @returns {object} originals - map of method name → original function
   */
  function PodBayHook(target, methods, callback) {
    var originals = {};
    for (var i = 0; i < methods.length; i++) {
      (function (method) {
        originals[method] = target[method];
        target[method] = function () {
          originals[method].apply(target, arguments);
          try {
            var args = [];
            for (var j = 0; j < arguments.length; j++) args.push(fmt(arguments[j]));
            callback(method, args);
          } catch (_) {}
        };
      })(methods[i]);
    }
    return originals;
  }

  window.PodBayHook = PodBayHook;
})();
