/**
 * PodBay Console Bridge Plugin
 *
 * Composes bridge.js + hook.js to provide:
 * - eval, get_console, run_console tools via broker
 * - console.log/error/warn/info hook → broker notifications
 *
 * Requires: window.PodBayBridge (bridge.js), window.PodBayHook (hook.js),
 *           window.PodBayIdentity (identity.js)
 */
;(function () {
  'use strict';
  var id = window.PodBayIdentity;
  var clientId = id ? id.clientId : 'console-bridge';
  var bridge = window.PodBayBridge(clientId);
  if (bridge.client) return; // already connected

  bridge.addTool('eval', function (args) {
    try {
      var result = (0, eval)(args.code);
      return { success: true, result: bridge.fmt(result), type: typeof result };
    } catch (e) {
      return { success: false, error: e.message, stack: e.stack };
    }
  }, 'Evaluate JavaScript code in the target page context',
    { code: { type: 'string', description: 'JavaScript code to evaluate' } }, ['code']);

  bridge.addTool('get_console', function () {
    return { url: 'http://localhost:8080/console.html' };
  }, 'Returns the URL for the remote console page');

  bridge.addTool('run_console', function () {
    var url = 'http://localhost:8080/console.html';
    window.open(url, '_blank');
    return { opened: true, url: url };
  }, 'Opens the remote console page in a new browser tab');

  window.PodBayHook(console, ['log', 'error', 'warn', 'info'], function (level, args) {
    bridge.notify({ method: 'console', level: level, args: args, timestamp: Date.now() });
  });

  bridge.connect();
  console.log('[PodBay] Console bridge active');
})();
