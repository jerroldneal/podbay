/**
 * PodBay Identity Plugin
 *
 * Detects window identity from URL parameters (windowType, game_id, _egc, etc.)
 * and exposes it as window.PodBayIdentity.
 *
 * Usage:
 *   var id = window.PodBayIdentity;
 *   id.clientId  // 'cwg-lobby', 'cwg-table-GAME123', 'cwg-window-5', etc.
 *   id.type      // 'lobby', 'table', 'window', 'unknown'
 *   id.gameId    // game ID or null
 *   id.roomId    // room ID or null
 *   id.title     // live getter — always returns current document.title
 *   id.url       // URL at detection time
 *
 * Useful for any plugin that needs to know which CWG window it's running in,
 * or needs a stable clientId for broker registration.
 */
;(function () {
  'use strict';

  if (window.PodBayIdentity) return;

  var params;
  try { params = new URL(location.href).searchParams; } catch (_) { params = new URLSearchParams(''); }

  var windowType = params.get('windowType');
  var windowId   = params.get('window_id');
  var egcRaw     = params.get('_egc');

  var gameId = params.get('game_id') || params.get('gameId') || null;
  var roomId = params.get('room_id') || params.get('roomId') || null;

  if (!gameId && egcRaw) {
    try {
      var egc = JSON.parse(decodeURIComponent(egcRaw));
      gameId = egc.game_id || egc.gameId || null;
      roomId = egc.room_id || egc.roomId || null;
    } catch (_) {
      gameId = egcRaw.substring(0, 8);
    }
  }

  var type, clientId;
  if (windowType === '1') {
    type = 'lobby';
    clientId = 'cwg-lobby';
  } else if (gameId) {
    type = 'table';
    clientId = 'cwg-table-' + gameId + (roomId ? '-' + roomId : '');
  } else if (windowId) {
    type = 'window';
    clientId = 'cwg-window-' + windowId;
  } else {
    type = 'unknown';
    clientId = 'cwg-' + Math.random().toString(36).substr(2, 6);
  }

  var identity = {
    clientId: clientId,
    lobbyClientId: 'cwg-lobby',
    type: type,
    gameId: gameId,
    roomId: roomId,
    windowType: windowType,
    windowId: windowId,
    url: location.href,
    get isGame() { return type === 'table'; },
    get isLobby() { return type === 'lobby'; }
  };

  Object.defineProperty(identity, 'title', {
    get: function () { return document.title || ''; },
    enumerable: true
  });

  window.PodBayIdentity = identity;
})();
