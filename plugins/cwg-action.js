;(function () {
  'use strict';

  if (!window.PodBayIdentity.isGame) return;
  if (window.__cwgActionInstalled) return;
  window.__cwgActionInstalled = true;

  var TAG = '[CWG-Action]';

  var BUTTON_MAP = {
    fold:  ['giveUpRed', 'giveupred'],
    call:  ['followFl_Blue'],
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

  function isGameView() {
    var gv = getGameView();
    return !!gv;
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

  // Register tools via PodBayBridge with identity-derived clientId so tools appear
  // as cwg-table-xxx__fold (not cwg__fold from the base system-plugin clientId)
  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId)
    : null;

  if (_bridge) {
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

    console.log(TAG, 'Registered 6 action tools (fold/call/check/raise/allin/enable_parent_chain) on', window.PodBayIdentity.clientId);
  } else {
    console.warn(TAG, 'PodBayBridge or PodBayIdentity not available — tools not registered');
  }

  // Expose API on window for direct eval access
  window.__cwgAction = {
    executeAction: executeAction,
    enableParentChain: enableParentChain,
    findNode: findNode,
    getGameView: getGameView,
    BUTTON_MAP: BUTTON_MAP
  };
  alert(TAG + ' API exposed on window.__cwgAction with executeAction(actionName) method');
})();
