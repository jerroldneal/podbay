; (function () {
  'use strict';

  if (window.CWGFlipHook) return;

  var TAG = '[CWGFlipHook]';
  var MAX_FLIP_LOG = 500;
  var flipLog = [];
  var _installed = false;

  // Skip lobby windows
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  // Walk up from a sprite component to find a Holdem_Card_ts (has flipCardAction)
  function findCardComp(spriteComp) {
    var node = (spriteComp && spriteComp.node) ? spriteComp.node : spriteComp;
    for (var depth = 0; depth < 4; depth++) {
      if (!node) break;
      var comps = node._components || [];
      for (var i = 0; i < comps.length; i++) {
        if (typeof comps[i].flipCardAction === 'function') return comps[i];
      }
      node = node.parent || node._parent;
    }
    return null;
  }

  /**
   * Called from cwg-opponent-cards sprite setter on first card seen.
   * Finds and hooks the Holdem_Card_ts prototype (walk up from spriteComp).
   * Also bootstraps cwg-verbose-hook once flipCardAction fires (passing `this`).
   */
  function tryBootstrap(spriteComp) {
    if (_installed) return;
    var cardComp = findCardComp(spriteComp);
    if (!cardComp) return;

    var proto = Object.getPrototypeOf(cardComp);
    if (!proto || proto.__cwgFlipHooked) { _installed = true; return; }

    var origFlip = proto.flipCardAction;
    if (typeof origFlip !== 'function') return;

    proto.flipCardAction = function (holder, scale, cardId) {
      try {
        // Store pending flip so the sprite setter can validate the face event
        if (cardId != null && this.sprite && this.sprite._id != null) {
          if (window.CWGHandLifecycle) {
            window.CWGHandLifecycle.setPendingFlip(this.sprite._id, cardId);
          }
        }

        // Bootstrap verbose hook on first invoke — 'this' is Holdem_Card_ts
        if (window.CWGVerboseHook && !window.CWGVerboseHook.isInstalled()) {
          window.CWGVerboseHook.tryBootstrap(this);
        }

        // Log flip event
        var card = window.CWGCardAtlas ? window.CWGCardAtlas.decode(cardId) : null;
        var handIdx = window.CWGHandLifecycle ? window.CWGHandLifecycle.getHandIndex() : 0;
        var spriteNode = (this.sprite && this.sprite.node) ? this.sprite.node : null;
        var seatIdx = -1;
        if (spriteNode && window.CWGCore) {
          // Walk up to find holdem_player_pkw
          var n = spriteNode.parent || spriteNode._parent;
          var dep = 0;
          while (n && dep < 15) {
            if (window.CWGCore.nodeName(n) === 'holdem_player_pkw') {
              var par = n.parent || n._parent;
              if (par) {
                var sibs = par._children || par.children || [];
                for (var si = 0; si < sibs.length; si++) { if (sibs[si] === n) { seatIdx = si; break; } }
              }
              break;
            }
            n = n.parent || n._parent; dep++;
          }
        }
        flipLog.push({
          ts: performance.now(), wallMs: Date.now(),
          clock: new Date().toTimeString().slice(0, 8),
          cardId: cardId, card: card,
          spriteId: this.sprite ? this.sprite._id : null,
          seatIndex: seatIdx, handIndex: handIdx
        });
        if (flipLog.length > MAX_FLIP_LOG) flipLog.shift();
      } catch (e) { /* never propagate */ }
      return origFlip.apply(this, arguments);
    };

    proto.__cwgFlipHooked = true;
    _installed = true;
    console.log(TAG + ' flipCardAction hooked (stale-node filter active)');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGFlipHook = {
    tryBootstrap: tryBootstrap,
    isInstalled: function () { return _installed; },
    getFlipLog: function (last) { return last ? flipLog.slice(-last) : flipLog.slice(); },
    clearFlipLog: function () { flipLog.length = 0; },
    status: function () {
      return {
        installed: _installed,
        logSize: flipLog.length,
        maxLogSize: MAX_FLIP_LOG,
        ready: _installed && flipLog.length >= 0
      };
    }
  };

  // ── MCP tool ──────────────────────────────────────────────────────────────
  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG + ' PodBayBridge not available'); return; }

  _bridge.addTool(
    'get_flip_log',
    function (p) {
      var last = p && p.last ? parseInt(p.last, 10) : null;
      return {
        success: true, installed: _installed, logSize: flipLog.length,
        entries: last ? flipLog.slice(-last) : flipLog.slice()
      };
    },
    'Get the flipCardAction call log (all card flips including board cards)',
    { last: { type: 'number', description: 'Return last N entries (default: all)' } }
  );

  console.log(TAG + ' registered');
})();
