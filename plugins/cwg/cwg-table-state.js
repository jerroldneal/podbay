; (function () {
  'use strict';

  if (window.__cwgTableStateInstalled) return;
  window.__cwgTableStateInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-table-state] PodBayBridge not available'); return; }

  // ── Atlas (delegate to cwg-card-atlas if loaded) ────────────────────────
  var _SUITS = [{ start: 18, suit: '♦' }, { start: 34, suit: '♣' }, { start: 66, suit: '♥' }, { start: 130, suit: '♠' }];
  var _RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  function frameIdToCard(id) {
    var atlas = window.CWGCardAtlas;
    if (atlas) return atlas.decode(id);
    for (var s = 0; s < _SUITS.length; s++) {
      var off = id - _SUITS[s].start;
      if (off >= 0 && off <= 12) return _RANKS[off] + _SUITS[s].suit;
    }
    return null;
  }

  // ── Helpers — delegate to CWGCore ───────────────────────────────────────
  function getScene() { return window.CWGCore.getScene(); }
  function findNode(root, name) { return window.CWGCore.findNode(root, name); }
  function nodeName(node) { return window.CWGCore.nodeName(node); }
  function nodeChildren(node) { return window.CWGCore.nodeChildren(node); }
  function getText(node) { return window.CWGCore.getText(node); }
  function nodePos(node) { return window.CWGCore.nodePos(node); }

  function detectHoleCardCount() {
    var title = (document.title || '').toUpperCase();
    return (title.indexOf('PLO') !== -1 || title.indexOf('OMAHA') !== -1) ? 4 : 2;
  }

  // ── Card reading ─────────────────────────────────────────────────────────
  function readCardFrameId(holdemCardNode) {
    var ch = nodeChildren(holdemCardNode);
    for (var i = 0; i < ch.length; i++) {
      if (nodeName(ch[i]) !== 'card') continue;
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

  function readHoleCardsForSeat(pkwNode) {
    var activeHandler = null;
    (function findH(node, depth) {
      if (!node || depth > 10 || activeHandler) return;
      if (nodeName(node) === 'cards_handler') {
        var p = node._parent;
        while (p && p !== pkwNode) {
          var pn = nodeName(p);
          if (pn === 'normal' || pn === 'celebrity') {
            if (p.opacity > 0 && p.active !== false) activeHandler = node;
            return;
          }
          p = p._parent;
        }
        return;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) findH(ch[i], depth + 1);
    })(pkwNode, 0);

    if (!activeHandler) return [];
    var holdemCards = [];
    (function findHC(node, depth) {
      if (!node || depth > 8) return;
      var ch = nodeChildren(node);
      for (var k = 0; k < ch.length; k++) {
        var nm = nodeName(ch[k]);
        if (nm === 'holdem_card' || nm.indexOf('holdem_card') === 0) holdemCards.push(ch[k]);
        findHC(ch[k], depth + 1);
      }
    })(activeHandler, 0);

    var scored = holdemCards.map(function (node) {
      var hidden = node.opacity === 0 || node.active === false;
      var id = hidden ? null : readCardFrameId(node);
      var name = id !== null ? frameIdToCard(id) : null;
      return { hidden: hidden, revealed: name !== null, card: name || 'back', score: hidden ? 0 : (name ? 2 : 1) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var cards = [], seen = {};
    for (var i = 0; i < scored.length; i++) {
      var s = scored[i];
      if (s.score === 0) continue;
      if (s.revealed && seen[s.card]) continue;
      if (s.revealed) seen[s.card] = true;
      cards.push({ revealed: s.revealed, card: s.card });
    }
    return cards;
  }

  // ── Community cards ───────────────────────────────────────────────────────
  function readCommunityCards(scene) {
    var communityCards = [];
    (function find(node, depth) {
      if (!node || depth > 30) return;
      if (nodeName(node._parent || {}) === 'public_cards' &&
        (nodeName(node) === 'holdem_card' || nodeName(node).indexOf('holdem_card') === 0)) {
        var hidden = node.opacity === 0 || node.active === false;
        var id = hidden ? null : readCardFrameId(node);
        communityCards.push(id !== null ? (frameIdToCard(id) || ('frame:' + id)) : null);
        return;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return communityCards;
  }

  // ── Player containers ─────────────────────────────────────────────────────
  var PLAYER_FIELDS = {
    roleName_text_new: 'name', money_text: 'stack', chouma_text: 'bet',
    tips_text: 'lastAction', state_msg: 'stateMsg'
  };
  var IGNORED_NAMES = ['NAME', 'Sit Down', 'Label', '', '空'];

  function readPlayerContainer(pkwNode) {
    var data = {}, posPanelActive = false;
    (function trav(node, depth) {
      if (!node || depth > 20) return;
      var nm = nodeName(node);
      var txt = getText(node); if (txt) txt = txt.trim();
      if (nm === 'position_panel') posPanelActive = true;
      if (nm === 'roleName_text_new' && txt && IGNORED_NAMES.indexOf(txt) === -1 && !data.name) {
        data.name = txt;
      }
      if (PLAYER_FIELDS[nm] && txt && txt.length > 0 && !data[PLAYER_FIELDS[nm]]) {
        if (nm !== 'roleName_text_new') {
          if (nm === 'tips_text' || nm === 'state_msg') {
            var p2 = node._parent;
            if (!(p2 && p2.active === false)) data[PLAYER_FIELDS[nm]] = txt;
          } else { data[PLAYER_FIELDS[nm]] = txt; }
        }
      }
      if (nm === 'text' && posPanelActive && !data.positionBadge && txt && txt.length > 0) {
        data.positionBadge = txt; posPanelActive = false;
      }
      if (nm === 'timer_counter') {
        if (node._parent && node._parent.active === true) data.timerVisible = true;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) trav(ch[i], depth + 1);
    })(pkwNode, 0);
    return data;
  }

  // ── Seat angle assignment ─────────────────────────────────────────────────
  function assignSeatsByAngle(containers, center) {
    if (!center || !containers.length) {
      containers.forEach(function (c, i) { c._assignedSeat = i + 1; });
      return containers;
    }
    function cwDist(a, ref) { var d = ref - a; while (d < 0) d += 2 * Math.PI; return d; }
    var valid = containers.filter(function (c) { return c.pos.x !== 0 || c.pos.y !== 0; });
    var empty = containers.filter(function (c) { return c.pos.x === 0 && c.pos.y === 0; });
    valid.forEach(function (c) { c._angle = Math.atan2(c.pos.y - center.y, c.pos.x - center.x); });
    var refAngle = Math.PI / 2;
    var anchor = valid.length ? valid.reduce(function (b, c) {
      var diff = Math.abs(c._angle - refAngle); if (diff > Math.PI) diff = 2 * Math.PI - diff;
      return diff < b.diff ? { c: c, diff: diff } : b;
    }, { c: valid[0], diff: Infinity }).c._angle : refAngle;
    valid.sort(function (a, b) { return cwDist(a._angle, anchor) - cwDist(b._angle, anchor); });
    if (valid.length > 1) valid.push(valid.shift());
    valid.forEach(function (c, i) { c._assignedSeat = i + 1; });
    empty.forEach(function (c, i) { c._assignedSeat = valid.length + i + 1; });
    return valid.concat(empty);
  }

  // ── Main snapshot ─────────────────────────────────────────────────────────
  function buildTableState() {
    var scene = getScene();
    if (!scene) return { success: false, error: 'scene not ready' };

    // Community cards + street
    var community = readCommunityCards(scene);
    var faceUp = community.filter(function (c) { return c !== null; }).length;
    var street = ['preflop', 'preflop', 'preflop', 'flop', 'turn', 'river'][faceUp] || 'preflop';

    // Player containers
    var pkwNodes = [];
    (function findPkw(node, depth) {
      if (!node || depth > 25) return;
      if (nodeName(node) === 'holdem_player_pkw') { pkwNodes.push({ node: node, pos: nodePos(node) }); return; }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) findPkw(ch[i], depth + 1);
    })(scene, 0);

    var center = (function () {
      if (!pkwNodes.length) return null;
      var sx = 0, sy = 0;
      pkwNodes.forEach(function (c) { sx += c.pos.x; sy += c.pos.y; });
      return { x: sx / pkwNodes.length, y: sy / pkwNodes.length };
    })();

    var sorted = assignSeatsByAngle(pkwNodes, center);
    var activeSeat = null;

    var players = sorted.map(function (c) {
      var d = readPlayerContainer(c.node);
      if (d.timerVisible) activeSeat = c._assignedSeat;
      var cards = readHoleCardsForSeat(c.node);
      return {
        seat: c._assignedSeat, name: d.name || null, stack: d.stack || null,
        bet: d.bet || null, lastAction: d.lastAction || null, stateMsg: d.stateMsg || null,
        positionBadge: d.positionBadge || null, cards: cards
      };
    }).filter(function (p) { return p.name && p.name.length > 0; });

    // Pot
    var potNode = findNode(scene, 'total_pot_label');
    var pot = potNode ? getText(potNode) : null;

    // Dealer/SB/BB icons
    function findIconPos(iconName) {
      var node = null;
      (function f(n, d) {
        if (!n || d > 18 || node) return;
        if (nodeName(n) === iconName && n.active !== false) { node = n; return; }
        var ch = nodeChildren(n);
        for (var i = 0; i < ch.length; i++) f(ch[i], d + 1);
      })(scene, 0);
      return node ? nodePos(node) : null;
    }

    function nearestSeat(pos) {
      if (!pos) return null;
      var best = null, bestD = Infinity;
      sorted.forEach(function (c) {
        var dx = c.pos.x - pos.x, dy = c.pos.y - pos.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = c._assignedSeat; }
      });
      return bestD < 250 ? best : null;
    }

    var dealerSeat = nearestSeat(findIconPos('dealer_icon'));
    var sbSeat = nearestSeat(findIconPos('sb_icon'));
    var bbSeat = nearestSeat(findIconPos('bb_icon'));

    if (!sbSeat || !bbSeat) {
      players.forEach(function (p) {
        var b = (p.positionBadge || '').toUpperCase();
        if (!sbSeat && b === 'SB') sbSeat = p.seat;
        if (!bbSeat && b === 'BB') bbSeat = p.seat;
      });
    }

    return {
      success: true,
      street: street,
      pot: pot,
      activeSeat: activeSeat,
      dealer: dealerSeat,
      sb: sbSeat,
      bb: bbSeat,
      communityCards: community,
      holeCardCount: (function () {
        var m = 0;
        players.forEach(function (p) { if (p.cards && p.cards.length > m) m = p.cards.length; });
        return m > 0 ? m : detectHoleCardCount();
      })(),
      players: players,
      timestamp: Date.now()
    };
  }

  _bridge.addTool(
    'get_table_state',
    buildTableState,
    'Get structured table state: players, community cards, pot, street, dealer/SB/BB seats',
    {}
  );

  console.log('[cwg-table-state] registered');
})();
