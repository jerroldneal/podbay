; (function () {
  'use strict';

  if (window.__cwgFoldInstalled) return;
  window.__cwgFoldInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-fold] PodBayBridge not available'); return; }

  _bridge.addTool(
    'fold',
    function () {
      if (!window.CWGActionCore) return { success: false, error: 'CWGActionCore not loaded' };
      // giveUpRed = confirmed node name from cwg-action.js; giveupred lowercase fallback
      return window.CWGActionCore.click(['giveUpRed', 'giveupred']);
    },
    'Fold the current hand',
    {}
  );

  console.log('[cwg-fold] registered');
})();
