// PodBay Broker Transport — WebSocket connection, step notifications, reconnection
// CommonJS module loaded via bootstrap's require polyfill.
//
// Usage:
//   var transport = require('broker-transport');
//   transport.init({ broker: 'ws://localhost:3099', clientId: 'my-app', timeout: 5000 });
//   transport.onReady(function() { transport.register(clientId, tools); });
//   transport.onMessage(function(msg) { /* handle */ });
'use strict';

var TAG = '[PodBay Transport]';
var ws = null;
var delay = 3000;
var timer = null;
var _steps = [];
var _brokerReady = false;
var _config = {};
var _readyCallbacks = [];
var _messageHandler = null;

function step(name, status, detail) {
  var entry = { step: name, status: status, detail: detail || null, ts: new Date().toISOString() };
  _steps.push(entry);
  var icon = status === 'ok' ? '\u2713' : status === 'fail' ? '\u2717' : status === 'skip' ? '\u2298' : '\u2192';
  var parts = [TAG, icon, name];
  if (detail) parts.push('\u2014', typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log.apply(console, parts);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({
        type: 'notification',
        data: { event: 'step', clientId: _config.clientId, step: name, status: status, detail: detail || null, ts: entry.ts }
      }));
    } catch (_) { }
  }
}

function fatal(reason) {
  var msg = TAG + ' FATAL: ' + reason;
  console.error(msg);
  document.title = 'PODBAY FATAL: ' + reason;
  step('fatal', 'fail', reason);
  throw new Error(msg);
}

function send(d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(d));
}

function register(clientId, toolDefs) {
  step('register', 'start', 'sending register as ' + clientId);
  send({
    type: 'register',
    clientId: clientId,
    tools: toolDefs,
    metadata: { clientId: clientId, url: location.href, title: document.title || '' }
  });
}

function reconnect() {
  step('broker-reconnect', 'start', _config.broker);
  try { if (ws) ws.close(); } catch (_) { }
  try { ws = new WebSocket(_config.broker); } catch (connErr) {
    step('broker-reconnect', 'fail', connErr.message);
    schedule(); return;
  }
  ws.onopen = function () {
    delay = 3000;
    _brokerReady = true;
    step('broker-reconnect', 'ok', 'reconnected to ' + _config.broker);
    attachHandler();
    fireReady();
  };
  ws.onclose = function () {
    ws = null;
    _brokerReady = false;
    step('broker-reconnect', 'fail', 'disconnected, scheduling reconnect');
    schedule();
  };
  ws.onerror = function () { };
}

function schedule() {
  if (timer) return;
  timer = setTimeout(function () { timer = null; reconnect(); },
    Math.min(delay + Math.random() * 1000, 30000));
  delay = Math.min(delay * 1.5, 30000);
}

function attachHandler() {
  if (!ws) return;
  ws.onmessage = function (e) {
    var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (_messageHandler) _messageHandler(msg);
  };
}

function fireReady() {
  for (var i = 0; i < _readyCallbacks.length; i++) {
    try { _readyCallbacks[i](); } catch (_) { }
  }
}

function init(config) {
  _config = config;
  var broker = config.broker;
  var timeout = config.timeout || 5000;
  var clientId = config.clientId;

  step('broker-connect', 'start', 'connecting to ' + broker + ' (timeout ' + timeout + 'ms)');

  var _resolveConnected;
  var _connected = new Promise(function (resolve) { _resolveConnected = resolve; });

  try { ws = new WebSocket(broker); } catch (connErr) {
    fatal('Cannot create WebSocket to broker: ' + connErr.message);
  }

  ws.onopen = function () {
    _brokerReady = true;
    step('broker-connect', 'ok', 'connected to ' + broker);
    _resolveConnected(true);
  };
  ws.onerror = function () { };
  ws.onclose = function () {
    if (!_brokerReady) return;
    ws = null;
    _brokerReady = false;
    step('broker-reconnect', 'start', 'scheduling reconnect');
    schedule();
  };

  setTimeout(function () {
    if (!_brokerReady) fatal('Broker unreachable at ' + broker + ' after ' + timeout + 'ms');
  }, timeout);

  _connected.then(function () {
    attachHandler();
    var origOnClose = ws.onclose;
    ws.onclose = function () {
      ws = null;
      _brokerReady = false;
      step('broker-reconnect', 'start', 'scheduling reconnect');
      schedule();
    };
    fireReady();
  });
}

module.exports = {
  init: init,
  step: step,
  fatal: fatal,
  send: send,
  register: register,
  onReady: function (fn) { _readyCallbacks.push(fn); if (_brokerReady) fn(); },
  onMessage: function (fn) { _messageHandler = fn; },
  ws: function () { return ws; },
  steps: function () { return _steps; },
  ready: function () { return _brokerReady; }
};
