// PodBay Portal — inject tool payload
// This file is written into the ASAR and executed in every renderer window.
// It connects to the broker and exposes a single "inject" tool.
;(function () {
  'use strict';

  if (window.__podBayInstalled) return;
  window.__podBayInstalled = true;

  var BROKER = 'ws://localhost:3099';
  var MIN_DELAY = 3000;
  var MAX_DELAY = 30000;

  var clientId = (function () {
    try {
      var p = new URL(location.href).searchParams;
      var wt = p.get('windowType');
      var wid = p.get('window_id');
      if (wt === '1') return 'podbay-lobby';
      if (wid) return 'podbay-window-' + wid;
    } catch (_) {}
    return 'podbay-' + Math.random().toString(36).substr(2, 8);
  })();

  var ws = null;
  var delay = MIN_DELAY;
  var reconnectTimer = null;

  var tools = [{
    name: 'inject',
    description: 'Execute JavaScript in the renderer main world',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript to execute' } },
      required: ['code']
    }
  }];

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function handleInject(args) {
    if (!args || !args.code) return { error: 'code is required' };
    try {
      var r = new Function(args.code)();
      if (r && typeof r.then === 'function') return { async: true, note: 'Promise returned' };
      return { result: r };
    } catch (e) {
      return { error: e.message };
    }
  }

  function connect() {
    try { if (ws) ws.close(); } catch (_) {}
    try { ws = new WebSocket(BROKER); } catch (_) { schedule(); return; }

    ws.onopen = function () {
      delay = MIN_DELAY;
      send({
        type: 'register',
        clientId: clientId,
        tools: tools,
        metadata: { product: 'podbay', url: location.href, title: document.title || '' }
      });
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === 'tool_call' && msg.tool === 'inject') {
        var result = handleInject(msg.arguments);
        send({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !!result.error
        });
      }
    };

    ws.onclose = function () { ws = null; schedule(); };
    ws.onerror = function () {};
  }

  function schedule() {
    if (reconnectTimer) return;
    var wait = Math.min(delay + Math.random() * 1000, MAX_DELAY);
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, wait);
    delay = Math.min(delay * 1.5, MAX_DELAY);
  }

  // Expose for downstream tools (cwg-table-helper, etc.)
  window.__portal = { ws: function () { return ws; }, clientId: clientId };

  connect();
})();
