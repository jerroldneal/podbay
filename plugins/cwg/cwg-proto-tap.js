; (function () {
  'use strict';

  if (window.CWGProtoTap) return;

  var TAG = '[CWGProtoTap]';

  // ── Message ID → type registry ───────────────────────────────────────────
  // Maps wire-frame msgId → { ns: protobuf namespace, name: message type name, label: short display label }
  // Source: protobuf-message-catalog.md — holdem namespace, confirmed from CWG traffic analysis
  var MSG_REGISTRY = {
    // Room / session lifecycle
    50001: { ns: 'holdem', name: 'EnterRoomReq', label: 'EnterRoomReq' },
    50004: { ns: 'holdem', name: 'EnterRoomRes', label: 'EnterRoomRes' },
    50005: { ns: 'holdem', name: 'LeaveRoomReq', label: 'LeaveRoomReq' },
    50006: { ns: 'holdem', name: 'RoomSnapshotMsg', label: 'RoomSnapshotMsg' },
    // Player & seat events
    50020: { ns: 'holdem', name: 'SitDownReq', label: 'SitDownReq' },
    50021: { ns: 'holdem', name: 'SitDownRes', label: 'SitDownRes' },
    50036: { ns: 'holdem', name: 'PlayerActionMsg', label: 'PlayerActionMsg' },
    50037: { ns: 'holdem', name: 'HoleCardListMsg', label: 'HoleCardListMsg' },
    // Pot & blinds
    50034: { ns: 'holdem', name: 'PotsMsg', label: 'PotsMsg' },
    50060: { ns: 'holdem', name: 'BlindMsg', label: 'BlindMsg' },
    // Deal & cards
    50100: { ns: 'holdem', name: 'DealMsg', label: 'DealMsg' },
    50104: { ns: 'holdem', name: 'HoleCardsMsg', label: 'HoleCardsMsg' },
    50106: { ns: 'holdem', name: 'BoardCardsMsg', label: 'BoardCardsMsg' },
    // Action: request / response
    50108: { ns: 'holdem', name: 'ActionRes', label: 'ActionRes' },
    50109: { ns: 'holdem', name: 'ActionReq', label: 'ActionReq' },
    50112: { ns: 'holdem', name: 'NeedActionMsg', label: 'NeedActionMsg' },
    // Showdown & results
    50113: { ns: 'holdem', name: 'ShowHandsMsg', label: 'ShowHandsMsg' },
    50114: { ns: 'holdem', name: 'ShowdownMsg', label: 'ShowdownMsg' },
    50116: { ns: 'holdem', name: 'RoundResultMsg', label: 'RoundResultMsg' },
    50118: { ns: 'holdem', name: 'PlayerHandResultMsg', label: 'PlayerHandResultMsg' },
    // Tournament info
    50120: { ns: 'holdem', name: 'BlindStructureMsg', label: 'BlindStructureMsg' },
    50122: { ns: 'holdem', name: 'TournamentInfoMsg', label: 'TournamentInfoMsg' },
    50124: { ns: 'holdem', name: 'TournamentLevelMsg', label: 'TournamentLevelMsg' },
    50126: { ns: 'holdem', name: 'PlayerRankMsg', label: 'PlayerRankMsg' },
  };

  // ── Wire frame helpers ───────────────────────────────────────────────────
  // CWG wire format: [4-byte BE uint32: 2+bodyLen][2-byte BE uint16: msgId][body bytes]

  function buildFrame(msgId, body) {
    var frame = new Uint8Array(6 + body.length);
    var dv = new DataView(frame.buffer);
    dv.setUint32(0, 2 + body.length, false); // big-endian: length covers msgId + body
    dv.setUint16(4, msgId, false);            // big-endian: message ID
    frame.set(body, 6);
    return frame.buffer;
  }

  function parseFrame(data) {
    try {
      var ab;
      if (data instanceof ArrayBuffer) {
        ab = data;
      } else if (ArrayBuffer.isView(data)) {
        ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        return null; // text frame — skip
      }
      if (ab.byteLength < 6) return null;
      var dv = new DataView(ab);
      var msgId = dv.getUint16(4, false);           // bytes 4-5
      var envLen = dv.getUint32(0, false);            // bytes 0-3 = msgId(2) + bodyLen
      var bodyLen = envLen - 2;
      if (bodyLen < 0 || 6 + bodyLen > ab.byteLength) return null;
      var body = new Uint8Array(ab, 6, bodyLen);
      return { msgId: msgId, body: body };
    } catch (e) {
      return null;
    }
  }

  // ── Protobuf decoder ─────────────────────────────────────────────────────
  function decodeMsg(msgId, body) {
    var info = MSG_REGISTRY[msgId];
    var label = info ? info.label : String(msgId);

    if (!info) return { msgId: msgId, label: label, raw: true };

    var proto = window.protobuf;
    if (!proto || !proto.roots || !proto.roots['default']) {
      return { msgId: msgId, label: label, pendingDecode: true };
    }

    try {
      var Type = proto.roots['default'].lookupType(info.ns + '.' + info.name);
      var decoded = Type.decode(body);
      return {
        msgId: msgId,
        label: label,
        msg: Type.toObject(decoded, { longs: String, enums: String, defaults: false })
      };
    } catch (e) {
      return { msgId: msgId, label: label, decodeError: e.message, raw: true };
    }
  }

  // ── URL filter ───────────────────────────────────────────────────────────
  function isGameSocket(url) {
    if (!url) return false;
    return url.indexOf('mtt/holdem') !== -1 || url.indexOf('v88mttsmtp') !== -1;
  }

  // ── Ring buffer ──────────────────────────────────────────────────────────
  var MAX_EVENTS = 200;
  var _ring = [];

  function pushEvent(evt) {
    _ring.push(evt);
    if (_ring.length > MAX_EVENTS) _ring.shift();
  }

  // ── Listener map ─────────────────────────────────────────────────────────
  // { label: [fn, ...], '*': [fn, ...] }
  var _listeners = {};

  function notifyListeners(label, decoded) {
    var i, arr;
    arr = _listeners[label];
    if (arr) for (i = 0; i < arr.length; i++) { try { arr[i](decoded); } catch (e) { } }
    arr = _listeners['*'];
    if (arr) for (i = 0; i < arr.length; i++) { try { arr[i]({ label: label, decoded: decoded }); } catch (e) { } }
  }

  // ── Socket hooking ───────────────────────────────────────────────────────
  var _hookedSockets = new WeakSet();
  var _gameSocket = null;

  function onFrame(dir, data) {
    var frame = parseFrame(data);
    if (!frame) return;
    var decoded = decodeMsg(frame.msgId, frame.body);
    var evt = { ts: Date.now(), dir: dir, msgId: frame.msgId, label: decoded.label, decoded: decoded };
    pushEvent(evt);
    if (dir === 'in') notifyListeners(decoded.label, decoded);
  }

  function hookSocket(ws) {
    if (_hookedSockets.has(ws)) return;
    _hookedSockets.add(ws);
    _gameSocket = ws;

    // ── Intercept onmessage setter ───────────────────────────────────────
    // Replace the writable property with an accessor so we can wrap any fn assigned to it.
    var _stored = ws.onmessage || null;

    function wrapHandler(fn) {
      if (!fn) return null;
      return function (ev) {
        onFrame('in', ev.data);
        return fn.call(ws, ev);
      };
    }

    try {
      Object.defineProperty(ws, 'onmessage', {
        get: function () { return _stored; },
        set: function (fn) { _stored = wrapHandler(fn); },
        configurable: true
      });
      // Wrap any handler already assigned
      if (_stored) _stored = wrapHandler(_stored);
    } catch (e) {
      // defineProperty failed — fall back to simple reassign
      if (ws.onmessage) {
        var _orig = ws.onmessage;
        ws.onmessage = wrapHandler(_orig);
      }
    }

    // ── Intercept addEventListener('message') ───────────────────────────
    var _origAEL = ws.addEventListener;
    ws.addEventListener = function (type, fn, opts) {
      if (type === 'message') {
        var wrapped = function (ev) { onFrame('in', ev.data); return fn.call(this, ev); };
        wrapped._cwgOrig = fn;
        return _origAEL.call(ws, 'message', wrapped, opts);
      }
      return _origAEL.call(ws, type, fn, opts);
    };

    console.log(TAG, 'hooked socket:', ws.url);
  }

  // ── Patch WebSocket constructor (future sockets) ─────────────────────────
  var _NativeWS = window.WebSocket;

  function CWGPatchedWebSocket(url, protocols) {
    var ws = protocols !== undefined ? new _NativeWS(url, protocols) : new _NativeWS(url);
    if (isGameSocket(url)) hookSocket(ws);
    return ws;
  }

  // Copy static members so instanceof / readyState constants work
  CWGPatchedWebSocket.prototype = _NativeWS.prototype;
  CWGPatchedWebSocket.CONNECTING = _NativeWS.CONNECTING; // 0
  CWGPatchedWebSocket.OPEN = _NativeWS.OPEN;       // 1
  CWGPatchedWebSocket.CLOSING = _NativeWS.CLOSING;    // 2
  CWGPatchedWebSocket.CLOSED = _NativeWS.CLOSED;     // 3

  try { window.WebSocket = CWGPatchedWebSocket; } catch (e) {
    console.warn(TAG, 'could not patch WebSocket constructor:', e.message);
  }

  // ── Patch prototype.send (existing + future sockets outgoing) ────────────
  var _origSend = _NativeWS.prototype.send;
  _NativeWS.prototype.send = function (data) {
    if (isGameSocket(this.url)) onFrame('out', data);
    return _origSend.call(this, data);
  };

  // ── sendRaw — for cwg-proto-action ───────────────────────────────────────
  function sendRaw(frameBuffer) {
    if (!_gameSocket || _gameSocket.readyState !== 1 /* OPEN */) {
      return { sent: false, reason: !_gameSocket ? 'no game socket' : 'socket not OPEN (state=' + _gameSocket.readyState + ')' };
    }
    try {
      _gameSocket.send(frameBuffer);
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGProtoTap = {
    /** Subscribe to a decoded message type by label (e.g. 'NeedActionMsg') or '*' for all */
    on: function (label, fn) {
      if (!_listeners[label]) _listeners[label] = [];
      if (_listeners[label].indexOf(fn) === -1) _listeners[label].push(fn);
    },

    /** Unsubscribe a listener */
    off: function (label, fn) {
      var arr = _listeners[label];
      if (!arr) return;
      var i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },

    /** Send a raw ArrayBuffer on the active game socket */
    sendRaw: sendRaw,

    /** Build a CWG wire frame from a message ID and protobuf-encoded body bytes */
    buildFrame: buildFrame,

    /** Returns the hooked game WebSocket, or null if not yet connected */
    getSocket: function () { return _gameSocket; },

    /** Returns a copy of the current ring buffer */
    getLog: function () { return _ring.slice(); },

    /** msgId → { ns, name, label } */
    MSG_REGISTRY: MSG_REGISTRY
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────
  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available — MCP tools not registered'); }

  if (_bridge) {
    _bridge.addTool(
      'get_proto_log',
      function (params) {
        var n = Math.min(params && params.last ? parseInt(params.last) || 20 : 20, MAX_EVENTS);
        var slice = _ring.slice(-n);
        return { count: slice.length, total: _ring.length, events: slice };
      },
      'Get recently decoded protobuf frames from the game WebSocket',
      { last: { type: 'number', description: 'Number of recent events to return (default 20, max 200)' } }
    );

    _bridge.addTool(
      'get_proto_log_by_type',
      function (params) {
        var label = params && params.type ? params.type : '';
        var filtered = _ring.filter(function (e) { return e.label === label; });
        return { count: filtered.length, label: label, events: filtered.slice(-50) };
      },
      'Filter the proto log by message type label (e.g. NeedActionMsg)',
      { type: { type: 'string', description: 'Message label to filter on (e.g. NeedActionMsg, PlayerActionMsg)' } }
    );

    _bridge.addTool(
      'get_proto_registry',
      function () {
        return Object.keys(MSG_REGISTRY).map(function (id) {
          var info = MSG_REGISTRY[id];
          return { msgId: parseInt(id, 10), label: info.label, type: info.ns + '.' + info.name };
        }).sort(function (a, b) { return a.msgId - b.msgId; });
      },
      'List all known protobuf message types with their wire IDs',
      {}
    );

    _bridge.addTool(
      'get_proto_socket_status',
      function () {
        var states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
        return {
          hasSocket: !!_gameSocket,
          url: _gameSocket ? _gameSocket.url : null,
          readyState: _gameSocket ? (states[_gameSocket.readyState] || _gameSocket.readyState) : null,
          eventsTotal: _ring.length,
          eventsCapacity: MAX_EVENTS
        };
      },
      'Check whether the game WebSocket has been intercepted and the buffer status',
      {}
    );

    _bridge.addTool(
      'clear_proto_log',
      function () {
        var n = _ring.length;
        _ring.length = 0;
        return { cleared: n };
      },
      'Clear the protobuf event ring buffer',
      {}
    );
  }

  console.log(TAG, 'initialized — WebSocket constructor patched + prototype.send intercepted');
}());
