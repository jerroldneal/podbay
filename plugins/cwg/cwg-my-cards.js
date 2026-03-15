; (function () {
  'use strict';

  if (window.__cwgMyCardsInstalled) return;
  window.__cwgMyCardsInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-my-cards] PodBayBridge not available'); return; }

  // Atlas decode — delegate to cwg-card-atlas if loaded
  var _SUITS = [{ start: 18, suit: '♦' }, { start: 34, suit: '♣' }, { start: 66, suit: '♥' }, { start: 130, suit: '♠' }];
  var _RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  function frameIdToCard(id) {
    if (window.CWGCardAtlas) return window.CWGCardAtlas.decode(id);
    for (var s = 0; s < _SUITS.length; s++) {
      var off = id - _SUITS[s].start;
      if (off >= 0 && off <= 12) return _RANKS[off] + _SUITS[s].suit;
    }
    return null;
  }

  // Read frame ID from a holdem_card node
  function readCardFrameId(holdemCardNode) {
    var ch = window.CWGCore.nodeChildren(holdemCardNode);
    for (var i = 0; i < ch.length; i++) {
      if (window.CWGCore.nodeName(ch[i]) !== 'card') continue;
      var comps = ch[i]._components || [];
      for (var j = 0; j < comps.length; j++) {
        var sf = comps[j]._spriteFrame;
        if (sf) {
          var id = parseInt(sf._name || sf.name || '', 10);
          if (!isNaN(id)) return id;
        }
      }
    }
    return null;
  }

  // Find the hero's player container — it has an active cards_handler with face-up cards
  function readHeroCards(pkwNode) {
    var activeHandler = null;
    (function findH(node, depth) {
      if (!node || depth > 10 || activeHandler) return;
      if (window.CWGCore.nodeName(node) === 'cards_handler') {
        var p = node._parent;
        while (p && p !== pkwNode) {
          var pn = window.CWGCore.nodeName(p);
          if (pn === 'normal' || pn === 'celebrity') {
            if (p.opacity > 0 && p.active !== false) activeHandler = node;
            return;
          }
          p = p._parent;
        }
        return;
      }
      var ch = window.CWGCore.nodeChildren(node);
      for (var i = 0; i < ch.length; i++) findH(ch[i], depth + 1);
    })(pkwNode, 0);

    if (!activeHandler) return null;

    var holdemCards = [];
    (function findHC(node, depth) {
      if (!node || depth > 8) return;
      var ch = window.CWGCore.nodeChildren(node);
      for (var k = 0; k < ch.length; k++) {
        var nm = window.CWGCore.nodeName(ch[k]);
        if (nm === 'holdem_card' || nm.indexOf('holdem_card') === 0) holdemCards.push(ch[k]);
        findHC(ch[k], depth + 1);
      }
    })(activeHandler, 0);

    var cards = [];
    var seen = {};
    for (var i = 0; i < holdemCards.length; i++) {
      var node = holdemCards[i];
      if (node.opacity === 0 || node.active === false) continue;
      var id = readCardFrameId(node);
      var name = id !== null ? frameIdToCard(id) : null;
      if (!name) continue;                    // back-face: skip for hero
      if (seen[name]) continue;
      seen[name] = true;
      cards.push(name);
    }
    return cards.length > 0 ? cards : null;
  }

  _bridge.addTool(
    'get_my_cards',
    function () {
      if (!window.CWGCore) return { success: false, error: 'CWGCore not loaded' };
      var scene = window.CWGCore.getScene();
      if (!scene) return { success: false, error: 'scene not ready' };

      // Walk all holdem_player_pkw nodes; hero = first with decoded face-up cards
      var heroCands = [];
      (function findPkw(node, depth) {
        if (!node || depth > 25) return;
        if (window.CWGCore.nodeName(node) === 'holdem_player_pkw') {
          heroCands.push(node); return;
        }
        var ch = window.CWGCore.nodeChildren(node);
        for (var i = 0; i < ch.length; i++) findPkw(ch[i], depth + 1);
      })(scene, 0);

      for (var j = 0; j < heroCands.length; j++) {
        var cards = readHeroCards(heroCands[j]);
        if (cards) {
          return { success: true, cards: cards, holeCount: cards.length };
        }
      }
      return { success: true, cards: [], holeCount: 0, note: 'no face-up cards found' };
    },
    'Get hero (my) hole cards from the scene',
    {}
  );

  console.log('[cwg-my-cards] registered');
})();
