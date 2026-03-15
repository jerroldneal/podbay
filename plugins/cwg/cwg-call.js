; (function () {
  'use strict';

  if (window.__cwgCallInstalled) return;
  window.__cwgCallInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-call] PodBayBridge not available'); return; }

  _bridge.addTool(
    'call',
    function () {
      if (!window.CWGActionCore) return { success: false, error: 'CWGActionCore not loaded' };
      // callBtn = Phase 0 confirmed node name; followFl_Blue = legacy fallback from cwg-action.js
      return window.CWGActionCore.click(['callBtn', 'followFl_Blue']);
    },
    'Call the current bet',
    {}
  );

  console.log('[cwg-call] registered');
})();
