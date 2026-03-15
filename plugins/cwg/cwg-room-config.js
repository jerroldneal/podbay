; (function () {
  'use strict';

  if (window.CWGRoomConfig) return;

  var TAG = '[CWGRoomConfig]';

  if (!window.CWGProtoTap) {
    console.warn(TAG, 'CWGProtoTap not found — cwg-proto-tap must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── State ────────────────────────────────────────────────────────────────
  var _config = {
    roomId: null,
    gameType: null,   // 'holdem'
    limitType: null,   // 'no_limit' | 'limit' | 'pot_limit'
    smallBlind: null,
    bigBlind: null,
    ante: null,
    maxSeats: null,
    minBuyIn: null,
    maxBuyIn: null,
    timeLimit: null,   // seconds per action
    tourId: null,
    tourName: null,
    levelDuration: null    // seconds per blind level
  };

  // Limit type string normalisation
  var LIMIT_MAP = { 0: 'no_limit', 1: 'limit', 2: 'pot_limit', 'NO_LIMIT': 'no_limit', 'LIMIT': 'limit', 'POT_LIMIT': 'pot_limit' };

  function applyMsg(msg) {
    if (!msg) return;

    if (msg.roomId !== undefined) _config.roomId = String(msg.roomId);
    if (msg.tourId !== undefined) _config.tourId = String(msg.tourId);
    if (msg.tourName !== undefined) _config.tourName = String(msg.tourName);

    // Blind / stake info
    if (msg.smallBlind !== undefined) _config.smallBlind = Number(msg.smallBlind);
    if (msg.bigBlind !== undefined) _config.bigBlind = Number(msg.bigBlind);
    if (msg.ante !== undefined) _config.ante = Number(msg.ante);
    if (msg.minBuyIn !== undefined) _config.minBuyIn = Number(msg.minBuyIn);
    if (msg.maxBuyIn !== undefined) _config.maxBuyIn = Number(msg.maxBuyIn);
    if (msg.maxSeats !== undefined) _config.maxSeats = Number(msg.maxSeats);
    if (msg.timeLimit !== undefined) _config.timeLimit = Number(msg.timeLimit);
    if (msg.levelDuration !== undefined) _config.levelDuration = Number(msg.levelDuration);

    // Limit type
    if (msg.limitType !== undefined) {
      _config.limitType = LIMIT_MAP[msg.limitType] || String(msg.limitType);
    }
    if (msg.gameType !== undefined) {
      _config.gameType = String(msg.gameType).toLowerCase();
    } else {
      _config.gameType = 'holdem'; // default for this socket
    }
  }

  // ── Proto-tap subscriptions ───────────────────────────────────────────────

  // EnterRoomRes (50004) — fired on successful room join, contains full room config
  CWGProtoTap.on('EnterRoomRes', function (decoded) {
    applyMsg(decoded.msg);
  });

  // RoomSnapshotMsg (50006) — also carries roomId and basic config fields
  CWGProtoTap.on('RoomSnapshotMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    // Only pull config-level fields (not seat state — that's game-status's job)
    var configFields = {};
    if (msg.roomId !== undefined) configFields.roomId = msg.roomId;
    if (msg.tourId !== undefined) configFields.tourId = msg.tourId;
    if (msg.tourName !== undefined) configFields.tourName = msg.tourName;
    if (msg.smallBlind !== undefined) configFields.smallBlind = msg.smallBlind;
    if (msg.bigBlind !== undefined) configFields.bigBlind = msg.bigBlind;
    if (msg.ante !== undefined) configFields.ante = msg.ante;
    if (msg.maxSeats !== undefined) configFields.maxSeats = msg.maxSeats;
    if (msg.timeLimit !== undefined) configFields.timeLimit = msg.timeLimit;
    if (msg.limitType !== undefined) configFields.limitType = msg.limitType;
    applyMsg(configFields);
  });

  // BlindStructureMsg (50120) — tournament blind structure, may carry level duration
  CWGProtoTap.on('BlindStructureMsg', function (decoded) {
    var msg = decoded.msg;
    if (!msg) return;
    if (msg.levelDuration !== undefined) _config.levelDuration = Number(msg.levelDuration);
    if (msg.timeLimit !== undefined) _config.timeLimit = Number(msg.timeLimit);
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGRoomConfig = {
    get: function () {
      return JSON.parse(JSON.stringify(_config));
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────
  _bridge.addTool(
    'get_room_config',
    function () {
      return window.CWGRoomConfig.get();
    },
    'Returns room configuration: roomId, gameType, limitType, blinds, ante, buyIn range, seat count, timeLimit, tourId, tourName, levelDuration',
    {}
  );

  console.log(TAG, 'registered');
})();
