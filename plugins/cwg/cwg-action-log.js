; (function () {
  'use strict';

  if (window.CWGActionLog) return;

  var TAG = '[CWGActionLog]';

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

  // ── Hero action log ring buffer (max 200 entries) ─────────────────────────
  var MAX_LOG = 200;
  var _log = [];

  // Track last ActionRes received so we can annotate the most recent hero action
  var _lastActionRes = null;

  // Subscribe to ActionRes to capture server acknowledgement
  CWGProtoTap.on('ActionRes', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    _lastActionRes = {
      code: Number(msg.code !== undefined ? msg.code : -1),
      roomId: Number(msg.roomId !== undefined ? msg.roomId : 0),
      ok: Number(msg.code) === 0,
      ts: Date.now()
    };
    // Annotate the last hero action entry with this result
    for (var i = _log.length - 1; i >= 0; i--) {
      if (!_log[i].result) {
        _log[i].result = JSON.parse(JSON.stringify(_lastActionRes));
        break;
      }
    }
  });

  // ── Helper: current street ────────────────────────────────────────────────
  function currentStreet(community) {
    var n = community ? community.length : 0;
    if (n === 0) return 'preflop';
    if (n === 3) return 'flop';
    if (n === 4) return 'turn';
    if (n === 5) return 'river';
    return 'unknown';
  }

  // ── PlayerActionMsg — record hero actions only ────────────────────────────
  CWGProtoTap.on('PlayerActionMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    var gs = window.CWGGameStatus.get();
    var heroSeat = gs.hero ? gs.hero.seat : null;
    if (heroSeat === null) return;

    var seatIdx = Number(msg.seatIndex !== undefined ? msg.seatIndex : msg.seat);
    if (seatIdx !== heroSeat) return; // not hero — skip

    var street = currentStreet(gs.community);

    var entry = {
      ts: Date.now(),
      handIndex: gs.handIndex || 0,
      street: street,
      action: msg.action || msg.actionType || null,
      amount: Number(msg.coin || 0),
      pot: gs.pot || 0,
      heroStack: gs.hero ? gs.hero.stack : null,
      result: null   // filled in by ActionRes listener above
    };

    _log.push(entry);
    if (_log.length > MAX_LOG) _log.shift();
  });

  // ── NeedActionMsg — log decision points (when hero is asked to act) ───────
  CWGProtoTap.on('NeedActionMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    var gs = window.CWGGameStatus.get();
    var street = currentStreet(gs.community);

    // Record as a special "decision_point" entry (not an action, just context)
    var entry = {
      ts: Date.now(),
      handIndex: gs.handIndex || 0,
      street: street,
      action: 'DECISION_POINT',
      toCall: Number(msg.toCall || msg.callAmount || 0),
      minBet: Number(msg.minBet || msg.minRaise || 0),
      maxBet: Number(msg.maxBet || msg.maxRaise || 0),
      timeLimit: Number(msg.timeLimit || msg.countDown || 0),
      pot: gs.pot || 0,
      heroStack: gs.hero ? gs.hero.stack : null,
      result: null
    };

    _log.push(entry);
    if (_log.length > MAX_LOG) _log.shift();
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGActionLog = {
    getLog: function (n) {
      var count = n || 30;
      return _log.slice(-count);
    },
    getLastActionResult: function () {
      return _lastActionRes;
    },
    clearLog: function () {
      _log = [];
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'get_action_log',
    function (args) {
      var n = (args && args.last) ? Number(args.last) : 30;
      return window.CWGActionLog.getLog(n);
    },
    'Returns last N hero actions (default 30). Each entry: { ts, handIndex, street, action, amount, pot, heroStack, result }. DECISION_POINT entries show action options at hero decision moments.',
    { type: 'object', properties: { last: { description: 'Number of entries to return (default 30)' } } }
  );

  _bridge.addTool(
    'get_last_action_result_log',
    function () {
      return window.CWGActionLog.getLastActionResult();
    },
    'Returns the most recent ActionRes from the server for a hero action: { code, ok, ts }',
    {}
  );

  _bridge.addTool(
    'clear_action_log',
    function () {
      window.CWGActionLog.clearLog();
      return { cleared: true };
    },
    'Clear the hero action log',
    {}
  );

  console.log(TAG, 'registered');
})();
