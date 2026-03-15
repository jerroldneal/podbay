; (function () {
  'use strict';

  if (window.CWGWebSocketInspector) return;

  var TAG = '[CWGWebSocketInspector]';

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Connection registry ───────────────────────────────────────────────────
  // keyed by numeric ID, each entry:
  // { id, url, protocol, readyState, openTs, closeTs, msgIn, msgOut, lastMsgTs, lastErrMsg }
  var _nextId = 1;
  var _registry = {};

  // ── Monkey-patch WebSocket ────────────────────────────────────────────────
  var OrigWS = window.WebSocket;

  function PatchedWS(url, protocols) {
    var id = _nextId++;
    var entry = {
      id: id,
      url: url,
      protocol: protocols || null,
      readyState: 0, // CONNECTING
      openTs: null,
      closeTs: null,
      msgIn: 0,
      msgOut: 0,
      lastMsgTs: null,
      lastErrMsg: null
    };
    _registry[id] = entry;

    var ws = protocols
      ? new OrigWS(url, protocols)
      : new OrigWS(url);

    // Track state changes
    var origOnOpen = null;
    var origOnClose = null;
    var origOnMessage = null;
    var origOnError = null;

    var origAddEL = ws.addEventListener.bind(ws);
    ws.addEventListener = function (type, fn, opts) {
      if (type === 'open') { origOnOpen = fn; }
      if (type === 'close') { origOnClose = fn; }
      if (type === 'message') { origOnMessage = fn; }
      if (type === 'error') { origOnError = fn; }
      return origAddEL(type, fn, opts);
    };

    origAddEL('open', function () {
      entry.readyState = 1;
      entry.openTs = Date.now();
    });
    origAddEL('close', function () {
      entry.readyState = 3;
      entry.closeTs = Date.now();
    });
    origAddEL('message', function () {
      entry.msgIn++;
      entry.lastMsgTs = Date.now();
    });
    origAddEL('error', function (e) {
      entry.readyState = ws.readyState;
      entry.lastErrMsg = e && (e.message || e.type || 'error');
    });

    // Override send to count outbound messages
    var origSend = ws.send.bind(ws);
    ws.send = function (data) {
      entry.msgOut++;
      entry.lastMsgTs = Date.now();
      return origSend(data);
    };

    // Keep readyState in sync via property reflection
    Object.defineProperty(ws, '_cwgId', { value: id, writable: false });

    return ws;
  }

  // Inherit WebSocket prototype so instanceof checks work
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = OrigWS.CONNECTING;
  PatchedWS.OPEN = OrigWS.OPEN;
  PatchedWS.CLOSING = OrigWS.CLOSING;
  PatchedWS.CLOSED = OrigWS.CLOSED;

  try {
    window.WebSocket = PatchedWS;
    console.log(TAG, 'WebSocket patched');
  } catch (e) {
    console.error(TAG, 'failed to patch WebSocket:', e);
  }

  // ── readyState labels ─────────────────────────────────────────────────────
  var RS_LABELS = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };

  function connectionList() {
    return Object.keys(_registry).map(function (k) {
      var e = _registry[k];
      return {
        id: e.id,
        url: e.url,
        readyState: RS_LABELS[e.readyState] || String(e.readyState),
        msgIn: e.msgIn,
        msgOut: e.msgOut,
        lastMsgTs: e.lastMsgTs,
        openTs: e.openTs,
        closeTs: e.closeTs,
        lastErrMsg: e.lastErrMsg
      };
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGWebSocketInspector = {
    getConnections: function () {
      return connectionList();
    },
    getConnection: function (id) {
      return _registry[id] || null;
    },
    clearClosed: function () {
      Object.keys(_registry).forEach(function (k) {
        if (_registry[k].readyState === 3) delete _registry[k];
      });
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'get_websocket_connections',
    function () {
      return window.CWGWebSocketInspector.getConnections();
    },
    'Returns all WebSocket connections observed since the inspector loaded. Each entry: { id, url, readyState, msgIn, msgOut, lastMsgTs, openTs, closeTs, lastErrMsg }',
    {}
  );

  _bridge.addTool(
    'get_websocket_connection',
    function (args) {
      var id = args && args.id;
      if (id === undefined) return { error: 'id required' };
      return window.CWGWebSocketInspector.getConnection(Number(id));
    },
    'Returns details for a single WebSocket connection by id',
    { type: 'object', properties: { id: { description: 'Connection ID from get_websocket_connections' } }, required: ['id'] }
  );

  _bridge.addTool(
    'clear_closed_websockets',
    function () {
      window.CWGWebSocketInspector.clearClosed();
      return { cleared: true };
    },
    'Remove all CLOSED WebSocket connections from the inspector registry',
    {}
  );

  console.log(TAG, 'registered');
})();
