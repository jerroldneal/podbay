/**
 * PodBay CWG Card Reveal — Minimal Implementation
 *
 * Direct port of the "Addendum: Minimal Implementation Guide" from:
 *   ideas/clubwptgold/clubwptgold-poker-tournament-introspection-agent.md
 *
 * Core technique (the ~1ms trick):
 *   The Cocos2d engine briefly sets the real card spriteFrame BEFORE
 *   covering it with the back-face texture (cards_back_0). By hooking the
 *   spriteFrame setter we capture the real card identity in that window.
 *   Ignoring events where decode() returns null IS the persistence
 *   mechanism — back-face events are simply invisible to the hook.
 *   No timers, no state machines: the absence of a clear-on-null is the
 *   entire insight.
 *
 * State exposed on window:
 *   window.__allCards   { seat_N: [card1, card2], community: [c1..c5] }
 *   window.__cardLog    rolling array of last 50 events
 *   window.__cardHookOk true once hook is installed
 *
 * MCP tools registered as client "cwg-cards-minimal":
 *   get_all_cards   — current hand's cards per seat (the main output)
 *   get_card_log    — rolling event log, optional seat/last filters
 *   clear_cards     — reset all state for a new hand
 *   get_hook_status — installation status + seat/log counts
 *
 * Dual-layout dedup:
 *   The game renders both a "normal" and "celebrity" card layout, so every
 *   spriteFrame assignment fires twice. The indexOf check in addToSeat()
 *   silently drops the duplicate — no explicit dedup logic required.
 *
 * Seat attribution:
 *   Walk the parent chain looking for a node whose name contains
 *   "holdem_player_pkw". Its sibling index among its parent's children
 *   gives the seat number (seat_0 … seat_N). Community cards (public_cards
 *   subtree) have no such ancestor and are filed under "community".
 *
 * Requires: cc (Cocos2d ≥ 2.x), window.PodBayBrokerClient
 */
; (function () {
  'use strict';

  // Guard — tolerate re-injection (page reload, asar restart)
  if (window.__cardHookOk) return;

  // Skip lobby windows — tables use windowType = 0 (or absent)
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  // ── Card atlas ────────────────────────────────────────────────────────
  // Frame IDs from the Cocos2d sprite atlas used by ClubWPT Gold.
  // Ranges confirmed via hex-dump research (see CARD_MAPPING.md).
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  function decode(id) {
    if (id >= 18 && id <= 30) return RANKS[id - 18] + '♦';  // Diamonds
    if (id >= 34 && id <= 46) return RANKS[id - 34] + '♣';  // Clubs
    if (id >= 66 && id <= 78) return RANKS[id - 66] + '♥';  // Hearts
    if (id >= 130 && id <= 142) return RANKS[id - 130] + '♠';  // Spades
    return null; // back-face (cards_back_0), decoration, or unrelated sprite
  }

  // ── Seat resolver ─────────────────────────────────────────────────────
  // Walk up the scene graph looking for the player container node.
  // Returns 'seat_N' for hole cards, null for community cards.
  function findSeat(node) {
    var cur = node;
    for (var i = 0; i < 10 && cur; i++) {
      cur = cur.parent;
      if (cur && (cur.name || '').indexOf('holdem_player_pkw') !== -1) {
        var idx = cur.parent ? cur.parent.children.indexOf(cur) : -1;
        return 'seat_' + idx;
      }
    }
    return null; // community card or unknown
  }

  // ── State ─────────────────────────────────────────────────────────────
  var LOG_LIMIT = 50;
  var _brokerClient = null;  // set once broker registers — used for notify() calls

  // The main output: current hand's cards per seat
  window.__allCards = {};   // { 'seat_0': ['A♠','K♥'], 'community': ['Q♦','J♣','10♥'] }
  window.__cardLog = [];   // rolling events (last LOG_LIMIT entries)

  function addToSeat(seat, card) {
    var key = seat || 'undefined';
    if (!window.__allCards[key]) window.__allCards[key] = [];
    var arr = window.__allCards[key];

    // Duplicate guard — handles dual-layout double-fire naturally
    if (arr.indexOf(card) !== -1) return;

    // Hole cards: > 2 cards at this seat means a new hand started — reset
    if (seat && arr.length >= 2) {
      window.__allCards[key] = [];
      arr = window.__allCards[key];
    }

    arr.push(card);
  }

  function logEvent(card, seat, frameId) {
    var entry = {
      t: Date.now(),
      clock: new Date().toTimeString().slice(0, 8),
      frameId: frameId,
      card: card,       // null when frameId is not in the card atlas
      seat: seat || 'undefined'
    };
    window.__cardLog.push(entry);
    if (window.__cardLog.length > LOG_LIMIT) window.__cardLog.shift();
    return entry;
  }

  // ── Sprite hook ───────────────────────────────────────────────────────
  function installHook() {
    if (typeof cc === 'undefined' || !cc.Sprite || !cc.Sprite.prototype) {
      // cc not ready yet — retry shortly
      setTimeout(installHook, 500);
      return;
    }

    var proto = cc.Sprite.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'spriteFrame');
    if (!desc || !desc.set) {
      console.warn('[CWG-Minimal] spriteFrame setter not found on cc.Sprite.prototype');
      return;
    }

    var origGet = desc.get;
    var origSet = desc.set;
    Object.defineProperty(proto, 'spriteFrame', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        var result = origGet.call(this);
        var name = result ? (result._name || result.name || '(no name)') : result;
        console.log('[CWG-Get]', 'spriteFrame read →', name, 'node=', this.node ? this.node.name : this.node);
        return result;
      },
      set: function (v) {
        origSet.call(this, v); // always call original — never swallow engine behaviour

        // Raw diagnostic log — fires for EVERY spriteFrame assignment before any filter.
        // Lets us see null/falsy values and non-numeric names that get dropped below.
        console.log('[CWG-Raw]', 'v=', v ? (v._name || v.name || '(no name)') : v, 'node=', this.node ? this.node.name : this.node);

        try {
          if (!v) return;

          // Filter only on isNaN — matches Step 1 proof-of-concept.
          // Non-numeric names (e.g. 'cards_back_0') naturally produce NaN and are skipped.
          // All other numeric frame IDs are logged, whether or not they map to a known card.
          var frameId = parseInt(v._name || v.name || '', 10);
          if (isNaN(frameId)) return;

          var card = decode(frameId); // may be null for numeric IDs outside the card atlas
          var seat = this.node ? (findSeat(this.node) || 'undefined') : 'undefined';
          if (card) addToSeat(seat, card); // only track known cards in __allCards
          var entry = logEvent(card, seat, frameId);
          console.log('[CWG-Minimal]', entry.seat, '→', card || frameId);
          // Push to broker activity feed so the dashboard lights up in real-time
          if (_brokerClient) {
            _brokerClient.notify({ type: 'card', seat: entry.seat, card: card, frameId: frameId, clock: entry.clock });
          }
        } catch (e) {
          console.warn('[CWG-Minimal] setter error:', e && e.message, 'v=', v && (v._name || v.name));
        }
      }
    });

    window.__cardHookOk = true;
    console.log('[CWG-Minimal] hook installed. Use window.__allCards after a hand is dealt.');
  }

  // ── MCP broker registration ───────────────────────────────────────────
  function registerBrokerTools() {
    if (!window.PodBayBrokerClient) {
      setTimeout(registerBrokerTools, 1000);
      return;
    }

    var client = new window.PodBayBrokerClient({
      clientId: 'cwg-cards-minimal',
      tools: [
        {
          name: 'get_all_cards',
          description:
            'Returns this hand\'s cards keyed by seat. ' +
            'Hole cards appear under "seat_0", "seat_1" … "seat_N" as arrays of up to 2 cards (e.g. ["A♠","K♥"]). ' +
            'Board cards appear under "community". ' +
            'An empty object means no cards have been captured yet.',
          inputSchema: { type: 'object', properties: {} },
          handler: function () {
            return {
              hookInstalled: !!window.__cardHookOk,
              logSize: window.__cardLog.length,
              cards: JSON.parse(JSON.stringify(window.__allCards))
            };
          }
        },
        {
          name: 'get_card_log',
          description:
            'Returns the rolling event log (up to last 50 events by default). ' +
            'Each entry: { t (epoch ms), clock (hh:mm:ss), card (e.g. "A♠"), seat (e.g. "seat_0" or "community") }.',
          inputSchema: {
            type: 'object',
            properties: {
              last: {
                type: 'number',
                description: 'Return only the last N entries. Default: all.'
              },
              seat: {
                type: 'string',
                description: 'Filter to a specific seat key, e.g. "seat_0" or "community".'
              }
            }
          },
          handler: function (args) {
            var entries = window.__cardLog.slice();
            if (args && args.seat) {
              entries = entries.filter(function (e) { return e.seat === args.seat; });
            }
            if (args && args.last) {
              entries = entries.slice(-args.last);
            }
            return { count: entries.length, entries: entries };
          }
        },
        {
          name: 'clear_cards',
          description: 'Resets all captured cards and the event log. Call this at the start of each new hand.',
          inputSchema: { type: 'object', properties: {} },
          handler: function () {
            var prevSeats = Object.keys(window.__allCards);
            window.__allCards = {};
            window.__cardLog = [];
            return { cleared: true, seatsCleared: prevSeats };
          }
        },
        {
          name: 'get_hook_status',
          description: 'Returns the installation status of the card hook plus basic counters.',
          inputSchema: { type: 'object', properties: {} },
          handler: function () {
            return {
              hookInstalled: !!window.__cardHookOk,
              seatsTracked: Object.keys(window.__allCards),
              logSize: window.__cardLog.length
            };
          }
        }
      ]
    });

    client.connect();
    _brokerClient = client;  // share reference so hook setter can call notify()
    console.log('[CWG-Minimal] MCP tools registered as "cwg-cards-minimal"');
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  installHook();
  registerBrokerTools();
})();
