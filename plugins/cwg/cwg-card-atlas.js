; (function () {
  'use strict';

  if (window.CWGCardAtlas) return;

  // ── Card atlas ───────────────────────────────────────────────────────────
  // Maps Cocos2d atlas frame IDs → human-readable card strings (e.g. "A♠").
  // Frame ID ranges derived from the CWG sprite sheet:
  //   18–30  = ♦2 through ♦A
  //   34–46  = ♣2 through ♣A
  //   66–78  = ♥2 through ♥A
  //  130–142 = ♠2 through ♠A
  var SUITS = [
    { start: 18, suit: '♦' },
    { start: 34, suit: '♣' },
    { start: 66, suit: '♥' },
    { start: 130, suit: '♠' }
  ];
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

  function decode(frameId) {
    for (var s = 0; s < SUITS.length; s++) {
      var offset = frameId - SUITS[s].start;
      if (offset >= 0 && offset <= 12) return RANKS[offset] + SUITS[s].suit;
    }
    return null;
  }

  // Returns true if the sprite frame name is a back-face (cover) texture.
  // Back-face names start with "cards_back" in the CWG atlas.
  function isBackFace(sfName) {
    return typeof sfName === 'string' && sfName.indexOf('cards_back') === 0;
  }

  window.CWGCardAtlas = {
    decode: decode,
    isBackFace: isBackFace,
    SUITS: SUITS,
    RANKS: RANKS
  };

  console.log('[CWGCardAtlas] ready');
})();
