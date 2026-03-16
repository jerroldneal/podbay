'use strict';

  var TAG = '[CWGGameStatus]';

  // ── Dependency check ─────────────────────────────────────────────────────
  var CWGProtoTap = require('cwg-proto-tap');

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Card decode helper ────────────────────────────────────────────────────
  // CWG card format inside protobuf: number field where
  //   value % 100 = rank (1=A,2-9,10=T,11=J,12=Q,13=K), value / 100 = suit (1=♠,2=♥,3=♦,4=♣)
  var SUIT_SYMBOLS = { 1: '♠', 2: '♥', 3: '♦', 4: '♣' };
  var RANK_SYMBOLS = { 1: 'A', 10: 'T', 11: 'J', 12: 'Q', 13: 'K' };

  function decodeCard(v) {
    if (!v || v === 0) return null;
    var n = Number(v);
    var suit = Math.floor(n / 100);
    var rank = n % 100;
    var rankStr = RANK_SYMBOLS[rank] || String(rank);
    var suitStr = SUIT_SYMBOLS[suit] || '?';
    return rankStr + suitStr;
  }

  function decodeCards(arr) {
    if (!arr || !arr.length) return [];
    return arr.map(decodeCard).filter(Boolean);
  }

  // ── State ────────────────────────────────────────────────────────────────
  function freshState() {
    return {
      handIndex: 0,
      phase: 'idle',    // preflop | flop | turn | river | showdown | idle
      dealerSeat: null,
      activeSeat: null,
      pot: 0,
      sidePots: [],
      community: [],
      seats: [],         // [{ seat, playerId, displayName, stack, bet, state, holeCards }]
      hero: {
        seat: null,
        holeCards: [],
        stack: 0
      },
      toCall: 0,
      minBet: 0,
      maxBet: 0,
      isHeroTurn: false,
      actionTimeLimit: 0,
      lastActionTs: null
    };
  }

  var _state = freshState();
  var _lastModTs = 0;
  var _onChangedFns = [];

  // ── Mutation helper ───────────────────────────────────────────────────────
  function touch() {
    _lastModTs = Date.now();
    // Signal-fetch: emit tiny signal so broker clients know to re-fetch
    try {
      _bridge.notify({ type: 'game_status_changed', ts: _lastModTs });
    } catch (e) { /* bridge may not support notify — silent */ }
    for (var i = 0; i < _onChangedFns.length; i++) {
      try { _onChangedFns[i](_state); } catch (e) { }
    }
  }

  // ── Seat helpers ─────────────────────────────────────────────────────────
  function getSeat(seatIndex) {
    for (var i = 0; i < _state.seats.length; i++) {
      if (_state.seats[i].seat === seatIndex) return _state.seats[i];
    }
    return null;
  }

  function getOrCreateSeat(seatIndex, playerId) {
    var s = getSeat(seatIndex);
    if (!s) {
      s = { seat: seatIndex, playerId: playerId || null, displayName: null, stack: 0, bet: 0, state: 'WAITING', holeCards: null };
      _state.seats.push(s);
      _state.seats.sort(function (a, b) { return a.seat - b.seat; });
    }
    if (playerId && !s.playerId) s.playerId = playerId;
    return s;
  }

  // ── Community card count → phase ─────────────────────────────────────────
  function phaseFromCommunityCount(n) {
    if (n === 3) return 'flop';
    if (n === 4) return 'turn';
    if (n === 5) return 'river';
    return _state.phase; // no change if count not recognised
  }

  // ── Proto-tap subscriptions ───────────────────────────────────────────────

  // RoomSnapshotMsg (50006) — full room state on enter
  CWGProtoTap.on('RoomSnapshotMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (msg.roomId !== undefined) _state.roomId = msg.roomId;
    if (msg.dealerSeat !== undefined) _state.dealerSeat = Number(msg.dealerSeat);
    if (msg.handIndex !== undefined) _state.handIndex = Number(msg.handIndex);
    if (msg.potSize !== undefined) _state.pot = Number(msg.potSize);

    // Community cards if mid-hand snapshot
    if (msg.communityCards && msg.communityCards.length) {
      _state.community = decodeCards(msg.communityCards);
      _state.phase = phaseFromCommunityCount(_state.community.length);
    }

    // Seats
    if (msg.seats && msg.seats.length) {
      _state.seats = [];
      for (var i = 0; i < msg.seats.length; i++) {
        var raw = msg.seats[i];
        var seat = {
          seat: Number(raw.seatIndex !== undefined ? raw.seatIndex : raw.seat),
          playerId: raw.playerId || raw.uid || null,
          displayName: raw.playerName || raw.name || null,
          stack: Number(raw.stack || raw.coin || 0),
          bet: Number(raw.bet || 0),
          state: raw.state || 'WAITING',
          holeCards: null
        };
        _state.seats.push(seat);
      }
      _state.seats.sort(function (a, b) { return a.seat - b.seat; });
    }

    touch();
  });

  // HoleCardListMsg (50037) — sent to hero at deal time, identifies hero's seat
  CWGProtoTap.on('HoleCardListMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    // This message identifies which seat is the hero for this hand
    if (msg.seatIndex !== undefined || msg.seat !== undefined) {
      var heroSeat = Number(msg.seatIndex !== undefined ? msg.seatIndex : msg.seat);
      _state.hero.seat = heroSeat;
    }
    // Cards may appear here too — also captured by HoleCardsMsg (50104)
    if (msg.cards && msg.cards.length) {
      _state.hero.holeCards = decodeCards(msg.cards);
    }
    if (msg.stack !== undefined) {
      _state.hero.stack = Number(msg.stack);
    }
    touch();
  });

  // HoleCardsMsg (50104) — hero's own hole cards
  CWGProtoTap.on('HoleCardsMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (msg.cards && msg.cards.length) {
      _state.hero.holeCards = decodeCards(msg.cards);
    } else if (msg.card1 !== undefined && msg.card2 !== undefined) {
      _state.hero.holeCards = [decodeCard(msg.card1), decodeCard(msg.card2)].filter(Boolean);
    }
    // Mark preflop when hero receives hole cards
    if (_state.phase === 'idle') _state.phase = 'preflop';
    touch();
  });

  // BoardCardsMsg (50106) — community cards (flop/turn/river)
  CWGProtoTap.on('BoardCardsMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    var cards = [];
    if (msg.cards && msg.cards.length) {
      cards = decodeCards(msg.cards);
    }
    if (cards.length) {
      _state.community = cards;
      _state.phase = phaseFromCommunityCount(cards.length);
    }
    touch();
  });

  // PotsMsg (50034) — pot update (note: 50120 in doc may be BlindStructureMsg — 50034 confirmed)
  CWGProtoTap.on('PotsMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (msg.potSize !== undefined) {
      _state.pot = Number(msg.potSize);
    } else if (msg.pots && msg.pots.length) {
      // Sum all pots if broken out
      var total = 0;
      var sides = [];
      for (var i = 0; i < msg.pots.length; i++) {
        var amt = Number(msg.pots[i].amount || msg.pots[i].size || 0);
        if (i === 0) total = amt;
        else { sides.push(amt); total += amt; }
      }
      _state.pot = total;
      _state.sidePots = sides;
    }
    touch();
  });

  // BlindMsg (50060) — posted blind → phase becomes preflop
  CWGProtoTap.on('BlindMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (_state.phase === 'idle') _state.phase = 'preflop';
    // Track dealer seat update if present
    if (msg.dealerSeat !== undefined) _state.dealerSeat = Number(msg.dealerSeat);
    touch();
  });

  // NeedActionMsg (50112) — it's hero's turn
  CWGProtoTap.on('NeedActionMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    _state.isHeroTurn = true;
    _state.activeSeat = _state.hero.seat;
    _state.toCall = Number(msg.toCall || msg.callAmount || 0);
    _state.minBet = Number(msg.minBet || msg.minRaise || 0);
    _state.maxBet = Number(msg.maxBet || msg.maxRaise || msg.stack || 0);
    _state.actionTimeLimit = Number(msg.timeLimit || msg.countDown || 0);
    _state.hero.toCall = _state.toCall;
    _state.hero.minBet = _state.minBet;
    _state.hero.maxBet = _state.maxBet;
    _state.lastActionTs = Date.now();
    touch();
  });

  // PlayerActionMsg (50036) — any player acted (including hero)
  CWGProtoTap.on('PlayerActionMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    var seatIndex = Number(msg.seatIndex !== undefined ? msg.seatIndex : msg.seat);

    // If this is the hero, clear turn flag
    if (_state.hero.seat !== null && seatIndex === _state.hero.seat) {
      _state.isHeroTurn = false;
    }

    // Update seat bet / stack if present
    var seat = getSeat(seatIndex);
    if (seat) {
      if (msg.coin !== undefined) seat.bet = Number(msg.coin);
      if (msg.stack !== undefined) seat.stack = Number(msg.stack);
      if (msg.remaining !== undefined) seat.stack = Number(msg.remaining);
    }
    // Update hero stack if it's the hero's seat
    if (_state.hero.seat !== null && seatIndex === _state.hero.seat) {
      if (msg.stack !== undefined) _state.hero.stack = Number(msg.stack);
      if (msg.remaining !== undefined) _state.hero.stack = Number(msg.remaining);
    }

    _state.lastAction = {
      seat: seatIndex,
      action: msg.action || msg.actionType || null,
      amount: Number(msg.coin || 0),
      ts: Date.now()
    };
    _state.lastActionTs = _state.lastAction.ts;
    touch();
  });

  // ShowdownMsg (50114) — opponent hole cards revealed
  CWGProtoTap.on('ShowdownMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    _state.phase = 'showdown';

    // showdown may have an array of seat/cards entries
    var entries = msg.players || msg.seats || msg.results || null;
    if (entries && entries.length) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var seatIdx = Number(e.seatIndex !== undefined ? e.seatIndex : e.seat);
        var cards = e.cards || e.holeCards || [];
        var seat = getOrCreateSeat(seatIdx);
        if (cards.length) seat.holeCards = decodeCards(cards);
      }
    } else if (msg.seatIndex !== undefined && msg.cards) {
      var s = getOrCreateSeat(Number(msg.seatIndex));
      s.holeCards = decodeCards(msg.cards);
    }
    touch();
  });

  // RoundResultMsg (50116) — hand complete; update stacks, advance handIndex, reset to idle
  CWGProtoTap.on('RoundResultMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    _state.phase = 'idle';
    _state.isHeroTurn = false;
    _state.community = [];
    _state.sidePots = [];
    _state.pot = 0;
    _state.toCall = 0;
    _state.minBet = 0;
    _state.maxBet = 0;
    _state.lastAction = null;

    if (msg.handIndex !== undefined) _state.handIndex = Number(msg.handIndex);
    else _state.handIndex++;

    // Update stacks from chip deltas if provided
    var results = msg.players || msg.results || [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var seatIdx = Number(r.seatIndex !== undefined ? r.seatIndex : r.seat);
      var seat = getSeat(seatIdx);
      if (seat) {
        if (r.stack !== undefined) seat.stack = Number(r.stack);
        if (r.remaining !== undefined) seat.stack = Number(r.remaining);
        seat.bet = 0;
        seat.holeCards = null;
      }
      if (_state.hero.seat !== null && seatIdx === _state.hero.seat) {
        if (r.stack !== undefined) _state.hero.stack = Number(r.stack);
        if (r.remaining !== undefined) _state.hero.stack = Number(r.remaining);
      }
    }

    // Clear hero hole cards for new hand
    _state.hero.holeCards = [];
    // Clear seat hole cards
    for (var j = 0; j < _state.seats.length; j++) {
      _state.seats[j].holeCards = null;
      _state.seats[j].bet = 0;
    }
    touch();
  });

  // DealMsg (50100) — new hand deal: enter preflop
  CWGProtoTap.on('DealMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    _state.phase = 'preflop';
    _state.community = [];
    _state.isHeroTurn = false;
    if (msg.handIndex !== undefined) _state.handIndex = Number(msg.handIndex);
    if (msg.dealerSeat !== undefined) _state.dealerSeat = Number(msg.dealerSeat);
    touch();
  });

  // ── Public API ────────────────────────────────────────────────────────────
var CWGGameStatus = {
    get: function () {
      return JSON.parse(JSON.stringify(_state));
    },
    getLastModified: function () {
      return _lastModTs;
    },
    onChanged: function (fn) {
      if (typeof fn === 'function') _onChangedFns.push(fn);
    },
    reset: function () {
      _state = freshState();
      _lastModTs = 0;
      touch();
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'get_game_status',
    function () {
      return window.CWGGameStatus.get();
    },
    'Returns the full accumulated game status snapshot (phase, seats, pot, community cards, hero info, action options)',
    {}
  );

  _bridge.addTool(
    'get_hero',
    function () {
      var s = window.CWGGameStatus.get();
      return { seat: s.hero.seat, holeCards: s.hero.holeCards, stack: s.hero.stack };
    },
    'Returns hero seat index, hole cards, and current stack',
    {}
  );

  _bridge.addTool(
    'get_action_options',
    function () {
      var s = window.CWGGameStatus.get();
      return {
        isHeroTurn: s.isHeroTurn,
        toCall: s.toCall,
        minBet: s.minBet,
        maxBet: s.maxBet,
        timeRemaining: s.actionTimeLimit
      };
    },
    'Returns current action options for the hero (isHeroTurn, toCall, minBet, maxBet, timeRemaining)',
    {}
  );

  console.log(TAG, 'registered — watching CWGProtoTap events');

module.exports = CWGGameStatus;
window.CWGGameStatus = CWGGameStatus;
