// PodBay Bootstrap — Minimal Pluggability Payload
// Injected into Electron renderer windows via ASAR patch.
// Only job: make this window remotely scriptable via the broker.
//   1. Connects to broker via WebSocket
//   2. Registers with tools: execute + info
//   3. Handles incoming tool calls (eval arbitrary JS)
//   4. Reconnects on disconnect
// Everything else (plugin registry, tool registration, pod loading)
// is pushed by the broker via execute after bootstrap connects.
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
        tools: [
          {
            name: 'execute',
            description: 'Execute JavaScript in the renderer main world',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'JavaScript to execute' },
                useIIFE: { type: 'boolean', description: 'Wrap code in an IIFE (default: true)' }
              },
              required: ['code']
            }
          },
          {
            name: 'info',
            description: 'Get bootstrap status and metadata for this window',
            inputSchema: { type: 'object', properties: {} }
          }
        ],
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
        if (msg.tool === 'execute' && msg.arguments && msg.arguments.code) {
          try {
            var code = msg.arguments.code;
            var useIIFE = msg.arguments.useIIFE !== false; // default true
            if (useIIFE) code = '(function(){' + code + '\n})();';
            var r = new Function(code)();
            result = (r && typeof r.then === 'function')
              ? { result: 'Promise returned (async)' }
              : { result: r };
          } catch (err) {
            result = { error: err.message };
          }
        } else if (msg.tool === 'info') {
          result = {
            clientId: clientId,
            url: location.href,
            title: document.title || '',
            userAgent: navigator.userAgent,
            podBayInstalled: !!window.__podBayInstalled,
            podBay: window.__podBay ? {
              clientId: window.__podBay.clientId,
              wsReady: !!(window.__podBay.ws && window.__podBay.ws())
            } : null,
            timestamp: new Date().toISOString()
          };
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
