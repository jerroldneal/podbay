/**
 * PodBay Console Bridge Plugin
 *
 * Composes bridge + hook to provide:
 * - eval, get_console, run_console tools via broker
 * - console.log/error/warn/info hook → broker notifications
 *
 * Requires: bridge, hook, identity (via require)
 */
'use strict';

var identity = require('identity');
var bridge = require('bridge');
var hook = require('hook');

var clientId = identity.clientId || 'console-bridge';
var b = bridge(clientId);

// Guard against double-init (bridge singleton handles the connection check)
if (!b.client) {
  b.addTool('eval', function (args) {
    try {
      var result = (0, eval)(args.code);
      return { success: true, result: b.fmt(result), type: typeof result };
    } catch (e) {
      return { success: false, error: e.message, stack: e.stack };
    }
  }, 'Evaluate JavaScript code in the target page context',
    { code: { type: 'string', description: 'JavaScript code to evaluate' } }, ['code']);

  b.addTool('get_console', function () {
    return { url: 'http://localhost:8080/console.html' };
  }, 'Returns the URL for the remote console page');

  b.addTool('run_console', function () {
    var url = 'http://localhost:8080/console.html';
    window.open(url, '_blank');
    return { opened: true, url: url };
  }, 'Opens the remote console page in a new browser tab');

  hook(console, ['log', 'error', 'warn', 'info'], function (level, args) {
    b.notify({ method: 'console', level: level, args: args, timestamp: Date.now() });
  });

  b.connect();
  console.log('[PodBay] Console bridge active on', clientId);
}

module.exports = b;
