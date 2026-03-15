; (function () {
  'use strict';

  if (window.CWGHandLifecycle) return;

  // ── Hand index & new-hand detection ─────────────────────────────────────
  // Tracks the current hand number. Incremented automatically when the end-of-
  // hand cover sequence is detected (sprite hook fires schedule).
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
      // Clear all per-hand face tracking on new hand
      _faceSeenThisHand = {};
      _lastFaceTs = {};
      _lastFaceCard = {};
      _pendingFlip = {};
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
    _faceSeenThisHand = {};
    _lastFaceTs = {};
    _lastFaceCard = {};
    _pendingFlip = {};
    handIndex = 0;
  }

  // ── Per-node face tracking (used by cwg-opponent-cards) ──────────────────
  // nodeId = cc.Sprite component._id — unique per sprite component instance

  var _faceSeenThisHand = {};  // nodeId → true  (face card seen this hand on this sprite)
  var _lastFaceTs = {};         // nodeId → performance.now() at time of last face assignment
  var _lastFaceCard = {};       // nodeId → frameId of the last face card shown on this node

  function markFaceSeen(nodeId, frameId) {
    _faceSeenThisHand[nodeId] = true;
    _lastFaceTs[nodeId] = performance.now();
    _lastFaceCard[nodeId] = frameId;
  }

  function hasFaceSeen(nodeId) {
    return !!_faceSeenThisHand[nodeId];
  }

  function clearFaceSeen(nodeId) {
    delete _faceSeenThisHand[nodeId];
    delete _lastFaceTs[nodeId];
    delete _lastFaceCard[nodeId];
  }

  function getLastFaceCard(nodeId) {
    return _lastFaceCard[nodeId] || null;
  }

  function getLastFaceTs(nodeId) {
    return _lastFaceTs[nodeId] || null;
  }

  // ── Pending flip state (populated by cwg-flip-hook, consumed by cwg-opponent-cards) ──

  var _pendingFlip = {};  // spriteId → { cardId, ts }

  function setPendingFlip(spriteId, cardId) {
    _pendingFlip[spriteId] = { cardId: cardId, ts: performance.now() };
  }

  function getPendingFlip(spriteId) {
    return _pendingFlip[spriteId] || null;
  }

  function clearPendingFlip(spriteId) {
    delete _pendingFlip[spriteId];
  }

  window.CWGHandLifecycle = {
    schedule: schedule,      // call when end-of-hand cover detected
    cancel: cancel,        // call when a new deal starts before timer fires
    getHandIndex: getHandIndex,
    reset: reset,
    // Face tracking
    markFaceSeen: markFaceSeen,
    hasFaceSeen: hasFaceSeen,
    clearFaceSeen: clearFaceSeen,
    getLastFaceCard: getLastFaceCard,
    getLastFaceTs: getLastFaceTs,
    // Pending flip (flip-hook → opponent-cards)
    setPendingFlip: setPendingFlip,
    getPendingFlip: getPendingFlip,
    clearPendingFlip: clearPendingFlip,
    // Constant
    NEW_HAND_DEBOUNCE_MS: NEW_HAND_DEBOUNCE_MS
  };

  console.log('[CWGHandLifecycle] ready');
})();
