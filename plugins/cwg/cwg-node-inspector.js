; (function () {
  'use strict';

  if (window.CWGNodeInspector) return;

  var TAG = '[CWGNodeInspector]';

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn(TAG, 'PodBayBridge not available'); return; }

  var _enabled = false;
  var _log = [];
  var MAX_LOG = 50;
  var _origOnTouchBegan = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function parentChain(node, maxDepth) {
    var chain = [];
    var current = node && node.parent;
    var depth = 0;
    while (current && depth < (maxDepth || 10)) {
      chain.push(current.name || '(unnamed)');
      current = current.parent;
      depth++;
    }
    return chain;
  }

  function componentSummary(node) {
    if (!node._components && !node.getComponents) return [];
    var comps = node._components || [];
    if (!comps.length && typeof node.getComponents === 'function') {
      try { comps = node.getComponents(cc.Component) || []; } catch (e) { }
    }
    return comps.map(function (c) {
      if (!c) return null;
      var name = (c.name) || (c.__classname__) || (c.constructor && c.constructor.name) || 'unknown';
      var props = {};
      try {
        if (c.string !== undefined) props.string = c.string;
        if (c.spriteFrame && c.spriteFrame.name) props.spriteFrame = c.spriteFrame.name;
        if (c.node !== node && c.node) props.targetNode = c.node.name;
        if (typeof c.enabled !== 'undefined') props.enabled = c.enabled;
      } catch (e) { }
      return { type: name, props: props };
    }).filter(Boolean);
  }

  function captureNode(node) {
    if (!node) return null;

    var pos = { x: 0, y: 0 };
    try { pos = { x: node.x, y: node.y }; } catch (e) { }

    var size = { w: 0, h: 0 };
    try {
      if (node.width !== undefined) size = { w: node.width, h: node.height };
      else if (node.getContentSize) {
        var s = node.getContentSize();
        size = { w: s.width, h: s.height };
      }
    } catch (e) { }

    var childrenNames = [];
    try {
      var kids = node.children || node._children || [];
      childrenNames = kids.slice(0, 20).map(function (c) { return c.name || '(unnamed)'; });
    } catch (e) { }

    return {
      ts: Date.now(),
      name: node.name || '(unnamed)',
      uuid: node.uuid || node._id || null,
      active: node.active !== undefined ? node.active : node.activeInHierarchy,
      position: pos,
      size: size,
      parentChain: parentChain(node, 10),
      components: componentSummary(node),
      childrenNames: childrenNames
    };
  }

  // ── Hook ─────────────────────────────────────────────────────────────────

  function enableHook() {
    if (!window.cc || !cc.Node) {
      console.warn(TAG, 'cc.Node not available — Cocos2d not loaded yet');
      return false;
    }
    if (_origOnTouchBegan) return true; // already hooked

    _origOnTouchBegan = cc.Node.prototype._onTouchBegan;
    cc.Node.prototype._onTouchBegan = function (touch, event) {
      if (_enabled) {
        try {
          var record = captureNode(this);
          if (record) {
            _log.push(record);
            if (_log.length > MAX_LOG) _log.shift();
          }
        } catch (e) {
          console.error(TAG, 'capture failed', e);
        }
      }
      // Always propagate
      if (_origOnTouchBegan) {
        return _origOnTouchBegan.call(this, touch, event);
      }
    };
    console.log(TAG, 'hook installed on cc.Node.prototype._onTouchBegan');
    return true;
  }

  function disableHook() {
    _enabled = false;
    // Leave the monkey-patch installed (low overhead, non-destructive)
    // Inspection just stops recording
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.CWGNodeInspector = {
    enable: function () {
      var ok = enableHook();
      if (ok) _enabled = true;
      return ok;
    },
    disable: function () {
      disableHook();
    },
    getLog: function (n) {
      var count = n || 5;
      return _log.slice(-count);
    },
    getLastClicked: function () {
      return _log.length ? _log[_log.length - 1] : null;
    },
    isEnabled: function () {
      return _enabled;
    },
    clearLog: function () {
      _log = [];
    }
  };

  // ── MCP tools ─────────────────────────────────────────────────────────────

  _bridge.addTool(
    'set_node_inspect',
    function (args) {
      var enabled = args && args.enabled;
      if (enabled) {
        var ok = window.CWGNodeInspector.enable();
        return { enabled: ok, message: ok ? 'Node inspection active — click any node' : 'cc.Node not available yet' };
      } else {
        window.CWGNodeInspector.disable();
        return { enabled: false };
      }
    },
    'Enable or disable Cocos2d node inspection. When enabled, clicking any node records its name, uuid, parent chain, components, position, size, and children to the inspect log.',
    { type: 'object', properties: { enabled: { description: 'true to enable, false to disable' } }, required: ['enabled'] }
  );

  _bridge.addTool(
    'get_node_inspect_log',
    function (args) {
      var n = (args && args.last) ? Number(args.last) : 5;
      return window.CWGNodeInspector.getLog(n);
    },
    'Returns last N clicked node records (default 5). Each entry: { ts, name, uuid, active, position, size, parentChain, components, childrenNames }',
    { type: 'object', properties: { last: { description: 'Number of entries to return (default 5)' } } }
  );

  _bridge.addTool(
    'get_last_clicked_node',
    function () {
      return window.CWGNodeInspector.getLastClicked();
    },
    'Returns the most recently clicked Cocos2d node record',
    {}
  );

  _bridge.addTool(
    'clear_node_inspect_log',
    function () {
      window.CWGNodeInspector.clearLog();
      return { cleared: true };
    },
    'Clear the node inspection log',
    {}
  );

  console.log(TAG, 'registered');
})();
