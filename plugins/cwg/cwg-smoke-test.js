; (function () {
  'use strict';
  if (window.__cwgSmokeTestInstalled) return;
  window.__cwgSmokeTestInstalled = true;

  var _bridge = (window.PodBayBridge && window.PodBayIdentity)
    ? window.PodBayBridge(window.PodBayIdentity.clientId) : null;
  if (!_bridge) { console.warn('[cwg-smoke-test] PodBayBridge not available'); return; }

  /* ── helpers ──────────────────────────────────────── */
  function check(label, fn) {
    try {
      var value = fn();
      var pass = value !== undefined && value !== null && value !== false;
      console[pass ? 'log' : 'warn']((pass ? '✅' : '❌') + ' ' + label);
      return { label: label, pass: pass, value: pass ? String(value).slice(0, 80) : undefined };
    } catch (e) {
      console.error('❌ ' + label + ' — ' + e.message);
      return { label: label, pass: false, error: e.message };
    }
  }

  /* ── smoke test ───────────────────────────────────── */
  function runSmokeTest() {
    var results = [];

    // ── Infrastructure globals ──────────────────────────
    results.push(check('CWGCore global present', function () { return !!window.CWGCore; }));
    results.push(check('CWGCore.getScene() returns scene', function () { return window.CWGCore && window.CWGCore.getScene(); }));
    results.push(check('CWGCardAtlas global present', function () { return !!window.CWGCardAtlas; }));
    results.push(check('CWGCardAtlas.decode(130) === "A♠"', function () {
      return window.CWGCardAtlas && window.CWGCardAtlas.decode(130) === 'A\u2660';
    }));
    results.push(check('CWGCardAtlas.isBackFace("cards_back_0") === true', function () {
      return window.CWGCardAtlas && window.CWGCardAtlas.isBackFace('cards_back_0') === true;
    }));
    results.push(check('CWGHandLifecycle global present', function () { return !!window.CWGHandLifecycle; }));
    results.push(check('CWGHandLifecycle.getHandIndex() is a number', function () {
      var v = window.CWGHandLifecycle && window.CWGHandLifecycle.getHandIndex();
      return typeof v === 'number';
    }));
    results.push(check('CWGHandLifecycle face-tracking API present', function () {
      var h = window.CWGHandLifecycle;
      return h && h.markFaceSeen && h.hasFaceSeen && h.getLastFaceCard && h.setPendingFlip && h.getPendingFlip;
    }));
    results.push(check('CWGActionCore global present', function () { return !!window.CWGActionCore; }));
    results.push(check('CWGActionCore.getGameView() returns node', function () {
      return window.CWGActionCore && window.CWGActionCore.getGameView();
    }));

    // ── Hook globals ────────────────────────────────────
    results.push(check('CWGFlipHook global present', function () { return !!window.CWGFlipHook; }));
    results.push(check('CWGFlipHook.status() returns object', function () {
      var s = window.CWGFlipHook && window.CWGFlipHook.status();
      return s && typeof s === 'object';
    }));
    results.push(check('CWGVerboseHook global present', function () { return !!window.CWGVerboseHook; }));
    results.push(check('CWGVerboseHook.status() returns object', function () {
      var s = window.CWGVerboseHook && window.CWGVerboseHook.status();
      return s && typeof s === 'object';
    }));
    results.push(check('CWGOpponentCards global present', function () { return !!window.CWGOpponentCards; }));
    results.push(check('CWGOpponentCards.status() returns object', function () {
      var s = window.CWGOpponentCards && window.CWGOpponentCards.status();
      return s && typeof s === 'object';
    }));

    // ── Summary ─────────────────────────────────────────
    var passed = results.filter(function (r) { return r.pass; }).length;
    var total = results.length;
    var allPass = passed === total;
    var summary = (allPass ? '✅ ALL PASS' : '⚠️ ' + (total - passed) + ' FAILED') +
      '  (' + passed + '/' + total + ')';
    console.log('\n[cwg-smoke-test] ' + summary + '\n');

    return {
      summary: summary,
      passed: passed,
      total: total,
      allPass: allPass,
      results: results
    };
  }

  /* ── MCP tool ─────────────────────────────────────── */
  _bridge.addTool(
    'run_smoke_test',
    function () { return runSmokeTest(); },
    'Run CWG plugin library smoke test — checks all infrastructure globals, card atlas, hand lifecycle, action core, and hook plugins',
    {}
  );

  /* ── expose ───────────────────────────────────────── */
  window.CWGSmokeTest = { run: runSmokeTest };

  console.log('[cwg-smoke-test] registered — call run_smoke_test to verify all plugins');
})();
