; (function () {
  'use strict';

  if (window.CWGHandResult) return;

  var TAG = '[CWGHandResult]';

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

  // ── Hand history ring buffer (max 50 hands) ───────────────────────────────
  var MAX_HANDS = 50;
  var _history = [];

  // ── Current hand accumulator ──────────────────────────────────────────────
  var _current = null;

  function freshHand(handIndex) {
    return {
      handIndex: handIndex,
      startTs: Date.now(),
      endTs: null,
      dealerSeat: null,
      community: [],
      seats: [],       // [{ seat, playerId, displayName, stack, holeCards }]
      actions: [],       // [{ street, seat, action, amount, ts }]
      pot: 0,
      pots: [],       // final pot breakdown from RoundResultMsg
      winners: [],       // [{ seat, playerId, amount, handType, cards }]
      heroSeat: null,
      heroCards: [],
      complete: false
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function currentStreet(community) {
    var n = community ? community.length : 0;
    if (n === 0) return 'preflop';
    if (n === 3) return 'flop';
    if (n === 4) return 'turn';
    if (n === 5) return 'river';
    return 'unknown';
  }

  function seatFromList(list, seatIndex) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].seat === seatIndex) return list[i];
    }
    return null;
  }

  function syncSeatMetadata() {
    if (!_current) return;
    var gs = window.CWGGameStatus.get();
    _current.heroSeat = gs.hero ? gs.hero.seat : null;
    _current.heroCards = gs.hero ? (gs.hero.holeCards || []) : [];
    _current.dealerSeat = gs.dealerSeat;
    _current.community = gs.community ? gs.community.slice() : [];

    // Sync seats from game status
    for (var i = 0; i < gs.seats.length; i++) {
      var gsSeat = gs.seats[i];
      var existing = seatFromList(_current.seats, gsSeat.seat);
      if (!existing) {
        _current.seats.push({
          seat: gsSeat.seat,
          playerId: gsSeat.playerId,
          displayName: gsSeat.displayName,
          stack: gsSeat.stack,
          holeCards: null
        });
      }
    }
  }

  // ── Proto-tap subscriptions ───────────────────────────────────────────────

  // DealMsg (50100) or BlindMsg (50060) — new hand starts
  function startHand(handIndex) {
    var gs = window.CWGGameStatus.get();
    _current = freshHand(handIndex !== undefined ? handIndex : (gs.handIndex || 0));
    _current.dealerSeat = gs.dealerSeat;
    _current.heroSeat = gs.hero ? gs.hero.seat : null;
  }

  CWGProtoTap.on('DealMsg', function (decoded) {
    var msg = decoded.msg;
    startHand(msg && msg.handIndex !== undefined ? Number(msg.handIndex) : undefined);
    syncSeatMetadata();
  });

  // HoleCardsMsg (50104) — hero cards
  CWGProtoTap.on('HoleCardsMsg', function () {
    if (!_current) {
      var gs = window.CWGGameStatus.get();
      startHand(gs.handIndex);
    }
    syncSeatMetadata();
  });

  // PlayerActionMsg (50036) — record every action
  CWGProtoTap.on('PlayerActionMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg || !_current) return;

    var gs = window.CWGGameStatus.get();
    var street = currentStreet(gs.community);
    var seatIdx = Number(msg.seatIndex !== undefined ? msg.seatIndex : msg.seat);
    _current.actions.push({
      street: street,
      seat: seatIdx,
      action: msg.action || msg.actionType || null,
      amount: Number(msg.coin || 0),
      ts: Date.now()
    });
    _current.pot = gs.pot || _current.pot;
    syncSeatMetadata();
  });

  // ShowdownMsg (50114) — capture opponent hole cards
  CWGProtoTap.on('ShowdownMsg', function () {
    if (!_current) return;
    syncSeatMetadata();
    // Pull showdown cards from game status seats
    var gs = window.CWGGameStatus.get();
    for (var i = 0; i < gs.seats.length; i++) {
      var gsSeat = gs.seats[i];
      if (gsSeat.holeCards) {
        var seat = seatFromList(_current.seats, gsSeat.seat);
        if (seat) seat.holeCards = gsSeat.holeCards.slice();
      }
    }
  });

  // RoundResultMsg (50116) — hand complete; record winners and finalise
  CWGProtoTap.on('RoundResultMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    if (!_current) {
      var gs0 = window.CWGGameStatus.get();
      startHand(gs0.handIndex);
    }

    syncSeatMetadata();

    _current.endTs = Date.now();
    _current.complete = true;

    // Final community from game status
    var gs = window.CWGGameStatus.get();
    if (gs.community && gs.community.length) _current.community = gs.community.slice();

    // Winners
    var results = msg.players || msg.results || msg.winners || [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var winAmount = Number(r.winAmount || r.profit || r.amount || 0);
      if (winAmount > 0) {
        _current.winners.push({
          seat: Number(r.seatIndex !== undefined ? r.seatIndex : r.seat),
          playerId: r.playerId || null,
          amount: winAmount,
          handType: r.handType || r.handName || null,
          cards: r.cards || null
        });
      }
      // Update final stacks
      var seatIdx = Number(r.seatIndex !== undefined ? r.seatIndex : r.seat);
      var seat = seatFromList(_current.seats, seatIdx);
      if (seat && r.stack !== undefined) seat.stack = Number(r.stack);
    }

    // Pot breakdown
    if (msg.pots && msg.pots.length) {
      _current.pots = msg.pots.map(function (p) {
        return { amount: Number(p.amount || 0), playerIds: p.playerIds || [] };
      });
      _current.pot = _current.pots.reduce(function (sum, p) { return sum + p.amount; }, 0);
    }

    // Push to history ring buffer
    _history.push(JSON.parse(JSON.stringify(_current)));
    if (_history.length > MAX_HANDS) _history.shift();

    _current = null;
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGHandResult = {
    getLastHand: function () {
      return _history.length ? _history[_history.length - 1] : null;
    },
    getHistory: function (n) {
      var count = n || 10;
      return _history.slice(-count);
    },
    clearHistory: function () {
      _history = [];
    },
    getCurrentHand: function () {
      return _current ? JSON.parse(JSON.stringify(_current)) : null;
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'get_last_hand',
    function () {
      return window.CWGHandResult.getLastHand();
    },
    'Returns the most recently completed hand: board, all seat hole cards (showdown), all actions in sequence, pot, winners with hand type',
    {}
  );

  _bridge.addTool(
    'get_hand_history',
    function (args) {
      var n = (args && args.n) ? Number(args.n) : 10;
      return window.CWGHandResult.getHistory(n);
    },
    'Returns last N completed hands (default 10, max 50). Each entry includes board, seats, actions, pot, winners.',
    { type: 'object', properties: { n: { description: 'Number of hands to return (default 10)' } } }
  );

  _bridge.addTool(
    'get_current_hand',
    function () {
      return window.CWGHandResult.getCurrentHand();
    },
    'Returns the in-progress hand accumulator (incomplete hand, real-time state)',
    {}
  );

  _bridge.addTool(
    'clear_hand_history',
    function () {
      window.CWGHandResult.clearHistory();
      return { cleared: true };
    },
    'Clear all stored hand history',
    {}
  );

  console.log(TAG, 'registered');
})();
