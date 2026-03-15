; (function () {
  'use strict';

  if (window.CWGHandLifecycle) return;

  // ── Hand index & new-hand detection ─────────────────────────────────────
  // Tracks the current hand number. Incremented automatically when the end-of-
  // hand cover sequence is detected (sprite hook fires scheduleNewHand).
  // All other plugins that track per-hand state read handIndex from here.

  var handIndex = 0;
  var _timer = null;
  // Wait this long after the last end-of-hand cover before incrementing.
  // A new deal (face event) arriving sooner cancels the timer.
  var NEW_HAND_DEBOUNCE_MS = 800;

  function schedule() {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () {
      _timer = null;
      handIndex++;
      console.log('[CWGHandLifecycle] new hand → handIndex=' + handIndex);
    }, NEW_HAND_DEBOUNCE_MS);
  }

  function cancel() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  function getHandIndex() { return handIndex; }

  function reset() {
    cancel();
    handIndex = 0;
  }

  window.CWGHandLifecycle = {
    schedule: schedule,   // call when end-of-hand cover detected
    cancel: cancel,       // call when a new deal starts before timer fires
    getHandIndex: getHandIndex,
    reset: reset,
    NEW_HAND_DEBOUNCE_MS: NEW_HAND_DEBOUNCE_MS
  };

  console.log('[CWGHandLifecycle] ready');
})();
