'use strict';

  var TAG = '[CWGProtoActionAmount]';

  var CWGGameStatus = require('cwg-game-status');

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Amount resolver ───────────────────────────────────────────────────────
  // Resolves human-readable bet sizing strings to exact chip amounts.
  //
  // Supported expressions:
  //   "min"         → minBet from NeedActionMsg
  //   "max"         → maxBet (effective stack)
  //   "allin"       → hero.stack
  //   "pot"         → pot × 1.0, rounded up to nearest bigBlind
  //   "half"        → pot × 0.5, rounded up to nearest bigBlind
  //   "75"          → pot × 0.75 (percentage as string with no "%")
  //   "2bb"/"Nbb"   → bigBlind × N
  //   "2x"/"Nx"     → toCall × N (times-the-call sizing)
  //   raw number    → exact chips (pass-through)
  //
  // All amounts are rounded to the nearest chip (integer).
  // Returns null if expression is unrecognised or inputs are missing.

  var BB_RE = /^(\d+(?:\.\d+)?)bb$/i;   // e.g. "2bb", "2.5bb"
  var TIMES_RE = /^(\d+(?:\.\d+)?)x$/i;   // e.g. "3x"
  var PCT_RE = /^(\d+(?:\.\d+)?)(%)?$/;  // e.g. "75" or "75%" — treat as pot pct

  function roundToChip(n) { return Math.round(n); }
  function roundToBB(n, bb) { if (!bb || bb <= 0) return roundToChip(n); return Math.ceil(n / bb) * bb; }

  function resolve(expr) {
    if (expr === null || expr === undefined) return null;

    // Already a number — pass through
    if (typeof expr === 'number') return roundToChip(expr);

    var s = String(expr).trim().toLowerCase();

    // Fetch current game state
    var gs = window.CWGGameStatus.get();
    var pot = gs.pot || 0;
    var bb = gs.minBet || (window.CWGRoomConfig ? window.CWGRoomConfig.get().bigBlind : 0) || 1;
    var min = gs.minBet || 0;
    var max = gs.maxBet || 0;

    // Normalise bb from RoomConfig if game status hasn't seen a NeedActionMsg yet
    if (!bb && window.CWGRoomConfig) {
      var rc = window.CWGRoomConfig.get();
      bb = rc.bigBlind || 1;
    }

    var stack = gs.hero ? (gs.hero.stack || 0) : 0;
    var toCall = gs.toCall || 0;

    switch (s) {
      case 'min': return min || null;
      case 'max': return max || stack;
      case 'allin': return stack;
      case 'pot': return roundToBB(pot * 1.0, bb);
      case 'half': return roundToBB(pot * 0.5, bb);
      case '2pot': return roundToBB(pot * 2.0, bb);
    }

    // "Nbb" — N times big blind
    var mBB = BB_RE.exec(s);
    if (mBB) {
      var mult = parseFloat(mBB[1]);
      return roundToChip(bb * mult);
    }

    // "Nx" — N times the call
    var mX = TIMES_RE.exec(s);
    if (mX) {
      var factor = parseFloat(mX[1]);
      return roundToChip(toCall * factor);
    }

    // "75" or "75%" — percentage of pot
    var mPct = PCT_RE.exec(s);
    if (mPct) {
      var pct = parseFloat(mPct[1]);
      if (pct > 0) return roundToBB(pot * (pct / 100), bb);
    }

    // Fallback: try parsing as raw integer
    var raw = parseFloat(s);
    if (!isNaN(raw)) return roundToChip(raw);

    console.warn(TAG, 'unrecognised amount expression:', expr);
    return null;
  }

  // ── Public API ────────────────────────────────────────────────────────────
var CWGProtoActionAmount = {
    resolve: resolve
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'resolve_amount',
    function (args) {
      if (!args || args.amount === undefined) {
        return { error: 'amount required' };
      }
      var chips = resolve(args.amount);
      var gs = window.CWGGameStatus.get();
      return {
        expression: args.amount,
        chips: chips,
        pot: gs.pot,
        bigBlind: (window.CWGRoomConfig ? window.CWGRoomConfig.get().bigBlind : null),
        toCall: gs.toCall,
        heroStack: gs.hero ? gs.hero.stack : null
      };
    },
    'Resolve a bet sizing expression to exact chips. Pass { amount: "2bb" } or { amount: "pot" } etc. Returns chips value and the game state used for calculation.',
    { type: 'object', properties: { amount: { description: 'Sizing expression: "min","max","allin","pot","half","2bb","Nbb","75","3x" or a raw number' } }, required: ['amount'] }
  );

  // Wired convenience tools — proto_bet / proto_raise also call resolve() inline when
  // a string is passed, but these standalone tools let callers preview the resolved amount
  // before committing.

  _bridge.addTool(
    'proto_bet_amount',
    function (args) {
      if (!window.CWGProtoAction) return { error: 'cwg-proto-action not loaded' };
      var chips = resolve(args && args.amount);
      if (chips === null) return { error: 'could not resolve amount: ' + args.amount };
      return window.CWGProtoAction.bet(chips);
    },
    'Resolve sizing expression then send BET via protobuf. { amount: "2bb" | "pot" | 500 | ... }',
    { type: 'object', properties: { amount: { description: 'Sizing expression or raw chip amount' } }, required: ['amount'] }
  );

  _bridge.addTool(
    'proto_raise_amount',
    function (args) {
      if (!window.CWGProtoAction) return { error: 'cwg-proto-action not loaded' };
      var chips = resolve(args && args.amount);
      if (chips === null) return { error: 'could not resolve amount: ' + args.amount };
      return window.CWGProtoAction.raise(chips);
    },
    'Resolve sizing expression then send RAISE via protobuf. { amount: "3x" | "75" | 1200 | ... }',
    { type: 'object', properties: { amount: { description: 'Sizing expression or raw chip amount' } }, required: ['amount'] }
  );

  console.log(TAG, 'registered');

module.exports = CWGProtoActionAmount;
window.CWGProtoActionAmount = CWGProtoActionAmount;
