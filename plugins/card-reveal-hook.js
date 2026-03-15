/**
 * PodBay Card Reveal Hook Plugin
 *
 * Intercepts cc.Sprite.prototype spriteFrame assignments to capture the
 * ~1ms window in which the Cocos2d engine briefly exposes a card's true
 * identity before covering it with the back-face texture (cards_back_0).
 *
 * This is the only reliable way to observe opponent hole cards — polling
 * operates at frame rate (~16ms) and would never see the sub-millisecond
 * face assignment. A synchronous property setter hook fires inside the
 * same JS execution context as the engine, before any rendering occurs.
 *
 * Capture sequence per card deal:
 *   1. Engine sets true spriteFrame (e.g. frame #130 = Ace of Spades)  ← we capture this
 *   2. Engine immediately sets cards_back_0                             ← we note "covered"
 *   3. Deal animation plays (~800ms)
 *   4. At showdown, engine sets true spriteFrame again                  ← we note "reveal"
 *
 * API (on window):
 *   window.PodBayCardRevealLog     — live array of capture entries
 *   window.PodBayCardRevealHook    — { status(), clear(), pause(), resume() }
 *
 * Log entry shape:
 *   { ts, wallMs, clock, event, card, frameId, frameName, nodePath, seatIndex, handIndex }
 *
 * MCP Tool Registration:
 *   Registers with the MCP broker as "card-capture" client with tools:
 *   - get_card_log    : returns the full log (or last N entries)
 *   - clear_card_log  : resets the log
 *
 * Requires: cc (Cocos2d), window.PodBayBrokerClient
 */
; (function () {
  'use strict';

  if (window.PodBayCardRevealHook) return;

  // Skip lobby windows — cards only exist on table windows
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  // ── Card atlas ──────────────────────────────────────────────────────────
  var SUITS = [
    { start: 18, suit: '♦' },
    { start: 34, suit: '♣' },
    { start: 66, suit: '♥' },
    { start: 130, suit: '♠' }
  ];
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

  function frameIdToCard(id) {
    for (var s = 0; s < SUITS.length; s++) {
      var offset = id - SUITS[s].start;
      if (offset >= 0 && offset <= 12) return RANKS[offset] + SUITS[s].suit;
    }
    return null;
  }

  function isBackFace(frameName) {
    return typeof frameName === 'string' && frameName.indexOf('cards_back') === 0;
  }

  // ── Node path utility ───────────────────────────────────────────────────
  function nodeName(node) { return node._name || node.name || ''; }

  function nodePath(node) {
    var parts = [];
    var n = node;
    var depth = 0;
    while (n && depth < 12) {
      var nm = nodeName(n);
      if (nm) parts.unshift(nm);
      n = n.parent || n._parent;
      depth++;
    }
    return parts.join('/');
  }

  // Returns first N ancestor names for scene hierarchy debugging.
  function parentNames(node, limit) {
    var names = [];
    var n = node.parent || node._parent;
    var depth = 0;
    while (n && depth < (limit || 8)) {
      names.push(nodeName(n) || '(unnamed)');
      n = n.parent || n._parent;
      depth++;
    }
    return names;
  }

  // Walk ancestors to find a player seat index via holdem_player_pkw parent.
  // Returns -1 if this sprite is not inside a player seat container.
  function resolveSeatIndex(node) {
    var n = node.parent || node.parent || node._parent;
    var depth = 0;
    while (n && depth < 15) {
      if (nodeName(n) === 'holdem_player_pkw') {
        // Seat index is the position of this container among its siblings
        var parent = n.parent || n._parent;
        if (parent) {
          var siblings = parent._children || parent.children || [];
          for (var i = 0; i < siblings.length; i++) {
            if (siblings[i] === n) return i;
          }
        }
        return 0;
      }
      n = n.parent || n._parent;
      depth++;
    }
    return -1; // community card or unknown
  }

  // Walk up to find community card position (F1/F2/F3/T/R) by sibling index
  // under public_cards. Returns null for hole cards and unknown nodes.
  var COMMUNITY_POS = ['F1', 'F2', 'F3', 'T', 'R'];

  function communityCardPos(node) {
    // node = card sprite → parent = holdem_card → parent = public_cards
    var holdemCard = node.parent || node._parent;
    if (!holdemCard) return null;
    var publicCards = holdemCard.parent || holdemCard._parent;
    if (!publicCards) return null;
    if (nodeName(publicCards) !== 'public_cards') return null;
    var siblings = publicCards._children || publicCards.children || [];
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === holdemCard) return COMMUNITY_POS[i] || ('C' + i);
    }
    return null;
  }

  // ── Log ─────────────────────────────────────────────────────────────────
  var MAX_LOG = 500;
  var log = [];
  var handIndex = 0;   // incremented when we see a new deal wave
  var paused = false;

  function appendEntry(event, frameId, frameName, spriteComp) {
    if (paused) return;
    var card = frameIdToCard(frameId);
    // spriteComp may be a cc.Sprite component — extract the actual scene Node for traversal
    var node = (spriteComp && spriteComp.node) ? spriteComp.node : spriteComp;
    var path = nodePath(node);
    var seat = resolveSeatIndex(node);
    var commPos = communityCardPos(node);  // 'F1','F2','F3','T','R' or null
    var now = new Date();
    var clock = now.toTimeString().slice(0, 8); // hh:mm:ss
    var entry = {
      ts: performance.now(),
      wallMs: Date.now(),
      clock: clock,
      event: event,          // 'face' | 'cover' | 'reveal' | 'unknown'
      card: card,           // e.g. 'As', null for non-card frames
      frameId: frameId,
      frameName: frameName,
      nodePath: path,
      nodeId: spriteComp._id,  // component ID — unique per Sprite, used for _faceSeenThisHand
      parentNames: parentNames(node, 6),  // ancestor names for scene hierarchy debugging
      seatIndex: seat,
      commPos: commPos,      // community card position: 'F1','F2','F3','T','R' or null
      handIndex: handIndex
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
    window.PodBayCardRevealLog = log;
  }

  // ── Sprite hook ─────────────────────────────────────────────────────────
  // We track which sprite nodes have had a face assigned this hand so we can
  // distinguish a first-time face assignment from a showdown reveal.
  var _faceSeenThisHand = {};   // nodeId → true  (uses node._id, unique per Cocos2d node)
  var _hookInstalled = false;

  function installHook() {
    if (_hookInstalled) return;
    if (typeof cc === 'undefined' || !cc.Sprite || !cc.Sprite.prototype) {
      // cc not ready yet — retry after a short delay
      setTimeout(installHook, 500);
      return;
    }

    var proto = cc.Sprite.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'spriteFrame');
    if (!descriptor) {
      // Some versions of Cocos use _spriteFrame internally — try _spriteFrame
      descriptor = Object.getOwnPropertyDescriptor(proto, '_spriteFrame');
      if (!descriptor) {
        console.warn('[PodBay CardRevealHook] spriteFrame descriptor not found on cc.Sprite.prototype');
        return;
      }
    }

    var origSet = descriptor.set;
    var origGet = descriptor.get;
    if (!origSet) {
      console.warn('[PodBay CardRevealHook] spriteFrame setter not found');
      return;
    }

    Object.defineProperty(proto, 'spriteFrame', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: origGet,
      set: function (frame) {
        // Always call original first — hook never swallows engine behaviour
        origSet.call(this, frame);
        try {
          if (!frame) return;
          var sfName = frame._name || frame.name || '';
          var nodeId = this._id;  // component ID — unique key for _faceSeenThisHand

          // Back-face check must come BEFORE parseInt — 'cards_back_0' parses as NaN.
          // Only log cover events for nodes we already saw a face card on this hand —
          // this prevents spurious cover events from unrelated sprites (wrong seat/hand).
          if (isBackFace(sfName)) {
            if (_faceSeenThisHand[nodeId]) {
              appendEntry('cover', 0, sfName, this);
            }
            return;
          }

          var frameId = parseInt(sfName, 10);
          if (isNaN(frameId)) return;  // non-numeric frame name — not a card

          var card = frameIdToCard(frameId);
          if (!card) return;  // valid number but not in card atlas

          if (_faceSeenThisHand[nodeId]) {
            // Second face assignment on this node this hand = showdown reveal
            appendEntry('reveal', frameId, sfName, this);
          } else {
            // First face assignment = the ~1ms true card flash
            _faceSeenThisHand[nodeId] = true;
            appendEntry('face', frameId, sfName, this);
          }
        } catch (e) {
          // Never let hook errors propagate to engine
        }
      }
    });

    _hookInstalled = true;
    console.log('[PodBay CardRevealHook] spriteFrame hook installed');
  }

  // ── Public API ───────────────────────────────────────────────────────────
  window.PodBayCardRevealLog = log;

  window.PodBayCardRevealHook = {
    status: function () {
      return {
        installed: _hookInstalled,
        paused: paused,
        logSize: log.length,
        handIndex: handIndex
      };
    },
    clear: function () {
      log.length = 0;
      _faceSeenThisHand = {};
      handIndex++;
    },
    pause: function () { paused = true; },
    resume: function () { paused = false; },
    newHand: function () {
      _faceSeenThisHand = {};
      handIndex++;
    }
  };

  // ── MCP Broker registration ──────────────────────────────────────────────
  function registerBrokerTools() {
    if (!window.PodBayBrokerClient) {
      setTimeout(registerBrokerTools, 1000);
      return;
    }

    var client = new window.PodBayBrokerClient({
      clientId: 'card-capture',
      tools: [
        {
          name: 'get_card_log',
          description: 'Returns the card reveal log. Each entry captures a spriteFrame assignment event (face/cover/reveal) with timestamp, card identity, seat index, and node path.',
          inputSchema: {
            type: 'object',
            properties: {
              last: {
                type: 'number',
                description: 'Return only the last N entries (default: all)'
              },
              seatIndex: {
                type: 'number',
                description: 'Filter to a specific seat index (0-based). Omit for all seats.'
              },
              event: {
                type: 'string',
                enum: ['face', 'cover', 'reveal'],
                description: 'Filter by event type. Omit for all events.'
              }
            }
          },
          handler: function (args) {
            var entries = log.slice();
            if (args && args.seatIndex !== undefined) {
              entries = entries.filter(function (e) { return e.seatIndex === args.seatIndex; });
            }
            if (args && args.event) {
              entries = entries.filter(function (e) { return e.event === args.event; });
            }
            if (args && args.last) {
              entries = entries.slice(-args.last);
            }
            // Inject gap markers for gaps > 1 second
            var withGaps = [];
            for (var gi = 0; gi < entries.length; gi++) {
              if (gi > 0 && entries[gi].ts - entries[gi - 1].ts > 1000) {
                withGaps.push({
                  event: '---',
                  gapMs: Math.round(entries[gi].ts - entries[gi - 1].ts),
                  clock: entries[gi].clock
                });
              }
              withGaps.push(entries[gi]);
            }
            return {
              logSize: log.length,
              returned: withGaps.length,
              handIndex: handIndex,
              hookInstalled: _hookInstalled,
              entries: withGaps
            };
          }
        },
        {
          name: 'clear_card_log',
          description: 'Clears the card reveal log and increments the hand index. Call this at the start of each new hand.',
          inputSchema: { type: 'object', properties: {} },
          handler: function () {
            var prev = log.length;
            window.PodBayCardRevealHook.clear();
            return { cleared: prev, handIndex: handIndex };
          }
        },
        {
          name: 'get_hook_status',
          description: 'Returns the current status of the card reveal hook.',
          inputSchema: { type: 'object', properties: {} },
          handler: function () {
            return window.PodBayCardRevealHook.status();
          }
        }
      ]
    });

    client.connect();
    console.log('[PodBay CardRevealHook] MCP tools registered (card-capture)');
  }

  // Start: install hook immediately (cc may already be loaded), register broker tools
  installHook();
  registerBrokerTools();
})();
