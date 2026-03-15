; (function () {
  'use strict';

  if (window.__cwgCheckInstalled) return;
  window.__cwgCheckInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-check] PodBayBridge not available'); return; }

  _bridge.addTool(
    'check',
    function () {
      if (!window.CWGActionCore) return { success: false, error: 'CWGActionCore not loaded' };
      // checkBtn = Phase 0 confirmed node name; free_bet_button = legacy fallback from cwg-action.js
      return window.CWGActionCore.click(['checkBtn', 'free_bet_button']);
    },
    'Check (pass) when no bet is pending',
    {}
  );

  console.log('[cwg-check] registered');
})();
