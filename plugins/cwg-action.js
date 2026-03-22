/**
 * CWG Action Plugin
 *
 * Registers fold/call/check/raise/allin tools that click Cocos2d poker buttons
 * via scene graph traversal and cc.Button._releaseAction().
 *
 * Requires: identity, bridge (via require)
 */
'use strict';

var identity = require('identity');
var bridge = require('bridge');

// Only run on game tables
if (!identity.isGame) {
  module.exports = { skipped: true, reason: 'not a game table' };
} else {

  var TAG = '[CWG-Action]';

  var BUTTON_MAP = {
    fold: ['giveUpRed', 'giveupred'],
    call: ['followFl_Blue'],
    check: ['free_bet_button', 'preBetCheck'],
    raise: ['raise_button_img', 'raise_button'],
    allin: ['allin', 'all_in']
  };

  function findNode(root, name) {
    var q = [root];
    while (q.length) {
      var n = q.shift();
      if (n._name === name || n.name === name) return n;
      var ch = n._children || n.children || [];
      for (var i = 0; i < ch.length; i++) q.push(ch[i]);
    }
    return null;
  }

  function getGameView() {
    if (typeof cc === 'undefined' || !cc.director) return null;
    var scene = cc.director.getRunningScene();
    if (!scene) return null;
    return findNode(scene, 'holdem_game_view');
  }

  function enableParentChain(node, stopAt) {
    var chain = [];
    var cur = node;
    while (cur && cur !== stopAt) {
      if (!cur.active) cur.active = true;
      if (cur.opacity < 255) cur.opacity = 255;
      chain.push(cur._name || cur.name);
      cur = cur.parent;
    }
    return chain;
  }

  function clickButton(node) {
    var btn = node.getComponent ? node.getComponent(cc.Button) : null;
    if (!btn && node.parent) {
      btn = node.parent.getComponent ? node.parent.getComponent(cc.Button) : null;
    }
    if (btn && typeof btn._releaseAction === 'function') {
      btn._releaseAction();
      return '_releaseAction';
    }
    if (btn && btn.clickEvents && btn.clickEvents.length) {
      for (var j = 0; j < btn.clickEvents.length; j++) {
        btn.clickEvents[j].emit([btn]);
      }
      return 'clickEvents.emit';
    }
    if (node.emit) {
      node.emit('click', node);
      return 'node.emit';
    }
    return 'none';
  }

  function executeAction(actionName) {
    var gv = getGameView();
    if (!gv) return { success: false, error: 'holdem_game_view not found' };

    var betContainer = findNode(gv, 'BetButons') || gv;
    var candidates = BUTTON_MAP[actionName];
    if (!candidates) return { success: false, error: 'unknown action: ' + actionName };

    var target = null;
    var usedName = '';
    for (var i = 0; i < candidates.length; i++) {
      target = findNode(betContainer, candidates[i]);
      if (target) { usedName = candidates[i]; break; }
    }
    if (!target) return { success: false, error: 'button not found', tried: candidates };

    var chain = enableParentChain(target, gv.parent);
    var method = clickButton(target);

    console.log(TAG, actionName, 'clicked', usedName, 'via', method);
    return { success: true, action: actionName, node: usedName, method: method, chain: chain };
  }

  // Register tools via bridge with identity-derived clientId
  var _bridge = bridge(identity.clientId);

  var actions = ['fold', 'call', 'check', 'raise', 'allin'];
  for (var a = 0; a < actions.length; a++) {
    (function (act) {
      _bridge.addTool(
        act,
        function () { return executeAction(act); },
        'Click the ' + act + ' button in the poker game',
        {}
      );
    })(actions[a]);
  }

  _bridge.addTool(
    'enable_parent_chain',
    function (args) {
      var gv = getGameView();
      if (!gv) return { success: false, error: 'holdem_game_view not found' };
      var node = findNode(gv, args.nodeName);
      if (!node) return { success: false, error: 'node not found: ' + args.nodeName };
      var chain = enableParentChain(node, gv.parent);
      return { success: true, node: args.nodeName, chain: chain };
    },
    'Enable parent chain for a named Cocos2d node',
    { nodeName: { type: 'string', description: 'Name of the target node' } },
    ['nodeName']
  );

  console.log(TAG, 'Registered 6 action tools on', identity.clientId);

  // Expose API on window for direct eval access
  window.__cwgAction = {
    executeAction: executeAction,
    enableParentChain: enableParentChain,
    findNode: findNode,
    getGameView: getGameView,
    BUTTON_MAP: BUTTON_MAP
  };

  module.exports = {
    executeAction: executeAction,
    enableParentChain: enableParentChain,
    findNode: findNode,
    getGameView: getGameView,
    BUTTON_MAP: BUTTON_MAP
  };
}
