/**
 * PodBay Identity Plugin
 *
 * Detects window identity from URL parameters (windowType, game_id, _egc, etc.)
 *
 * Usage:
 *   var identity = require('identity');
 *   identity.clientId  // 'cwg-lobby', 'cwg-table-GAME123', etc.
 *   identity.type      // 'lobby', 'table', 'window', 'unknown'
 *   identity.isGame    // true if table
 *   identity.isLobby   // true if lobby
 */
'use strict';

var params;
try { params = new URL(location.href).searchParams; } catch (_) { params = new URLSearchParams(''); }

var windowType = params.get('windowType');
var windowId = params.get('window_id');
var egcRaw = params.get('_egc');

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

// Also install on window for backward compat
window.PodBayIdentity = identity;

module.exports = identity;
