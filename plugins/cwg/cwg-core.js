'use strict';

// CWG Core — Cocos2d scene utilities
// Loaded as a lib module by PodBay; consumers: require('cwg-core')
// No IIFE, no window globals — the bundle assembler handles registration.

// ── Scene access ─────────────────────────────────────────────────────────
function getScene() {
  return typeof cc !== 'undefined' && cc.director && cc.director.getRunningScene
    ? cc.director.getRunningScene() : null;
}

// ── BFS node finder ──────────────────────────────────────────────────────
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

// ── Node utilities ───────────────────────────────────────────────────────
function nodeChildren(node) { return node._children || node.children || []; }
function nodeName(node) { return node._name || node.name || ''; }

function getText(node) {
  if (!node._components) return null;
  for (var i = 0; i < node._components.length; i++) {
    var c = node._components[i];
    if (c && typeof c.string === 'string') return c.string;
  }
  return null;
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

// ── Game view shortcut ───────────────────────────────────────────────────
function getGameView() {
  var scene = getScene();
  if (!scene) return null;
  return findNode(scene, 'holdem_game_view');
}

// ── Parent chain enabler ─────────────────────────────────────────────────
// Walks up from node to stopAt (exclusive), activating and making opaque.
// Returns array of node names touched for debugging.
function enableParentChain(node, stopAt) {
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

// ── Node path helper ─────────────────────────────────────────────────────
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

module.exports = {
  getScene: getScene,
  findNode: findNode,
  nodeChildren: nodeChildren,
  nodeName: nodeName,
  getText: getText,
  nodePos: nodePos,
  getGameView: getGameView,
  enableParentChain: enableParentChain,
  nodePath: nodePath
};
