; (function () {
  'use strict';

  if (window.CWGStrategyHook) return;

  var TAG = '[CWGStrategyHook]';

  if (!window.CWGGameStatus) {
    console.warn(TAG, 'CWGGameStatus not found — cwg-game-status must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Strategy modes ────────────────────────────────────────────────────────
  // "off"           — strategy hook disabled
  // "validate_only" — compute decision but DO NOT execute — return for inspection only
  // "auto"          — compute and auto-execute (requires explicit opt-in)
  var _mode = 'off';

  // ── Registered strategy fn ────────────────────────────────────────────────
  // A strategy is any function(gameState) → { action, amount? }
  // External code can set window.CWGStrategyHook.setStrategy(fn)
  var _strategyFn = null;

  // ── Decision state ────────────────────────────────────────────────────────
  var _lastDecision = null;

  // ── Built-in fallback strategies ─────────────────────────────────────────

  var _builtInStrategies = {
    // Always fold (useful for testing)
    always_fold: function () {
      return { action: 'fold', amount: null };
    },

    // Call/check if possible, else fold
    passive: function (gs) {
      var ac = gs.actionConstraints || {};
      if (ac.canCheck !== false) return { action: 'check', amount: null };
      var toCall = Number(ac.toCall || 0);
      if (toCall > 0) return { action: 'call', amount: toCall };
      return { action: 'fold', amount: null };
    },

    // Tight: fold unless we have hole cards with rank A or K
    tight_fold: function (gs) {
      var hero = gs.hero || {};
      var cards = hero.holeCards || [];
      var hasAK = cards.some(function (c) {
        var rank = c % 100;
        return rank === 1 || rank === 13 || rank === 12;
      });
      if (!hasAK) return { action: 'fold', amount: null };
      var ac = gs.actionConstraints || {};
      if (ac.canCheck !== false) return { action: 'check', amount: null };
      return { action: 'call', amount: Number(ac.toCall || 0) };
    }
  };

  // ── Decision execution ────────────────────────────────────────────────────

  function computeDecision() {
    var gs = window.CWGGameStatus.get();

    if (!_strategyFn) {
      return { action: null, amount: null, reason: 'No strategy function registered. Use set_strategy_mode with a built-in, or call CWGStrategyHook.setStrategy(fn).' };
    }

    try {
      var decision = _strategyFn(gs);
      _lastDecision = {
        action: decision && decision.action ? decision.action : null,
        amount: decision && decision.amount != null ? Number(decision.amount) : null,
        ts: Date.now(),
        mode: _mode,
        gamePhase: gs.phase || null,
        street: gs.street || null
      };
      return _lastDecision;
    } catch (e) {
      return { action: null, amount: null, reason: 'Strategy function threw: ' + e.message };
    }
  }

  // ── Auto-execution on NeedActionMsg (only when mode === "auto") ───────────
  CWGProtoTap && CWGProtoTap.on('NeedActionMsg', function () {
    if (_mode !== 'auto') return;
    var decision = computeDecision();
    if (!decision || !decision.action) return;

    // Route through CWGProtoAction if available, else CWGActionCore
    var action = decision.action.toLowerCase();
    var amt = decision.amount;

    if (window.CWGProtoAction) {
      try {
        switch (action) {
          case 'fold': window.CWGProtoAction.fold(); break;
          case 'check': window.CWGProtoAction.check(); break;
          case 'call': window.CWGProtoAction.call(); break;
          case 'bet': window.CWGProtoAction.bet(amt); break;
          case 'raise': window.CWGProtoAction.raise(amt); break;
          case 'allin': window.CWGProtoAction.allin(); break;
          default: console.warn(TAG, 'unknown action from strategy:', action);
        }
      } catch (e) {
        console.error(TAG, 'auto-execute failed', e);
      }
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGStrategyHook = {
    setMode: function (mode) {
      if (!['off', 'validate_only', 'auto'].includes(mode)) {
        return { ok: false, reason: 'Invalid mode. Use: off, validate_only, auto' };
      }
      _mode = mode;
      return { ok: true, mode: _mode };
    },
    getMode: function () { return _mode; },

    setStrategy: function (fn) {
      if (typeof fn !== 'function') return false;
      _strategyFn = fn;
      return true;
    },
    setBuiltIn: function (name) {
      if (!_builtInStrategies[name]) {
        return { ok: false, reason: 'Unknown built-in: ' + name + '. Options: ' + Object.keys(_builtInStrategies).join(', ') };
      }
      _strategyFn = _builtInStrategies[name];
      return { ok: true, strategy: name };
    },
    listBuiltIns: function () {
      return Object.keys(_builtInStrategies);
    },

    getDecision: computeDecision,
    getLastDecision: function () { return _lastDecision; }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'set_strategy_mode',
    function (args) {
      var mode = args && args.mode;
      if (!mode) return { ok: false, reason: 'mode is required. Options: off, validate_only, auto' };
      var result = window.CWGStrategyHook.setMode(mode);
      if (result.ok && args.strategy) {
        return window.CWGStrategyHook.setBuiltIn(args.strategy);
      }
      return result;
    },
    'Set strategy mode: "off" (disabled), "validate_only" (compute but do not execute), "auto" (compute and auto-execute). Optionally set a built-in strategy: always_fold, passive, tight_fold.',
    {
      type: 'object',
      properties: {
        mode: { description: 'Strategy mode: off, validate_only, auto' },
        strategy: { description: 'Optional built-in strategy name: always_fold, passive, tight_fold' }
      },
      required: ['mode']
    }
  );

  _bridge.addTool(
    'get_strategy_decision',
    function () {
      return window.CWGStrategyHook.getDecision();
    },
    'Runs the registered strategy against current game state and returns { action, amount } without executing. Useful in validate_only mode.',
    {}
  );

  _bridge.addTool(
    'get_strategy_status',
    function () {
      return {
        mode: window.CWGStrategyHook.getMode(),
        hasStrategy: _strategyFn !== null,
        lastDecision: window.CWGStrategyHook.getLastDecision(),
        builtIns: window.CWGStrategyHook.listBuiltIns()
      };
    },
    'Returns current strategy hook status: mode, whether a strategy is set, last decision, and available built-in strategy names.',
    {}
  );

  console.log(TAG, 'registered');
})();
