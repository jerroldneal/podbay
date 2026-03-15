; (function () {
  'use strict';

  if (window.__cwgAllinInstalled) return;
  window.__cwgAllinInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-allin] PodBayBridge not available'); return; }

  _bridge.addTool(
    'allin',
    function () {
      if (!window.CWGActionCore) return { success: false, error: 'CWGActionCore not loaded' };
      // AllInBtn = Phase 0 confirmed node name; allin / all_in = legacy fallbacks from cwg-action.js
      return window.CWGActionCore.click(['AllInBtn', 'allin', 'all_in']);
    },
    'Go all-in with full chip stack',
    {}
  );

  console.log('[cwg-allin] registered');
})();
