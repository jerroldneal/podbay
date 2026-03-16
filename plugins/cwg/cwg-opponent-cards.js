; (function () {
  'use strict';

  if (window.CWGOpponentCards) return;

  var TAG = '[CWGOpponentCards]';
  var MAX_LOG = 500;
  var log = [];
  var paused = false;
  var _hookInstalled = false;

  // End-of-hand cover threshold — covers within 50ms of a face are deal-time; >= 50ms = end of hand
  var COVER_EOH_MS = 50;

  // Skip lobby windows
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  // ── Atlas helpers — delegate to CWGCardAtlas if loaded ───────────────────
  function decode(id) {
    if (window.CWGCardAtlas) return window.CWGCardAtlas.decode(id);
    return null;
  }
  function isBackFace(sfName) {
    if (window.CWGCardAtlas) return window.CWGCardAtlas.isBackFace(sfName);
    return typeof sfName === 'string' && sfName.indexOf('cards_back') === 0;
  }

  // ── Node utilities ─────────────────────────────────────────────────────────
  function nodeNm(node) { return node._name || node.name || ''; }

  function nodePath(node) {
    var parts = [], n = node, depth = 0;
    while (n && depth < 12) {
      var nm = nodeNm(n);
      if (nm) parts.unshift(nm);
      n = n.parent || n._parent;
      depth++;
    }
    return parts.join('/');
  }

  function parentNames(node, limit) {
    var names = [], n = node.parent || node._parent, depth = 0;
    while (n && depth < (limit || 8)) {
      names.push(nodeNm(n) || '(unnamed)');
      n = n.parent || n._parent; depth++;
    }
    return names;
  }

  function resolveSeatIndex(node) {
    var n = node.parent || node._parent, depth = 0;
    while (n && depth < 15) {
      if (nodeNm(n) === 'holdem_player_pkw') {
        var par = n.parent || n._parent;
        if (par) {
          var sibs = par._children || par.children || [];
          for (var i = 0; i < sibs.length; i++) { if (sibs[i] === n) return i; }
        }
        return 0;
      }
      n = n.parent || n._parent; depth++;
    }
    return -1;
  }

  var COMMUNITY_POS = ['F1', 'F2', 'F3', 'T', 'R'];
  function communityCardPos(node) {
    var holdemCard = node.parent || node._parent;
    if (!holdemCard) return null;
    var publicCards = holdemCard.parent || holdemCard._parent;
    if (!publicCards || nodeNm(publicCards) !== 'public_cards') return null;
    var all = publicCards._children || publicCards.children || [];
    var cardKids = all.filter(function (c) { return nodeNm(c) === 'holdem_card'; });
    for (var j = 0; j < cardKids.length; j++) {
      if (cardKids[j] === holdemCard) return COMMUNITY_POS[j] || ('C' + j);
    }
    return null;
  }

  // ── Log append ────────────────────────────────────────────────────────────
  function appendEntry(event, frameId, frameName, spriteComp) {
    if (paused) return;
    var card = decode(frameId);
    var node = (spriteComp && spriteComp.node) ? spriteComp.node : spriteComp;
    var handIdx = window.CWGHandLifecycle ? window.CWGHandLifecycle.getHandIndex() : 0;
    var entry = {
      ts: performance.now(), wallMs: Date.now(),
      clock: new Date().toTimeString().slice(0, 8),
      event: event, card: card, frameId: frameId, frameName: frameName,
      nodePath: nodePath(node), nodeId: spriteComp._id,
      parentNames: parentNames(node, 6),
      seatIndex: resolveSeatIndex(node),
      commPos: communityCardPos(node),
      handIndex: handIdx
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
    window.PodBayCardRevealLog = log; // backward compatibility
  }

  // ── Sprite hook ────────────────────────────────────────────────────────────
  function installHook() {
    if (_hookInstalled) return;
    if (typeof cc === 'undefined' || !cc.Sprite || !cc.Sprite.prototype) {
      setTimeout(installHook, 500); return;
    }

    var proto = cc.Sprite.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'spriteFrame')
      || Object.getOwnPropertyDescriptor(proto, '_spriteFrame');
    if (!descriptor) {
      console.warn(TAG + ' spriteFrame descriptor not found on cc.Sprite.prototype'); return;
    }
    var origSet = descriptor.set, origGet = descriptor.get;
    if (!origSet) { console.warn(TAG + ' spriteFrame setter not found'); return; }

    Object.defineProperty(proto, 'spriteFrame', {
      configurable: true, enumerable: descriptor.enumerable,
      get: origGet,
      set: function (frame) {
        origSet.call(this, frame); // always call original first
        try {
          if (!frame) return;
          var sfName = frame._name || frame.name || '';
          var nodeId = this._id;

          if (isBackFace(sfName)) {
            var lc = window.CWGHandLifecycle;
            if (lc && lc.hasFaceSeen(nodeId)) {
              appendEntry('cover', lc.getLastFaceCard(nodeId) || 0, sfName, this);
              var lastFaceTs = lc.getLastFaceTs(nodeId) || 0;
              var msSinceFace = performance.now() - lastFaceTs;
              lc.clearFaceSeen(nodeId);
              // End-of-hand covers only: wait for 800ms silence then advance hand
              if (msSinceFace >= COVER_EOH_MS) {
                lc.schedule();
              }
            }
            return;
          }

          var frameId = parseInt(sfName, 10);
          if (isNaN(frameId)) return;
          if (!decode(frameId)) return; // not a card frame

          // Bootstrap flip hook (lazy — on first real card seen)
          if (window.CWGFlipHook && !window.CWGFlipHook.isInstalled()) {
            window.CWGFlipHook.tryBootstrap(this);
          }

          // Gate: if flip hook installed, validate against pending flip entry
          var resolvedId = frameId;
          if (window.CWGFlipHook && window.CWGFlipHook.isInstalled()) {
            var lc2 = window.CWGHandLifecycle;
            if (lc2) {
              var pending = lc2.getPendingFlip(nodeId);
              if (!pending || (performance.now() - pending.ts) > 500) return; // stale → drop
              resolvedId = pending.cardId;
              lc2.clearPendingFlip(nodeId);
              if (!decode(resolvedId)) return;
            }
          }

          // Record face or reveal
          var lc3 = window.CWGHandLifecycle;
          if (lc3) {
            if (lc3.hasFaceSeen(nodeId)) {
              lc3.markFaceSeen(nodeId, resolvedId);
              appendEntry('reveal', resolvedId, String(resolvedId), this);
            } else {
              if (lc3.cancel) lc3.cancel(); // cancel any pending new-hand timer
              lc3.markFaceSeen(nodeId, resolvedId);
              appendEntry('face', resolvedId, String(resolvedId), this);
            }
          } else {
            // Fallback: no lifecycle manager
            appendEntry('face', resolvedId, String(resolvedId), this);
          }
        } catch (e) { /* never propagate */ }
      }
    });

    _hookInstalled = true;
    console.log(TAG + ' spriteFrame hook installed');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.CWGOpponentCards = {
    getLog: function (last) { return last ? log.slice(-last) : log.slice(); },
    clear: function () {
      log.length = 0;
      if (window.CWGHandLifecycle) window.CWGHandLifecycle.reset();
    },
    pause: function () { paused = true; },
    resume: function () { paused = false; },
    isHookInstalled: function () { return _hookInstalled },
    status: function () {
      return {
        hookInstalled: _hookInstalled,
        logSize: log.length,
        maxLogSize: MAX_LOG,
        paused: paused,
        ready: _hookInstalled
      };
    }
  };

  // Also expose log reference for backward compat
  window.PodBayCardRevealLog = log;

  // ── MCP tools ─────────────────────────────────────────────────────────────
  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG + ' PodBayBridge not available'); return; }

  _bridge.addTool(
    'get_card_log',
    function (p) {
      var entries = log.slice();
      if (p && p.seatIndex !== undefined) entries = entries.filter(function (e) { return e.seatIndex === p.seatIndex; });
      if (p && p.event) entries = entries.filter(function (e) { return e.event === p.event; });
      if (p && p.last) entries = entries.slice(-parseInt(p.last, 10));
      var withGaps = [];
      for (var gi = 0; gi < entries.length; gi++) {
        if (gi > 0 && entries[gi].ts - entries[gi - 1].ts > 1000) {
          withGaps.push({ event: '---', gapMs: Math.round(entries[gi].ts - entries[gi - 1].ts), clock: entries[gi].clock });
        }
        withGaps.push(entries[gi]);
      }
      return {
        logSize: log.length, returned: withGaps.length,
        handIndex: window.CWGHandLifecycle ? window.CWGHandLifecycle.getHandIndex() : 0,
        hookInstalled: _hookInstalled, entries: withGaps
      };
    },
    'Get the card reveal log (face/cover/reveal events with seat index and card identity)',
    { last: { type: 'number' }, seatIndex: { type: 'number' }, event: { type: 'string' } }
  );

  _bridge.addTool(
    'get_opponent_hole_cards',
    function (p) {
      // Return face events for the current hand, grouped by seat (excludes community)
      var handIdx = window.CWGHandLifecycle ? window.CWGHandLifecycle.getHandIndex() : 0;
      var targetHand = (p && p.handIndex !== undefined) ? parseInt(p.handIndex, 10) : handIdx;
      var seats = {};
      for (var i = 0; i < log.length; i++) {
        var e = log[i];
        if (e.event !== 'face') continue;
        if (e.handIndex !== targetHand) continue;
        if (!e.card) continue;
        if (e.commPos) continue; // skip community cards
        var key = 'seat_' + e.seatIndex;
        if (!seats[key]) seats[key] = [];
        if (seats[key].indexOf(e.card) === -1) seats[key].push(e.card);
      }
      return { success: true, handIndex: targetHand, seats: seats };
    },
    'Get captured opponent hole cards for a hand, grouped by seat index',
    { handIndex: { type: 'number', description: 'Hand index to query (default: current hand)' } }
  );

  _bridge.addTool(
    'clear_card_log',
    function () {
      log.length = 0;
      if (window.CWGHandLifecycle) window.CWGHandLifecycle.reset();
      return { success: true, message: 'card log cleared, hand index reset' };
    },
    'Clear the card reveal log and reset the hand index',
    {}
  );

  // Install the hook
  installHook();

  console.log(TAG + ' registered');
})();
