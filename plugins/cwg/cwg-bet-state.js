; (function () {
  'use strict';

  if (window.__cwgBetStateInstalled) return;
  window.__cwgBetStateInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-bet-state] PodBayBridge not available'); return; }

  // Find the BetSliderLandscape component — identified by the presence of updateByValue()
  function getSliderComp(gv) {
    var sliderNode = window.CWGCore.findNode(gv, 'betSlider');
    if (!sliderNode) return null;
    var comps = sliderNode._components || [];
    for (var i = 0; i < comps.length; i++) {
      if (typeof comps[i].updateByValue === 'function') return comps[i];
    }
    return null;
  }

  // Read text from a named node under gv (action panel area)
  function readText(gv, nodeName) {
    var node = window.CWGCore.findNode(gv, nodeName);
    return node ? window.CWGCore.getText(node) : null;
  }

  // Read pot from scene root (total_pot_label may be outside holdem_game_view)
  function readPot() {
    var scene = window.CWGCore.getScene();
    if (!scene) return null;
    var potNode = window.CWGCore.findNode(scene, 'total_pot_label');
    return potNode ? window.CWGCore.getText(potNode) : null;
  }

  _bridge.addTool(
    'get_bet_state',
    function () {
      if (!window.CWGCore || !window.CWGActionCore) {
        return { success: false, error: 'CWGCore or CWGActionCore not loaded' };
      }

      var gv = window.CWGActionCore.getGameView();
      if (!gv) return { success: false, error: 'holdem_game_view not found' };

      var callAmount = readText(gv, 'callValue');
      var raiseAmount = readText(gv, 'raiseValue');
      var potSize = readPot();

      var sliderComp = getSliderComp(gv);
      var sliderMin = sliderComp ? (sliderComp.minValue != null ? sliderComp.minValue : null) : null;
      var sliderMax = sliderComp ? (sliderComp.maxValue != null ? sliderComp.maxValue : null) : null;
      // sliderCurrent: prefer valueLabel text, fall back to raw normalised value
      var sliderCurrent = null;
      if (sliderComp) {
        var vl = sliderComp.valueLabel;
        if (vl && vl.node) {
          sliderCurrent = window.CWGCore.getText(vl.node);
        }
        if (sliderCurrent == null && sliderComp.value != null) {
          sliderCurrent = sliderComp.value;
        }
      }

      return {
        success: true,
        callAmount: callAmount,
        raiseAmount: raiseAmount,
        potSize: potSize,
        sliderMin: sliderMin,
        sliderMax: sliderMax,
        sliderCurrent: sliderCurrent
      };
    },
    'Read the current call amount, raise amount, pot size, and bet slider state',
    {}
  );

  console.log('[cwg-bet-state] registered');
})();
