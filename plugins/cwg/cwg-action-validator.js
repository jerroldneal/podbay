; (function () {
  'use strict';

  if (window.CWGActionValidator) return;

  var TAG = '[CWGActionValidator]';

  if (!window.CWGGameStatus) {
    console.warn(TAG, 'CWGGameStatus not found — cwg-game-status must load first');
    return;
  }

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  // ── Action enum mapping ───────────────────────────────────────────────────
  var ACTION_NAMES = { 1: 'check', 2: 'call', 3: 'bet', 4: 'fold', 5: 'raise', 6: 'allin' };

  // ── Validators ────────────────────────────────────────────────────────────

  function validate(action, amount) {
    var gs = window.CWGGameStatus.get();

    if (!gs.isHeroTurn) {
      return { valid: false, reason: 'Not hero\'s turn' };
    }

    var ac = gs.actionConstraints || {};
    var hero = gs.hero || {};

    var actionLower = (action || '').toLowerCase();

    switch (actionLower) {
      case 'fold':
        return { valid: true, reason: null };

      case 'check':
        if (ac.canCheck === false) {
          return { valid: false, reason: 'Check not available — there is a bet to call' };
        }
        return { valid: true, reason: null };

      case 'call': {
        var toCall = Number(ac.toCall || ac.callAmount || 0);
        if (toCall <= 0) {
          return { valid: false, reason: 'No bet to call' };
        }
        if (hero.stack !== undefined && toCall > hero.stack) {
          return {
            valid: true,
            reason: 'Call amount (' + toCall + ') exceeds stack (' + hero.stack + ') — will become all-in',
            actualAmount: hero.stack
          };
        }
        return { valid: true, reason: null, amount: toCall };
      }

      case 'bet': {
        var betAmt = Number(amount || 0);
        var minBet = Number(ac.minBet || ac.minRaise || 0);
        var maxBet = Number(ac.maxBet || hero.stack || 0);
        if (ac.canCheck === false) {
          return { valid: false, reason: 'Bet not available — there is already a bet; use raise instead' };
        }
        if (betAmt <= 0) {
          return { valid: false, reason: 'Bet amount required', minBet: minBet, maxBet: maxBet };
        }
        if (betAmt < minBet) {
          return { valid: false, reason: 'Bet ' + betAmt + ' below minimum ' + minBet, minBet: minBet, maxBet: maxBet };
        }
        if (betAmt > maxBet) {
          return { valid: false, reason: 'Bet ' + betAmt + ' exceeds maximum ' + maxBet, minBet: minBet, maxBet: maxBet };
        }
        return { valid: true, reason: null, amount: betAmt };
      }

      case 'raise': {
        var raiseAmt = Number(amount || 0);
        var minRaise = Number(ac.minRaise || ac.minBet || 0);
        var maxRaise = Number(ac.maxRaise || ac.maxBet || hero.stack || 0);
        if (raiseAmt <= 0) {
          return { valid: false, reason: 'Raise amount required', minRaise: minRaise, maxRaise: maxRaise };
        }
        if (raiseAmt < minRaise) {
          return { valid: false, reason: 'Raise ' + raiseAmt + ' below minimum ' + minRaise, minRaise: minRaise, maxRaise: maxRaise };
        }
        if (raiseAmt > maxRaise) {
          return { valid: false, reason: 'Raise ' + raiseAmt + ' exceeds maximum ' + maxRaise, minRaise: minRaise, maxRaise: maxRaise };
        }
        return { valid: true, reason: null, amount: raiseAmt };
      }

      case 'allin':
        return { valid: true, reason: null, amount: hero.stack || 0 };

      default:
        return { valid: false, reason: 'Unknown action: ' + action };
    }
  }

  function getLegalActions() {
    var gs = window.CWGGameStatus.get();
    if (!gs.isHeroTurn) {
      return [];
    }

    var ac = gs.actionConstraints || {};
    var hero = gs.hero || {};
    var legal = [];

    // Fold always legal on hero's turn
    legal.push({ action: 'fold' });

    if (ac.canCheck !== false) {
      legal.push({ action: 'check' });
    }

    var toCall = Number(ac.toCall || ac.callAmount || 0);
    if (toCall > 0) {
      legal.push({
        action: 'call',
        amount: Math.min(toCall, hero.stack || toCall),
        isAllIn: hero.stack !== undefined && toCall >= hero.stack
      });
    }

    var minBet = Number(ac.minBet || 0);
    var maxBet = Number(ac.maxBet || hero.stack || 0);
    if (ac.canCheck !== false && minBet > 0) {
      legal.push({ action: 'bet', minAmount: minBet, maxAmount: maxBet });
    }

    var minRaise = Number(ac.minRaise || ac.minBet || 0);
    var maxRaise = Number(ac.maxRaise || ac.maxBet || hero.stack || 0);
    if (ac.canCheck === false && minRaise > 0) {
      legal.push({ action: 'raise', minAmount: minRaise, maxAmount: maxRaise });
    }

    // All-in always legal on hero's turn if has chips
    if (hero.stack > 0) {
      legal.push({ action: 'allin', amount: hero.stack });
    }

    return legal;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGActionValidator = {
    validate: validate,
    getLegalActions: getLegalActions
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'validate_action',
    function (args) {
      var action = args && args.action;
      var amount = args && args.amount;
      if (!action) return { valid: false, reason: 'action is required' };
      return window.CWGActionValidator.validate(action, amount);
    },
    'Validates a proposed action against current game state. Returns { valid, reason, amount? }. Actions: fold, check, call, bet, raise, allin. For bet/raise, include amount.',
    {
      type: 'object',
      properties: {
        action: { description: 'Action to validate: fold, check, call, bet, raise, allin' },
        amount: { description: 'Chip amount (required for bet and raise)' }
      },
      required: ['action']
    }
  );

  _bridge.addTool(
    'get_legal_actions',
    function () {
      return window.CWGActionValidator.getLegalActions();
    },
    'Returns array of currently legal actions with valid amount ranges. Example: [{ action: "fold" }, { action: "call", amount: 200 }, { action: "raise", minAmount: 400, maxAmount: 8000 }]',
    {}
  );

  console.log(TAG, 'registered');
})();
