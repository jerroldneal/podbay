// PodBay System Plugin — Opt-In Injection Client
// Injected into Electron renderer windows as the single bootstrap payload.
// Replaces portal-payload.js with a minimal reverse client that:
//   1. Connects to broker
//   2. Calls PodBay's "inject" tool with self-identifying metadata
//   3. Evaluates the returned bundle (all plugins combined by PodBay)
//   4. Stays connected for ongoing execute_plugin / plugin tool access
;(function () {
  'use strict';

  if (window.__podBayInstalled) return;
  window.__podBayInstalled = true;

  var TAG = '[PodBay]';
  var BROKER = 'ws://localhost:3099';
  var MIN_DELAY = 3000;
  var MAX_DELAY = 30000;
  var PODBAY_CLIENT = 'podbay';

  // ── Self-identification ────────────────────────────────────────────────
  // Derive a stable clientId and metadata from the current window context.

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

  var selfMetadata = {
    clientId: clientId,
    product: 'podbay',
    url: location.href,
    title: document.title || '',
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString()
  };

  // ── Logging ────────────────────────────────────────────────────────────

  function log() {
    var args = [TAG];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  // ── Injection state ────────────────────────────────────────────────────

  var injected = false;
  var injectionResult = null;

  // ── Tools exposed to broker ────────────────────────────────────────────

  var tools = [
    {
      name: 'execute_plugin',
      description: 'Execute JavaScript in the renderer main world',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript to execute' } },
        required: ['code']
      }
    },
    {
      name: 'plugin',
      description: 'Get injection status and metadata for this window',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }
  ];

  function handleToolCall(tool, args) {
    if (tool === 'execute_plugin') {
      if (!args || !args.code) return { error: 'code is required' };
      try {
        var r = new Function(args.code)();
        if (r && typeof r.then === 'function') return { async: true, note: 'Promise returned' };
        return { result: r };
      } catch (e) {
        return { error: e.message };
      }
    }
    if (tool === 'plugin') {
      return {
        clientId: clientId,
        injected: injected,
        injectionResult: injectionResult,
        metadata: selfMetadata
      };
    }
    return { error: 'Unknown tool: ' + tool };
  }

  // ── Broker connection & injection request ──────────────────────────────

  var ws = null;
  var delay = MIN_DELAY;
  var reconnectTimer = null;
  var pendingInjectCall = null;

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function requestInjection() {
    if (injected) return;

    // Generate a unique call ID for the tool_call to PodBay
    var callId = 'inject-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    pendingInjectCall = callId;

    log('Requesting injection from PodBay...', JSON.stringify(selfMetadata));

    // Call PodBay's inject tool via the broker's call_tool mechanism
    send({
      type: 'call_tool',
      targetClient: PODBAY_CLIENT,
      tool: 'inject',
      arguments: selfMetadata,
      callId: callId
    });
  }

  function handleInjectionResponse(bundle) {
    if (injected) return;
    if (!bundle || !bundle.code) {
      log('No injection code received from PodBay');
      injectionResult = { status: 'empty', timestamp: new Date().toISOString() };
      injected = true;
      return;
    }

    log('Received injection bundle:', bundle.plugins + ' plugins,', bundle.codeLength + ' chars');

    try {
      // Execute the combined plugin bundle
      new Function(bundle.code)();
      injectionResult = {
        status: 'ok',
        plugins: bundle.plugins,
        codeLength: bundle.codeLength,
        pods: bundle.pods,
        timestamp: new Date().toISOString()
      };
      log('Injection complete:', bundle.plugins, 'plugins loaded');
    } catch (e) {
      injectionResult = {
        status: 'error',
        error: e.message,
        timestamp: new Date().toISOString()
      };
      log('Injection error:', e.message);
    }

    injected = true;
  }

  function connect() {
    try { if (ws) ws.close(); } catch (_) {}
    try { ws = new WebSocket(BROKER); } catch (_) { schedule(); return; }

    ws.onopen = function () {
      delay = MIN_DELAY;
      log('Connected to broker:', BROKER);

      // Register as a reverse client (expose tools for external use)
      send({
        type: 'register',
        clientId: clientId,
        tools: tools,
        metadata: selfMetadata
      });

      // Request injection from PodBay
      requestInjection();
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }

      // Handle registration confirmation
      if (msg.type === 'registered') {
        log('Registered as', msg.clientId);
        return;
      }

      // Handle tool_result — response to our inject call
      if (msg.type === 'tool_result' && msg.callId === pendingInjectCall) {
        pendingInjectCall = null;
        try {
          var payload = msg.content && msg.content[0] && msg.content[0].text;
          var bundle = payload ? JSON.parse(payload) : null;
          if (msg.isError) {
            log('Injection request failed:', payload);
            injectionResult = { status: 'error', error: payload, timestamp: new Date().toISOString() };
            injected = true;
          } else {
            handleInjectionResponse(bundle);
          }
        } catch (parseErr) {
          log('Failed to parse injection response:', parseErr.message);
          injectionResult = { status: 'parse_error', error: parseErr.message, timestamp: new Date().toISOString() };
          injected = true;
        }
        return;
      }

      // Handle incoming tool calls (execute_plugin, plugin)
      if (msg.type === 'tool_call') {
        var result = handleToolCall(msg.tool, msg.arguments);
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

  // ── Public API ─────────────────────────────────────────────────────────

  window.__podBay = {
    clientId: clientId,
    metadata: selfMetadata,
    ws: function () { return ws; },
    isInjected: function () { return injected; },
    injectionResult: function () { return injectionResult; },
    reinject: function () {
      injected = false;
      injectionResult = null;
      requestInjection();
    }
  };

  connect();
})();
