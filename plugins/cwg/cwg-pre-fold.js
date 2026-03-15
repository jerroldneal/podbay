; (function () {
  'use strict';

  if (window.__cwgPreFoldInstalled) return;
  window.__cwgPreFoldInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-pre-fold] PodBayBridge not available'); return; }

  function setPreAction(nodeNames, enabled) {
    if (!window.CWGCore || !window.CWGActionCore) {
      return { success: false, error: 'CWGCore or CWGActionCore not loaded' };
    }
    var gv = window.CWGActionCore.getGameView();
    if (!gv) return { success: false, error: 'holdem_game_view not found' };
    var preBetRoot = window.CWGCore.findNode(gv, 'PreBetBtns');
    var searchRoot = preBetRoot || gv;
    var candidates = Array.isArray(nodeNames) ? nodeNames : [nodeNames];
    for (var n = 0; n < candidates.length; n++) {
      var node = window.CWGCore.findNode(searchRoot, candidates[n]);
      if (!node) continue;
      var comps = node._components || [];
      for (var i = 0; i < comps.length; i++) {
        if (comps[i].isChecked !== undefined) {
          comps[i].isChecked = enabled;
          comps[i].node.emit('toggle', comps[i]);
          return { success: true, node: candidates[n], enabled: enabled };
        }
      }
    }
    return { success: false, error: 'pre-action node not found', tried: candidates };
  }

  _bridge.addTool(
    'pre_fold',
    function (params) {
      var enabled = params && params.enabled !== undefined ? !!params.enabled : true;
      return setPreAction(['prebetFold'], enabled);
    },
    'Set the pre-fold toggle (enabled=true to arm, false to disarm)',
    { enabled: { type: 'boolean', description: 'true = arm fold, false = disarm' } }
  );

  console.log('[cwg-pre-fold] registered');
})();
