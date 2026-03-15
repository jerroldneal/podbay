; (function () {
  'use strict';

  if (window.__cwgRaiseInstalled) return;
  window.__cwgRaiseInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-raise] PodBayBridge not available'); return; }

  // Slider component lookup
  function getSliderComp(gv) {
    var node = window.CWGCore.findNode(gv, 'betSlider');
    if (!node) return null;
    var comps = node._components || [];
    for (var i = 0; i < comps.length; i++) {
      if (typeof comps[i].updateByValue === 'function') return comps[i];
    }
    return null;
  }

  // Pot label from scene root
  function readPot() {
    var scene = window.CWGCore.getScene();
    var potNode = scene ? window.CWGCore.findNode(scene, 'total_pot_label') : null;
    var txt = potNode ? window.CWGCore.getText(potNode) : null;
    return txt ? parseInt(txt.replace(/[^0-9]/g, ''), 10) || null : null;
  }

  /**
   * Amount resolver — sliderMin used as proxy for 1 BB.
   */
  function resolveAmount(input, sliderMin, sliderMax, potSize) {
    if (typeof input === 'number') return input;
    var s = String(input).toLowerCase().trim();
    if (s === 'min') return sliderMin;
    if (s === 'max') return sliderMax;
    if (s === 'pot') return potSize || sliderMin;
    if (s === 'half') return potSize ? Math.round(potSize / 2) : sliderMin;
    if (s.slice(-2) === 'bb') {
      var mul = parseFloat(s);
      if (!isNaN(mul) && sliderMin) return Math.round(mul * sliderMin);
    }
    var raw = Math.round(parseFloat(s));
    return (!isNaN(raw) && raw > 0) ? raw : sliderMin;
  }

  _bridge.addTool(
    'raise',
    function (params) {
      if (!window.CWGCore || !window.CWGActionCore) {
        return { success: false, error: 'CWGCore or CWGActionCore not loaded' };
      }
      var gv = window.CWGActionCore.getGameView();
      if (!gv) return { success: false, error: 'holdem_game_view not found' };

      var sliderComp = getSliderComp(gv);
      if (!sliderComp) return { success: false, error: 'bet slider not found' };

      var sliderMin = sliderComp.minValue != null ? sliderComp.minValue : 0;
      var sliderMax = sliderComp.maxValue != null ? sliderComp.maxValue : Infinity;
      var potSize = readPot();
      var rawInput = (params && params.amount != null) ? params.amount : 'min';
      var chipAmount = resolveAmount(rawInput, sliderMin, sliderMax, potSize);

      // Set slider — do NOT set slider.value directly; updateByValue handles clamping
      sliderComp.updateByValue(chipAmount);

      // Click the raise/bet confirm button (label says "Raise" when facing a bet)
      var clickResult = window.CWGActionCore.click(['raiseBtn', 'raise_button_img', 'raise_button']);

      return {
        success: clickResult.success,
        requestedAmount: rawInput,
        resolvedAmount: chipAmount,
        sliderMin: sliderMin,
        sliderMax: sliderMax,
        buttonResult: clickResult
      };
    },
    'Set a raise amount and confirm (supports: number, "pot", "half", "min", "max", "2bb")',
    { amount: { type: 'string', description: 'Raise size — number, "pot", "half", "min", "max", or "Nbb"' } }
  );

  console.log('[cwg-raise] registered');
})();
