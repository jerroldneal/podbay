; (function () {
  'use strict';

  if (window.CWGProtoAction) return;

  var TAG = '[CWGProtoAction]';

  // ── Dependency check ─────────────────────────────────────────────────────
  if (!window.CWGProtoTap) {
    console.warn(TAG, 'CWGProtoTap not found — cwg-proto-tap must load first');
    return;
  }
  if (!window.CWGGameStatus) {
    console.warn(TAG, 'CWGGameStatus not found — cwg-game-status must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Action enum ───────────────────────────────────────────────────────────
  // holdem.ActionReq.action field values (confirmed from protobuf catalog)
  var ACTION = { CHECK: 1, CALL: 2, BET: 3, FOLD: 4, RAISE: 5, ALL_IN: 6 };

  // ActionRes result codes
  var RES_CODE = { OK: 0, INVALID_ACTION: 50005, OVER_TURN: 50007 };

  // ── Last action result ────────────────────────────────────────────────────
  var _lastResult = null;

  CWGProtoTap.on('ActionRes', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    _lastResult = {
      code: Number(msg.code !== undefined ? msg.code : -1),
      roomId: Number(msg.roomId !== undefined ? msg.roomId : 0),
      ok: Number(msg.code) === RES_CODE.OK,
      ts: Date.now()
    };
  });

  // ── Frame builder (mirrors cwg-proto-tap's buildFrame) ───────────────────
  // CWG wire format: [4-byte BE uint32: 2+bodyLen][2-byte BE uint16: msgId][body bytes]
  // MessageId 50109 = ActionReq
  var ACTION_REQ_MSG_ID = 50109;

  function buildActionFrame(roomId, action, coin) {
    var proto = window.protobuf;
    if (!proto || !proto.roots || !proto.roots['default']) {
      throw new Error('window.protobuf not available');
    }
    var root = proto.roots['default'];
    var ActionReq = root.lookupType('holdem.ActionReq');
    var body = ActionReq.encode(ActionReq.create({
      roomId: roomId,
      action: action,
      coin: coin || 0
    })).finish();

    var frame = new Uint8Array(6 + body.length);
    var dv = new DataView(frame.buffer);
    dv.setUint32(0, 2 + body.length, false); // BE length = msgId(2) + body
    dv.setUint16(4, ACTION_REQ_MSG_ID, false);
    frame.set(body, 6);
    return frame.buffer;
  }

  // ── Guard: is it hero's turn? ─────────────────────────────────────────────
  function assertHeroTurn() {
    var gs = window.CWGGameStatus.get();
    if (!gs.isHeroTurn) {
      return { accepted: false, reason: 'not your turn' };
    }
    return null;
  }

  // ── Send helper ───────────────────────────────────────────────────────────
  function sendAction(action, coin) {
    var guard = assertHeroTurn();
    if (guard) return guard;

    var gs = window.CWGGameStatus.get();
    var roomId = gs.roomId;
    if (!roomId) {
      // Try CWGRoomConfig as fallback
      if (window.CWGRoomConfig) {
        var rc = window.CWGRoomConfig.get();
        roomId = rc.roomId;
      }
    }
    if (!roomId) return { accepted: false, reason: 'roomId unknown' };

    var wsStatus = window.CWGProtoTap.getSocketStatus();
    if (!wsStatus || !wsStatus.connected) {
      // Fallback: try DOM-level click via CWGActionCore
      return domFallback(action, coin);
    }

    try {
      var buf = buildActionFrame(Number(roomId), action, coin || 0);
      window.CWGProtoTap.sendRaw(buf);
      return { accepted: true, method: 'proto', action: action, coin: coin || 0 };
    } catch (e) {
      console.error(TAG, 'sendAction failed:', e.message);
      // Fallback to DOM click
      return domFallback(action, coin);
    }
  }

  // ── DOM fallback ──────────────────────────────────────────────────────────
  function domFallback(action, coin) {
    if (!window.CWGActionCore) {
      return { accepted: false, reason: 'proto send failed and CWGActionCore not available' };
    }
    var btnMap = {};
    btnMap[ACTION.FOLD] = 'Fold';
    btnMap[ACTION.CHECK] = 'Check';
    btnMap[ACTION.CALL] = 'Call';
    btnMap[ACTION.BET] = 'Bet';
    btnMap[ACTION.RAISE] = 'Raise';
    btnMap[ACTION.ALL_IN] = 'AllIn';
    var btnName = btnMap[action];
    if (!btnName) return { accepted: false, reason: 'unknown action for DOM fallback' };
    var result = window.CWGActionCore.clickButton(btnName);
    return { accepted: !!result, method: 'dom_fallback', action: action };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGProtoAction = {
    fold: function () { return sendAction(ACTION.FOLD, 0); },
    check: function () { return sendAction(ACTION.CHECK, 0); },
    call: function () {
      var gs = window.CWGGameStatus.get();
      return sendAction(ACTION.CALL, Number(gs.toCall || 0));
    },
    bet: function (amount) { return sendAction(ACTION.BET, Number(amount || 0)); },
    raise: function (amount) { return sendAction(ACTION.RAISE, Number(amount || 0)); },
    allin: function () {
      var gs = window.CWGGameStatus.get();
      return sendAction(ACTION.ALL_IN, Number(gs.hero ? gs.hero.stack : 0));
    },
    send: function (action, coin) { return sendAction(action, coin); },
    getLastActionResult: function () { return _lastResult; }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'proto_fold',
    function () { return window.CWGProtoAction.fold(); },
    'Send FOLD action via protobuf wire (highest reliability). Gates on isHeroTurn.',
    {}
  );

  _bridge.addTool(
    'proto_check',
    function () { return window.CWGProtoAction.check(); },
    'Send CHECK action via protobuf wire. Gates on isHeroTurn.',
    {}
  );

  _bridge.addTool(
    'proto_call',
    function () { return window.CWGProtoAction.call(); },
    'Send CALL action via protobuf wire (auto-reads toCall from game status). Gates on isHeroTurn.',
    {}
  );

  _bridge.addTool(
    'proto_bet',
    function (args) {
      var amount = (args && args.amount !== undefined) ? args.amount : 0;
      // If amount is a string expression, resolve via CWGProtoActionAmount if available
      if (typeof amount === 'string' && window.CWGProtoActionAmount) {
        amount = window.CWGProtoActionAmount.resolve(amount);
      }
      return window.CWGProtoAction.bet(Number(amount));
    },
    'Send BET action via protobuf wire with exact amount. Pass { amount: 500 } or { amount: "2bb" } if cwg-proto-action-amount is loaded.',
    { type: 'object', properties: { amount: { description: 'Chip amount (number) or sizing string like "2bb", "pot", "half"' } }, required: ['amount'] }
  );

  _bridge.addTool(
    'proto_raise',
    function (args) {
      var amount = (args && args.amount !== undefined) ? args.amount : 0;
      if (typeof amount === 'string' && window.CWGProtoActionAmount) {
        amount = window.CWGProtoActionAmount.resolve(amount);
      }
      return window.CWGProtoAction.raise(Number(amount));
    },
    'Send RAISE action via protobuf wire with exact amount. Pass { amount: 1200 } or { amount: "pot" } if cwg-proto-action-amount is loaded.',
    { type: 'object', properties: { amount: { description: 'Chip amount (number) or sizing string like "pot", "75", "3bb"' } }, required: ['amount'] }
  );

  _bridge.addTool(
    'proto_allin',
    function () { return window.CWGProtoAction.allin(); },
    'Send ALL_IN action via protobuf wire (uses hero.stack from game status). Gates on isHeroTurn.',
    {}
  );

  _bridge.addTool(
    'get_last_action_result',
    function () { return window.CWGProtoAction.getLastActionResult(); },
    'Returns the most recent ActionRes from the server: { code, roomId, ok, ts }. ok=true means the server accepted the action.',
    {}
  );

  console.log(TAG, 'registered');
})();
