'use strict';

  var TAG = '[CWGActionCore]';

  // ── Button click logic ───────────────────────────────────────────────────
  // Tries three strategies in order: _releaseAction, clickEvents.emit, node.emit.
  // Returns the method name that worked (or 'none').
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

  // ── Scene helpers (delegates to CWGCore if available) ───────────────────
  function getGameView() {
    if (window.CWGCore) return window.CWGCore.getGameView();
    // Fallback: inline if CWGCore not loaded
    if (typeof cc === 'undefined' || !cc.director) return null;
    var scene = cc.director.getRunningScene();
    if (!scene) return null;
    var q = [scene];
    while (q.length) {
      var n = q.shift();
      if ((n._name || n.name) === 'holdem_game_view') return n;
      var ch = n._children || n.children || [];
      for (var i = 0; i < ch.length; i++) q.push(ch[i]);
    }
    return null;
  }

  function findNode(root, name) {
    if (window.CWGCore) return window.CWGCore.findNode(root, name);
    var q = [root];
    while (q.length) {
      var n = q.shift();
      if (n._name === name || n.name === name) return n;
      var ch = n._children || n.children || [];
      for (var i = 0; i < ch.length; i++) q.push(ch[i]);
    }
    return null;
  }

  function enableParentChain(node, stopAt) {
    if (window.CWGCore) return window.CWGCore.enableParentChain(node, stopAt);
    var chain = [];
    var cur = node;
    while (cur && cur !== stopAt) {
      if (!cur.active) cur.active = true;
      if (cur.opacity < 255) cur.opacity = 255;
      chain.push(cur._name || cur.name || '(unnamed)');
      cur = cur.parent || cur._parent;
    }
    return chain;
  }

  // ── Main click entry point ───────────────────────────────────────────────
  // nodeNames: string or array of candidate names (tries each until one found).
  // Searches inside BetButons container first, then falls back to full game view.
  // Returns { success, node, method, chain } or { success: false, error, tried }.
  function click(nodeNames) {
    var gv = getGameView();
    if (!gv) return { success: false, error: 'holdem_game_view not found' };

    var candidates = Array.isArray(nodeNames) ? nodeNames : [nodeNames];
    var betContainer = findNode(gv, 'BetButons') || gv;

    for (var i = 0; i < candidates.length; i++) {
      var target = findNode(betContainer, candidates[i]);
      if (target) {
        var chain = enableParentChain(target, gv.parent || gv);
        var method = clickButton(target);
        console.log(TAG, 'clicked', candidates[i], 'via', method);
        return { success: true, node: candidates[i], method: method, chain: chain };
      }
    }
    return { success: false, error: 'button not found', tried: candidates };
  }

var CWGActionCore = {
    click: click,
    clickButton: clickButton,
    getGameView: getGameView,
    findNode: findNode,
    enableParentChain: enableParentChain
  };

  console.log(TAG, 'ready');

module.exports = CWGActionCore;
window.CWGActionCore = CWGActionCore;
