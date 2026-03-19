// PodBay Bootstrap — Minimal Pluggability Payload
// Injected into Electron renderer windows via ASAR patch.
// Only job: make this window remotely scriptable via the broker.
//   1. Connects to broker via WebSocket
//   2. Registers with a single tool: execute_plugin
//   3. Handles incoming tool calls (eval arbitrary JS)
//   4. Reconnects on disconnect
// Everything else (plugin registry, tool registration, pod loading)
// is pushed by the broker via execute_plugin after bootstrap connects.
; (function () {
  'use strict';
  if (window.__podBayInstalled) return;
  window.__podBayInstalled = true;

  var TAG = '[PodBay]';
  var BROKER = 'ws://localhost:3099';
  var ws, delay = 3000, timer;

  // ── Derive client identity ─────────────────────────────────────────
  var clientId = (function () {
    if (typeof __podbayName === 'string' && __podbayName) return __podbayName;
    try {
      var p = new URL(location.href).searchParams;
      if (p.get('windowType') === '1') return 'podbay-lobby';
      if (p.get('window_id')) return 'podbay-window-' + p.get('window_id');
    } catch (_) { }
    return 'podbay-' + Math.random().toString(36).substr(2, 8);
  })();

  // ── Logging ────────────────────────────────────────────────────────
  function log() {
    var args = [TAG];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  // ── WebSocket helpers ──────────────────────────────────────────────
  function send(d) { ws && ws.readyState === 1 && ws.send(JSON.stringify(d)); }

  function connect() {
    try { if (ws) ws.close(); } catch (_) { }
    try { ws = new WebSocket(BROKER); } catch (_) { schedule(); return; }
    ws.onopen = function () {
      delay = 3000;
      log('Connected to broker');
      send({
        type: 'register',
        clientId: clientId,
        tools: [{
          name: 'execute_plugin',
          description: 'Execute JavaScript in the renderer main world',
          inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to execute' } }, required: ['code'] }
        }],
        metadata: { clientId: clientId, url: location.href, title: document.title || '' }
      });
    };

    ws.onmessage = function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }

      if (msg.type === 'registered') {
        log('Registered as', msg.clientId);
        return;
      }

      if (msg.type === 'tool_call') {
        var result;
        if (msg.tool === 'execute_plugin' && msg.arguments && msg.arguments.code) {
          try {
            var r = new Function(msg.arguments.code)();
            result = (r && typeof r.then === 'function')
              ? { result: 'Promise returned (async)' }
              : { result: r };
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          result = { error: 'Unknown tool or missing code: ' + msg.tool };
        }
        send({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: !!result.error
        });
      }
    };

    ws.onclose = function () { ws = null; schedule(); };
    ws.onerror = function () { };
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; connect(); },
      Math.min(delay + Math.random() * 1000, 30000));
    delay = Math.min(delay * 1.5, 30000);
  }

  // ── Public API (minimal — extended by injected plugins) ────────────
  window.__podBay = { clientId: clientId, ws: function () { return ws; } };

  connect();
})();
