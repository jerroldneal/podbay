/**
 * PodBay Hook Plugin
 *
 * Generalized method interception. Wraps methods on any object, calling the
 * original then forwarding formatted arguments to a callback.
 *
 * Usage:
 *   var hook = require('hook');
 *   hook(console, ['log', 'error'], function (method, args) { ... });
 *
 * Returns an object mapping each method name to its original function.
 */
'use strict';

function fmt(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

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
        } catch (_) { }
      };
    })(methods[i]);
  }
  return originals;
}

// Also install on window for backward compat
window.PodBayHook = PodBayHook;

module.exports = PodBayHook;
