/**
 * PodBay Table Watcher Plugin
 *
 * Cocos2d scene graph extraction for poker table state. Reads player seats,
 * hole cards, community cards, pot, dealer/SB/BB positions, and active turn
 * from the running cc.director scene.
 *
 * Requires: cc (Cocos2d engine) in window scope
 *
 * API:
 *   window.PodBayTableWatcher.snapshot()    — raw scene data
 *   window.PodBayTableWatcher.gameStatus()  — structured game state
 */
;(function () {
  'use strict';

  if (window.PodBayTableWatcher) return;

  // Skip lobby windows (windowType=1) — table watcher only runs on tables
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;

  // ── Atlas frame-ID → card name ──────────────────────────────────────────
  var SUITS = [
    { start: 18,  suit: '♦' },
    { start: 34,  suit: '♣' },
    { start: 66,  suit: '♥' },
    { start: 130, suit: '♠' }
  ];
  var RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

  function frameIdToCard(id) {
    for (var s = 0; s < SUITS.length; s++) {
      var offset = id - SUITS[s].start;
      if (offset >= 0 && offset <= 12) return RANKS[offset] + SUITS[s].suit;
    }
    return null;
  }

  function detectHoleCardCount() {
    var title = (document.title || '').toUpperCase();
    if (title.indexOf('PLO') !== -1 || title.indexOf('OMAHA') !== -1) return 4;
    return 2;
  }

  // ── Scene utilities ─────────────────────────────────────────────────────
  function getScene() {
    return typeof cc !== 'undefined' && cc.director && cc.director.getRunningScene
      ? cc.director.getRunningScene() : null;
  }

  function nodePos(node) {
    if (node.convertToWorldSpaceAR) {
      var wp = node.convertToWorldSpaceAR(cc.v2(0, 0));
      return { x: wp.x, y: wp.y };
    }
    var x = 0, y = 0, n = node;
    while (n) { x += n.x || 0; y += n.y || 0; n = n._parent; }
    return { x: x, y: y };
  }

  function getText(node) {
    if (!node._components) return null;
    for (var i = 0; i < node._components.length; i++) {
      var c = node._components[i];
      if (c && typeof c.string === 'string') return c.string;
    }
    return null;
  }

  function nodeName(node) { return node._name || node.name || ''; }
  function nodeChildren(node) { return node._children || node.children || []; }

  // ── Phase 1: Table center & seat layout ─────────────────────────────────
  function getTableCenter(scene) {
    var result = null;
    (function find(node, depth) {
      if (!node || depth > 22 || result) return;
      if (nodeName(node) === 'table_center') { result = nodePos(node); return; }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return result;
  }

  function findFloatingDealerIcon(scene) {
    var result = null;
    (function find(node, depth) {
      if (!node || depth > 20 || result) return;
      if (nodeName(node) === 'dealer_icon') {
        if (node.active === true) {
          result = { pos: nodePos(node), visible: true, opacity: node.opacity };
        }
        return;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return result;
  }

  function assignSeatsByAngle(containers, dealerIconPos, center) {
    if (!center || !containers.length) {
      containers.forEach(function(c, i) { c._assignedSeat = i + 1; });
      return containers;
    }
    function cwDist(a, ref) {
      var d = ref - a;
      while (d < 0) d += 2 * Math.PI;
      return d;
    }
    var valid = containers.filter(function(c) { return c.pos.x !== 0 || c.pos.y !== 0; });
    var empty = containers.filter(function(c) { return c.pos.x === 0 && c.pos.y === 0; });
    valid.forEach(function(c) {
      c._angle = Math.atan2(c.pos.y - center.y, c.pos.x - center.x);
    });
    var refAngle = Math.PI / 2;
    var anchorAngle = refAngle;
    if (valid.length) {
      var anchorHolder = valid.reduce(function(best, c) {
        var diff = Math.abs(c._angle - refAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        return diff < best.diff ? { c: c, diff: diff } : best;
      }, { c: valid[0], diff: Infinity });
      anchorAngle = anchorHolder.c._angle;
    }
    valid.sort(function(a, b) { return cwDist(a._angle, anchorAngle) - cwDist(b._angle, anchorAngle); });
    if (valid.length > 1) valid.push(valid.shift());
    valid.forEach(function(c, i) { c._assignedSeat = i + 1; });
    empty.forEach(function(c, i) { c._assignedSeat = valid.length + i + 1; });
    return valid.concat(empty);
  }

  function findPlayerContainers(scene) {
    var containers = [];
    (function find(node, depth) {
      if (!node || depth > 25) return;
      if (nodeName(node) === 'holdem_player_pkw') {
        containers.push({ node: node, pos: nodePos(node) });
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return containers;
  }

  function centerFromContainers(containers) {
    if (!containers.length) return null;
    var sx = 0, sy = 0;
    containers.forEach(function(c) { sx += c.pos.x; sy += c.pos.y; });
    return { x: sx / containers.length, y: sy / containers.length };
  }

  // ── Phase 2: Card containers ────────────────────────────────────────────
  function findCardNodes(scene) {
    var cards = [];
    (function find(node, depth) {
      if (!node || depth > 30) return;
      var nm = nodeName(node);
      if (nm === 'holdem_card' || nm.indexOf('holdem_card copy') === 0) {
        var parent = node._parent;
        var siblings = parent ? (parent._children || parent.children || []) : [];
        cards.push({ node: node, parentName: nodeName(parent), pos: nodePos(node), siblingIndex: siblings.indexOf(node) });
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return cards;
  }

  function readCardFrameId(holdemCardNode) {
    var ch = nodeChildren(holdemCardNode);
    for (var i = 0; i < ch.length; i++) {
      if (nodeName(ch[i]) === 'card') {
        var comps = ch[i]._components || [];
        for (var j = 0; j < comps.length; j++) {
          var sf = comps[j]._spriteFrame;
          if (sf) {
            var sfName = sf._name || sf.name || '';
            var id = parseInt(sfName, 10);
            if (!isNaN(id)) return id;
          }
        }
      }
    }
    return null;
  }

  function readCommunityCards(cardNodes) {
    var community = cardNodes.filter(function(c) { return c.parentName === 'public_cards'; });
    community.sort(function(a, b) { return a.siblingIndex - b.siblingIndex; });
    return community.map(function(c) {
      if (c.node.opacity === 0 || c.node.active === false) return null;
      var id = readCardFrameId(c.node);
      return id !== null ? (frameIdToCard(id) || ('frame:' + id)) : null;
    });
  }

  // ── Phase 3: Player data ────────────────────────────────────────────────
  var PLAYER_FIELDS = {
    roleName_text_new: 'name',
    money_text:        'stack',
    chouma_text:       'bet',
    tips_text:         'lastAction',
    state_msg:         'stateMsg',
    balance:           'balanceDelta',
    auto_play_tag_label: 'status',
    timer_counter:     'timerCount'
  };
  var IGNORED_NAMES = ['NAME', 'Sit Down', 'Label', '', '空'];

  function readPlayerContainer(pkwNode) {
    var data = {};
    var positionPanelActive = false;
    (function traverse(node, depth) {
      if (!node || depth > 20) return;
      var nm = nodeName(node);
      var txt = getText(node);
      if (txt) txt = txt.trim();
      if (nm === 'position_panel') positionPanelActive = true;
      if (nm === 'roleName_text_new' && txt && IGNORED_NAMES.indexOf(txt) === -1 && !data.name) {
        data.name = txt;
      }
      if (PLAYER_FIELDS[nm] && txt && txt.length > 0 && !data[PLAYER_FIELDS[nm]]) {
        if (nm !== 'roleName_text_new') {
          if (nm === 'tips_text') {
            var tipsParent = node._parent;
            if (!(tipsParent && tipsParent.active === false)) {
              data[PLAYER_FIELDS[nm]] = txt;
            }
          } else if (nm === 'state_msg') {
            var msgParent = node._parent;
            if (!(msgParent && msgParent.active === false)) {
              data[PLAYER_FIELDS[nm]] = txt;
            }
          } else {
            data[PLAYER_FIELDS[nm]] = txt;
          }
        }
      }
      if (nm === 'text' && positionPanelActive && !data.positionBadge && txt && txt.length > 0) {
        data.positionBadge = txt;
        positionPanelActive = false;
      }
      if (nm === 'timer_counter') {
        var timerParent = node._parent;
        if (timerParent && timerParent.active === true) data.timerVisible = true;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) traverse(ch[i], depth + 1);
    })(pkwNode, 0);
    return data;
  }

  // ── Hole cards from card-hook ───────────────────────────────────────────
  function readHoleCardsFromHook(pkwNode) {
    var lookup = window.__cnr_cardsByPlayer;
    if (!lookup) return null;
    var parent = pkwNode._parent || pkwNode.parent;
    if (!parent || !parent.children) return null;
    var idx = parent.children.indexOf(pkwNode);
    if (idx < 0) return null;
    var key = 'seat_' + idx;
    var arr = lookup[key];
    if (!arr || arr.length === 0) return null;
    return arr.map(function(card) { return { revealed: true, card: card }; });
  }

  function readHoleCardsForSeat(pkwNode) {
    var activeHandler = null;
    (function findHandler(node, depth) {
      if (!node || depth > 10 || activeHandler) return;
      var nm = nodeName(node);
      if (nm === 'cards_handler') {
        var layoutParent = node._parent;
        while (layoutParent && layoutParent !== pkwNode) {
          var lpName = nodeName(layoutParent);
          if (lpName === 'normal' || lpName === 'celebrity') {
            if (layoutParent.opacity > 0 && layoutParent.active !== false) activeHandler = node;
            return;
          }
          layoutParent = layoutParent._parent;
        }
        return;
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) findHandler(ch[i], depth + 1);
    })(pkwNode, 0);
    if (!activeHandler) return [];

    var allHoldemCards = [];
    (function findHC(node, depth) {
      if (!node || depth > 8) return;
      var ch = nodeChildren(node);
      for (var k = 0; k < ch.length; k++) {
        var nm = nodeName(ch[k]);
        if (nm === 'holdem_card' || nm.indexOf('holdem_card') === 0) allHoldemCards.push(ch[k]);
        findHC(ch[k], depth + 1);
      }
    })(activeHandler, 0);

    var scored = allHoldemCards.map(function(node) {
      var hidden = node.opacity === 0 || node.active === false;
      var id = hidden ? null : readCardFrameId(node);
      var cardName = id !== null ? frameIdToCard(id) : null;
      return { node: node, hidden: hidden, revealed: cardName !== null, card: cardName || 'back', score: hidden ? 0 : (cardName ? 2 : 1) };
    });
    scored.sort(function(a, b) { return b.score - a.score; });

    var cards = [];
    var seen = {};
    for (var i = 0; i < scored.length; i++) {
      var s = scored[i];
      if (s.score === 0) continue;
      if (s.revealed && seen[s.card]) continue;
      if (s.revealed) seen[s.card] = true;
      cards.push({ revealed: s.revealed, card: s.card });
    }
    return cards;
  }

  // ── Phase 4: Dealer button, SB/BB, pot ──────────────────────────────────
  function findPot(scene) {
    var potText = null;
    (function find(node, depth) {
      if (!node || depth > 20 || potText) return;
      if (nodeName(node) === 'total_pot_label') {
        var txt = getText(node);
        if (txt && /[\d,]+/.test(txt)) { potText = txt.trim(); return; }
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return potText;
  }

  function findSbBb(scene) {
    var result = { sbIcon: null, bbIcon: null };
    (function find(node, depth) {
      if (!node || depth > 18) return;
      var nm = nodeName(node);
      if (nm === 'sb_icon' && !result.sbIcon) {
        result.sbIcon = { pos: nodePos(node), visible: node.visible !== false, opacity: node.opacity };
      }
      if (nm === 'bb_icon' && !result.bbIcon) {
        result.bbIcon = { pos: nodePos(node), visible: node.visible !== false, opacity: node.opacity };
      }
      var ch = nodeChildren(node);
      for (var i = 0; i < ch.length; i++) find(ch[i], depth + 1);
    })(scene, 0);
    return result;
  }

  // ── Composite snapshot ──────────────────────────────────────────────────
  function queryTableSnapshot() {
    var scene = getScene();
    if (!scene) return { error: 'scene not ready' };

    var tableCenter = getTableCenter(scene);
    var pkwContainers = findPlayerContainers(scene);
    if (!tableCenter) tableCenter = centerFromContainers(pkwContainers);

    var cardNodes = findCardNodes(scene);
    var communityCards = readCommunityCards(cardNodes);
    var cardCountByGroup = {};
    cardNodes.forEach(function(c) {
      cardCountByGroup[c.parentName] = (cardCountByGroup[c.parentName] || 0) + 1;
    });

    var faceUpCommunity = communityCards.filter(function(c) { return c !== null; }).length;
    var street = ['preflop','preflop','preflop','flop','turn','river'][faceUpCommunity] || 'preflop';

    var dealerIcon = findFloatingDealerIcon(scene);
    var sortedContainers = assignSeatsByAngle(pkwContainers, dealerIcon ? dealerIcon.pos : null, tableCenter);
    var activeSeat = null;
    var players = sortedContainers.map(function(c) {
      var d = readPlayerContainer(c.node);
      var seatNum = c._assignedSeat;
      if (d.timerVisible) activeSeat = seatNum;
      var holeCards = readHoleCardsFromHook(c.node) || readHoleCardsForSeat(c.node);
      return Object.assign({ seat: seatNum, worldPos: c.pos, cards: holeCards }, d);
    }).filter(function(p) { return p.name && p.name.length > 0; });

    var sbBb = findSbBb(scene);
    var pot = findPot(scene);
    var realSeats = sortedContainers.filter(function(c) { return c.pos.x !== 0 || c.pos.y !== 0; }).length;

    return {
      tableCenter: tableCenter,
      totalSeats: realSeats,
      seatCount: players.length,
      street: street,
      communityCards: communityCards,
      pot: pot,
      dealerIcon: dealerIcon,
      sbIcon: sbBb.sbIcon,
      bbIcon: sbBb.bbIcon,
      activeSeat: activeSeat,
      players: players,
      cardNodeGroups: cardCountByGroup,
      timestamp: Date.now()
    };
  }

  // ── Full game status builder ────────────────────────────────────────────
  function buildGameStatus(snap) {
    var dealerSeat = null, sbSeat = null, bbSeat = null;

    function nearestSeat(pos, playerList) {
      if (!pos || !playerList.length) return null;
      var best = null, bestDist = Infinity;
      playerList.forEach(function(p) {
        if (!p.worldPos) return;
        var dx = p.worldPos.x - pos.x, dy = p.worldPos.y - pos.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; best = p.seat; }
      });
      return bestDist < 250 ? best : null;
    }

    if (snap.dealerIcon && snap.dealerIcon.visible) dealerSeat = nearestSeat(snap.dealerIcon.pos, snap.players);
    if (snap.sbIcon && snap.sbIcon.visible) sbSeat = nearestSeat(snap.sbIcon.pos, snap.players);
    if (snap.bbIcon && snap.bbIcon.visible) bbSeat = nearestSeat(snap.bbIcon.pos, snap.players);

    if (!sbSeat || !bbSeat) {
      snap.players.forEach(function(p) {
        var badge = (p.positionBadge || '').toUpperCase();
        if (!sbSeat && badge === 'SB') sbSeat = p.seat;
        if (!bbSeat && badge === 'BB') bbSeat = p.seat;
      });
    }

    if (dealerSeat && (!sbSeat || !bbSeat)) {
      var occupiedSeats = snap.players.map(function(p) { return p.seat; }).sort(function(a, b) { return a - b; });
      var total = snap.totalSeats;
      function nextOccupiedAfter(seat) {
        for (var i = 1; i <= total; i++) {
          var candidate = ((seat - 1 + i) % total) + 1;
          if (occupiedSeats.indexOf(candidate) !== -1) return candidate;
        }
        return null;
      }
      if (!sbSeat) sbSeat = nextOccupiedAfter(dealerSeat);
      if (!bbSeat) bbSeat = nextOccupiedAfter(sbSeat || dealerSeat);
    }

    var activePlayer = snap.activeSeat
      ? snap.players.find(function(p) { return p.seat === snap.activeSeat; }) : null;

    var playerDetails = snap.players.map(function(p) {
      var isDealer = dealerSeat === p.seat;
      var isSB = sbSeat === p.seat;
      var isBB = bbSeat === p.seat;
      var position = p.positionBadge || (isDealer ? 'BTN' : isSB ? 'SB' : isBB ? 'BB' : null);
      return {
        seat: p.seat, name: p.name, stack: p.stack || null, bet: p.bet || null,
        lastAction: p.lastAction || null, status: p.status || null,
        balanceDelta: p.balanceDelta || null, stateMsg: p.stateMsg || null,
        position: position, isDealer: isDealer, isSB: isSB, isBB: isBB,
        isActiveTurn: p.seat === snap.activeSeat, timerVisible: !!p.timerVisible,
        cards: p.cards || [], worldPos: p.worldPos || null
      };
    });

    var occupiedSeatsArr = snap.players.map(function(p) { return p.seat; });
    var totalSeatCount = snap.totalSeats;
    var seats = [];
    for (var s = 1; s <= totalSeatCount; s++) {
      var occupant = snap.players.find(function(p) { return p.seat === s; });
      seats.push({ seat: s, occupied: !!occupant, name: occupant ? occupant.name : null });
    }

    var cc = snap.communityCards || [];
    var communityDetails = [
      { label: 'flop1', card: cc[0] || null },
      { label: 'flop2', card: cc[1] || null },
      { label: 'flop3', card: cc[2] || null },
      { label: 'turn',  card: cc[3] || null },
      { label: 'river', card: cc[4] || null }
    ];

    var maxCardsFound = 0;
    playerDetails.forEach(function(p) {
      if (p.cards && p.cards.length > maxCardsFound) maxCardsFound = p.cards.length;
    });

    return {
      timestamp: snap.timestamp,
      street: snap.street,
      pot: snap.pot || null,
      tableCenter: snap.tableCenter,
      occupiedCount: playerDetails.length,
      emptyCount: totalSeatCount - playerDetails.length,
      seats: seats,
      communityCards: communityDetails,
      holeCardCount: maxCardsFound > 0 ? maxCardsFound : detectHoleCardCount(),
      activeTurn: { seat: snap.activeSeat || null, name: activePlayer ? activePlayer.name : null },
      dealer: { seat: dealerSeat },
      sb: { seat: sbSeat },
      bb: { seat: bbSeat },
      players: playerDetails
    };
  }

  // ── Expose as PodBay plugin ─────────────────────────────────────────────
  window.PodBayTableWatcher = {
    snapshot: function () {
      return queryTableSnapshot();
    },
    gameStatus: function () {
      var snap = queryTableSnapshot();
      if (snap.error) return snap;
      return buildGameStatus(snap);
    },
    buildGameStatus: buildGameStatus
  };
})();
