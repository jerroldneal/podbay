; (function () {
  'use strict';

  if (window.CWGLobbyStatus) return;

  var TAG = '[CWGLobbyStatus]';

  if (!window.CWGProtoTap) {
    console.warn(TAG, 'CWGProtoTap not found — cwg-proto-tap must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Account info — captured from EnterRoomRes / PlayerInfo messages ───────
  var _account = {
    displayName: null,
    userId: null,
    freeChips: null,
    paidChips: null,
    totalBalance: null,
    ts: null
  };

  // ── Tournament list — captured from lobby-level messages ──────────────────
  var _tournaments = [];

  // ── Listen to EnterRoomRes (50004) — contains hero player info ───────────
  CWGProtoTap.on('EnterRoomRes', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    // heroInfo / selfInfo / playerInfo depending on schema
    var info = msg.heroInfo || msg.selfInfo || msg.playerInfo || msg.player || null;
    if (!info) {
      // Some schemas embed directly on msg
      info = msg;
    }

    var name = info.displayName || info.name || info.nickName || null;
    var uid = info.userId || info.uid || msg.userId || null;
    var free = info.freeChips || info.goldCoin || info.chips || null;
    var paid = info.paidChips || info.paidCoin || null;
    var total = info.totalBalance || info.totalChips || info.balance || null;

    if (name || uid || free != null) {
      if (name) _account.displayName = String(name);
      if (uid) _account.userId = String(uid);
      if (free != null) _account.freeChips = Number(free);
      if (paid != null) _account.paidChips = Number(paid);
      if (total != null) _account.totalBalance = Number(total);
      _account.ts = Date.now();
    }
  });

  // ── RoomSnapshotMsg (50006) — also carries seat/player info ───────────────
  CWGProtoTap.on('RoomSnapshotMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    // Iterate seats to find hero's own seat for balance info
    var seats = msg.seats || msg.seatList || [];
    var heroId = null;
    // Try to get heroId from game status if available
    if (window.CWGGameStatus) {
      var gs = window.CWGGameStatus.get();
      if (gs.hero) heroId = String(gs.hero.playerId || gs.hero.userId || '');
    }

    seats.forEach(function (seat) {
      if (!seat) return;
      var uid = String(seat.userId || seat.playerId || '');
      if (heroId && uid !== heroId) return;

      var name = seat.displayName || seat.name || seat.nickName;
      if (name && !_account.displayName) {
        _account.displayName = String(name);
        _account.userId = uid;
        _account.ts = Date.now();
      }
    });
  });

  // ── TournamentInfoMsg (50122) — tournament list snapshots ─────────────────
  CWGProtoTap.on('TournamentInfoMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;

    // If it's an array/list of tournaments
    var list = msg.tournamentList || msg.tournaments || (Array.isArray(msg) ? msg : null);
    if (!list) {
      // Single tournament info
      var t = {
        tourId: msg.tourId || msg.tournamentId || null,
        name: msg.tourName || msg.name || null,
        buyIn: msg.buyIn || msg.entryFee || null,
        startTime: msg.startTime || msg.startTs || null,
        registered: msg.playerCount || msg.registered || null,
        maxPlayers: msg.maxPlayers || msg.playerLimit || null,
        prizePool: msg.prizePool || null,
        status: msg.status || null,
        ts: Date.now()
      };
      if (t.tourId) {
        // Upsert
        var idx = _tournaments.findIndex(function (x) { return x.tourId === t.tourId; });
        if (idx >= 0) _tournaments[idx] = t;
        else _tournaments.push(t);
      }
    } else {
      list.forEach(function (item) {
        if (!item) return;
        var t = {
          tourId: item.tourId || item.tournamentId || null,
          name: item.tourName || item.name || null,
          buyIn: item.buyIn || item.entryFee || null,
          startTime: item.startTime || item.startTs || null,
          registered: item.playerCount || item.registered || null,
          maxPlayers: item.maxPlayers || item.playerLimit || null,
          prizePool: item.prizePool || null,
          status: item.status || null,
          ts: Date.now()
        };
        if (!t.tourId) return;
        var idx = _tournaments.findIndex(function (x) { return x.tourId === t.tourId; });
        if (idx >= 0) _tournaments[idx] = t;
        else _tournaments.push(t);
      });
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGLobbyStatus = {
    getAccount: function () {
      return JSON.parse(JSON.stringify(_account));
    },
    getTournaments: function () {
      return _tournaments.slice();
    },
    reset: function () {
      _account = { displayName: null, userId: null, freeChips: null, paidChips: null, totalBalance: null, ts: null };
      _tournaments = [];
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'get_account_info',
    function () {
      return window.CWGLobbyStatus.getAccount();
    },
    'Returns hero account info: { displayName, userId, freeChips, paidChips, totalBalance, ts }. Populated from EnterRoomRes and RoomSnapshotMsg.',
    {}
  );

  _bridge.addTool(
    'get_lobby_tournaments',
    function () {
      return window.CWGLobbyStatus.getTournaments();
    },
    'Returns list of observed tournaments. Each entry: { tourId, name, buyIn, startTime, registered, maxPlayers, prizePool, status }',
    {}
  );

  console.log(TAG, 'registered');
})();
