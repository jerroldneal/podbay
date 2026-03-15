; (function () {
  'use strict';

  if (window.CWGTournamentStatus) return;

  var TAG = '[CWGTournamentStatus]';

  if (!window.CWGProtoTap) {
    console.warn(TAG, 'CWGProtoTap not found — cwg-proto-tap must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── State ────────────────────────────────────────────────────────────────
  var _state = {
    tourId: null,
    tourName: null,
    // Current blind level
    level: null,
    smallBlind: null,
    bigBlind: null,
    ante: null,
    levelDuration: null,   // seconds per level
    levelStartTs: null,   // epoch ms when current level started
    // Player counts
    playersEntered: null,
    playersRunning: null,
    playersEliminated: null,
    // Prize pool
    prizePool: null,
    // Blind schedule (array of { level, sb, bb, ante, duration })
    blindSchedule: [],
    // Hero stats (populated from CWGGameStatus if available)
    heroStack: null,
    heroRank: null,
    heroMRatio: null
  };

  // ── M-ratio calculation ───────────────────────────────────────────────────
  function calcMRatio(stack, sb, bb, ante) {
    var orbit = (sb || 0) + (bb || 0) + (ante || 0);
    if (!orbit || orbit <= 0) return null;
    return Math.round((stack / orbit) * 10) / 10;
  }

  function refreshHeroStats() {
    if (!window.CWGGameStatus || !_state.smallBlind) return;
    var gs = window.CWGGameStatus.get();
    if (!gs) return;
    var heroStack = gs.hero ? gs.hero.stack : null;
    if (heroStack !== null && heroStack > 0) {
      _state.heroStack = heroStack;
      _state.heroMRatio = calcMRatio(heroStack, _state.smallBlind, _state.bigBlind, _state.ante);
    }
  }

  // ── Level time remaining ──────────────────────────────────────────────────
  function levelTimeRemaining() {
    if (!_state.levelStartTs || !_state.levelDuration) return null;
    var elapsed = Math.floor((Date.now() - _state.levelStartTs) / 1000);
    var remaining = _state.levelDuration - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  // ── Proto-tap subscriptions ───────────────────────────────────────────────

  // TournamentInfoMsg (50122) — player counts, prize pool, tour metadata
  CWGProtoTap.on('TournamentInfoMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (msg.tourId !== undefined) _state.tourId = String(msg.tourId);
    if (msg.tourName !== undefined) _state.tourName = String(msg.tourName);

    if (msg.playersEntered !== undefined) _state.playersEntered = Number(msg.playersEntered);
    if (msg.playersRunning !== undefined) _state.playersRunning = Number(msg.playersRunning);
    if (msg.playersEliminated !== undefined) _state.playersEliminated = Number(msg.playersEliminated);
    else if (_state.playersEntered !== null && _state.playersRunning !== null) {
      _state.playersEliminated = _state.playersEntered - _state.playersRunning;
    }

    if (msg.prizePool !== undefined) _state.prizePool = Number(msg.prizePool);

    // Current blind level info may be embedded
    if (msg.level !== undefined) _state.level = Number(msg.level);
    if (msg.sb !== undefined) _state.smallBlind = Number(msg.sb);
    if (msg.bb !== undefined) _state.bigBlind = Number(msg.bb);
    if (msg.ante !== undefined) _state.ante = Number(msg.ante);

    refreshHeroStats();
  });

  // TournamentLevelMsg (50124) — blind level change
  CWGProtoTap.on('TournamentLevelMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    if (msg.level !== undefined) _state.level = Number(msg.level);
    if (msg.sb !== undefined) _state.smallBlind = Number(msg.sb);
    if (msg.bb !== undefined) _state.bigBlind = Number(msg.bb);
    if (msg.ante !== undefined) _state.ante = Number(msg.ante);
    if (msg.duration !== undefined) {
      _state.levelDuration = Number(msg.duration);
      _state.levelStartTs = Date.now();
    }

    refreshHeroStats();
  });

  // BlindStructureMsg (50120) — full blind schedule
  CWGProtoTap.on('BlindStructureMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    var levels = msg.levels || msg.blindLevels || msg.schedule || [];
    if (levels.length) {
      _state.blindSchedule = levels.map(function (l) {
        return {
          level: Number(l.level || 0),
          sb: Number(l.sb || l.smallBlind || 0),
          bb: Number(l.bb || l.bigBlind || 0),
          ante: Number(l.ante || 0),
          duration: Number(l.duration || 0)
        };
      });
    }

    // Current level may also be in this message
    if (msg.currentLevel !== undefined) {
      var cur = msg.currentLevel;
      if (cur.sb !== undefined) _state.smallBlind = Number(cur.sb);
      if (cur.bb !== undefined) _state.bigBlind = Number(cur.bb);
      if (cur.ante !== undefined) _state.ante = Number(cur.ante);
      if (cur.level !== undefined) _state.level = Number(cur.level);
      if (cur.duration !== undefined) {
        _state.levelDuration = Number(cur.duration);
        if (!_state.levelStartTs) _state.levelStartTs = Date.now();
      }
    }

    refreshHeroStats();
  });

  // PlayerRankMsg (50126) — hero rank update
  CWGProtoTap.on('PlayerRankMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    if (msg.rank !== undefined) _state.heroRank = Number(msg.rank);
    refreshHeroStats();
  });

  // EnterRoomRes (50004) — may carry tourId / tourName on entry
  CWGProtoTap.on('EnterRoomRes', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    if (msg.tourId !== undefined && !_state.tourId) _state.tourId = String(msg.tourId);
    if (msg.tourName !== undefined && !_state.tourName) _state.tourName = String(msg.tourName);
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGTournamentStatus = {
    get: function () {
      refreshHeroStats();
      var snap = JSON.parse(JSON.stringify(_state));
      snap.levelTimeRemaining = levelTimeRemaining();
      return snap;
    },
    getMRatio: function () {
      refreshHeroStats();
      return _state.heroMRatio;
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────
  _bridge.addTool(
    'get_tournament_status',
    function () {
      return window.CWGTournamentStatus.get();
    },
    'Returns full tournament snapshot: tourId, tourName, current blind level (sb/bb/ante), levelDuration, levelTimeRemaining, playersEntered/Running/Eliminated, prizePool, heroStack, heroRank, heroMRatio, blindSchedule',
    {}
  );

  _bridge.addTool(
    'get_blind_info',
    function () {
      refreshHeroStats();
      return {
        level: _state.level,
        smallBlind: _state.smallBlind,
        bigBlind: _state.bigBlind,
        ante: _state.ante,
        levelTimeRemaining: levelTimeRemaining()
      };
    },
    'Returns current blind level number, small blind, big blind, ante, and seconds remaining in this level',
    {}
  );

  _bridge.addTool(
    'get_m_ratio',
    function () {
      refreshHeroStats();
      return {
        heroStack: _state.heroStack,
        smallBlind: _state.smallBlind,
        bigBlind: _state.bigBlind,
        ante: _state.ante,
        mRatio: _state.heroMRatio
      };
    },
    'Returns hero M-ratio (stack / (SB + BB + ante)) — key tournament survival metric',
    {}
  );

  console.log(TAG, 'registered');
})();
