; (function () {
  'use strict';

  if (window.CWGLobbyControl) return;

  var TAG = '[CWGLobbyControl]';

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

  // ── CWG Wire Protocol helpers ─────────────────────────────────────────────

  // Build a raw CWG wire frame: [4-byte BE uint32: 2+bodyLen][2-byte BE uint16: msgId][protobuf body]
  function buildFrame(msgId, body) {
    var frame = new Uint8Array(6 + body.length);
    var dv = new DataView(frame.buffer);
    dv.setUint32(0, 2 + body.length, false);
    dv.setUint16(4, msgId, false);
    frame.set(body, 6);
    return frame.buffer;
  }

  // Encode a protobuf varint
  function encodeVarint(val) {
    var bytes = [];
    var v = val >>> 0;
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return new Uint8Array(bytes);
  }

  // Encode a uint32 field: tag = (fieldNum << 3) | wireType(0)
  function encodeUint32Field(fieldNum, value) {
    var tag = encodeVarint((fieldNum << 3) | 0);
    var val = encodeVarint(value >>> 0);
    var out = new Uint8Array(tag.length + val.length);
    out.set(tag, 0);
    out.set(val, tag.length);
    return out;
  }

  // MessageIDs
  var MSG_LEAVE_ROOM_REQ = 50008;
  var MSG_ROOM_SNAPSHOT_REQ = 50005;

  // ── Leave Room ────────────────────────────────────────────────────────────

  function leaveRoom() {
    var gs = window.CWGGameStatus.get();

    if (gs.isHeroTurn) {
      return { sent: false, reason: 'Cannot leave room while it is hero\'s turn — make an action first' };
    }

    // Build LeaveRoomReq — minimal: just roomId (field 1)
    var roomId = (gs.roomId || 0) >>> 0;
    var body = roomId > 0 ? encodeUint32Field(1, roomId) : new Uint8Array(0);
    var frame = buildFrame(MSG_LEAVE_ROOM_REQ, body);

    var ok = window.CWGProtoTap.sendRaw(frame);
    if (!ok) return { sent: false, reason: 'sendRaw failed — WebSocket not available' };

    return { sent: true, msgId: MSG_LEAVE_ROOM_REQ, roomId: roomId };
  }

  // ── Request Room Snapshot ─────────────────────────────────────────────────

  function requestRoomSnapshot() {
    var gs = window.CWGGameStatus.get();
    var roomId = (gs.roomId || 0) >>> 0;
    var body = roomId > 0 ? encodeUint32Field(1, roomId) : new Uint8Array(0);
    var frame = buildFrame(MSG_ROOM_SNAPSHOT_REQ, body);

    var ok = window.CWGProtoTap.sendRaw(frame);
    if (!ok) return { sent: false, reason: 'sendRaw failed — WebSocket not available' };

    return { sent: true, msgId: MSG_ROOM_SNAPSHOT_REQ, roomId: roomId };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGLobbyControl = {
    leaveRoom: leaveRoom,
    requestRoomSnapshot: requestRoomSnapshot
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'leave_room',
    function () {
      return window.CWGLobbyControl.leaveRoom();
    },
    'Send LeaveRoomReq to leave the current game room. Requires isHeroTurn === false — will refuse if it is currently hero\'s turn.',
    {}
  );

  _bridge.addTool(
    'request_room_snapshot',
    function () {
      return window.CWGLobbyControl.requestRoomSnapshot();
    },
    'Send RoomSnapshotReq to trigger a full game state refresh from the server. Useful to synchronize CWGGameStatus after reconnect or if state looks stale.',
    {}
  );

  console.log(TAG, 'registered');
})();
