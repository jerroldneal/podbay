// PodBay Inference Client — LLM-inferred semantic descriptions for discovered elements
// CommonJS module loaded via bootstrap's require polyfill.
//
// Routes inference through the broker's built-in ask_ai tool via the element's
// existing WebSocket connection (call_tool protocol). No direct Ollama fetch —
// avoids CSP/mixed-content issues on HTTPS pages.
//
// Protocol:
//   → ws.send({ type:'call_tool', callId, tool:'ask_ai', arguments:{ prompt, tier:'AI-' } })
//   ← { type:'call_tool_result', callId, content:[{type:'text',text:'...'}] }
//
// Each inferElement(el, ws) call returns a Promise. The caller must route
// incoming call_tool_result messages to handleResult(msg) in ws.onmessage.
//
// Cache: fingerprint (tag + text + aria + placeholder + page URL) → inferred string
// Cache persists for the lifetime of the page — clears on navigation/reload.
'use strict';

var TAG = '[PodBay Inference]';
var __config = {};
var __cache = {};  // fingerprint → description string
var __pending = {};  // callId → { resolve, timer, tag, fp }

function init(config) {
  __config = config || {};
  if (!__config.model) __config.model = 'qwen2.5:3b';
  if (!__config.timeout) __config.timeout = 12000;
  console.log(TAG, 'Initialized. Model:', __config.model, '| timeout:', __config.timeout + 'ms');
}

// ── Fingerprinting ───────────────────────────────────────────────────────

function fingerprint(el) {
  var text = (el.textContent || el.value || '').trim().substring(0, 50);
  var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
  var tag = el.tagName || '';
  var ph = el.placeholder || '';
  var url = (typeof location !== 'undefined' && location.href) || '';
  return [tag, text, aria, ph, url].join('|');
}

// ── Context Assembly ─────────────────────────────────────────────────────

function buildContext(el) {
  var tag = (el.tagName || '').toLowerCase();
  var text = (el.textContent || el.value || '').trim().substring(0, 80);
  var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
  var placeholder = el.placeholder || '';
  var type = el.type || '';
  var id = el.id || null;
  var name = el.name || null;
  var title = el.title || '';
  var role = (el.getAttribute && el.getAttribute('role')) || '';
  var url = (typeof location !== 'undefined' && location.href) || '';
  var pageTitle = (typeof document !== 'undefined' && document.title) || '';

  // Build parent chain — up to 4 ancestor labels for page-context awareness
  var chain = [];
  var parent = el.parentElement;
  var depth = 0;
  while (parent && depth < 4) {
    var pLabel = (parent.getAttribute && parent.getAttribute('aria-label'))
      || parent.id
      || (parent.tagName || '').toLowerCase();
    if (pLabel) chain.unshift(pLabel);
    parent = parent.parentElement;
    depth++;
  }

  var lines = [
    'Element: <' + tag + '>'
    + (type ? ' type="' + type + '"' : '')
    + (id ? ' id="' + id + '"' : '')
    + (name ? ' name="' + name + '"' : '')
    + (role ? ' role="' + role + '"' : '')
  ];
  if (text) lines.push('Text content: ' + text);
  if (aria) lines.push('Aria label: ' + aria);
  if (placeholder) lines.push('Placeholder: ' + placeholder);
  if (title) lines.push('Title attr: ' + title);
  if (chain.length) lines.push('Parent chain: ' + chain.join(' > '));
  lines.push('Page: ' + (pageTitle ? pageTitle + ' \u2014 ' : '') + url);

  return lines.join('\n');
}

// ── Inference ────────────────────────────────────────────────────────────

function inferElement(el, ws) {
  var fp = fingerprint(el);
  if (__cache[fp]) return Promise.resolve(__cache[fp]);

  if (!ws || ws.readyState !== 1) {
    console.log(TAG, 'ws not ready — skipping inference for', el.tagName || '?');
    return Promise.resolve(null);
  }

  var context = buildContext(el);
  var prompt = 'You are documenting UI elements for an AI agent.\n'
    + 'Write ONE sentence (max 12 words) describing what this element does.\n'
    + 'Be specific to its purpose on this page. Start with a verb.\n'
    + 'Examples: "Logs the user into their account", "Searches for a username or email".\n\n'
    + context;

  var callId = 'infer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  console.log(TAG, 'inferElement via broker ask_ai — callId:', callId, 'fp:', fp.substring(0, 50));

  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      if (__pending[callId]) {
        delete __pending[callId];
        console.log(TAG, 'timeout for callId:', callId);
        resolve(null);
      }
    }, __config.timeout);

    __pending[callId] = { resolve: resolve, timer: timer, tag: el.tagName || '?', fp: fp };

    ws.send(JSON.stringify({
      type: 'call_tool',
      callId: callId,
      tool: 'ask_ai',
      arguments: {
        prompt: prompt,
        tier: 'AI-',
        model: __config.model
      }
    }));
  });
}

// ── Result handler — called from ws.onmessage in element-clients ─────────
//
// Returns true if the message was a call_tool_result handled for an inference
// call, false otherwise (so the caller can continue normal message routing).

function handleResult(msg) {
  console.log(TAG, '[HANDLERESULT CALLED]', 'type:', msg.type, 'callId:', msg.callId, 'pending:', !!__pending[msg.callId]);
  if (msg.type !== 'call_tool_result') return false;
  var p = __pending[msg.callId];
  if (!p) {
    console.log(TAG, '[HANDLERESULT NO PENDING]', msg.callId, 'pendingKeys:', Object.keys(__pending));
    return false;
  }

  clearTimeout(p.timer);
  delete __pending[msg.callId];

  var text = '';
  if (!msg.isError && Array.isArray(msg.content)) {
    for (var i = 0; i < msg.content.length; i++) {
      if (msg.content[i].type === 'text') { text = msg.content[i].text || ''; break; }
    }
  } else if (msg.isError) {
    console.log(TAG, 'ask_ai error for callId:', msg.callId, msg.content);
  }

  var desc = text.trim().replace(/\.$/, '').replace(/^["']|["']$/g, '').substring(0, 120);
  console.log(TAG, '[HANDLERESULT RESOLVING]', 'callId:', msg.callId, 'desc:', desc || '(null)');
  if (desc) {
    __cache[p.fp] = desc;
    console.log(TAG, '[' + p.tag + ']', desc);
  }
  p.resolve(desc || null);
  console.log(TAG, '[HANDLERESULT COMPLETED]', msg.callId);
  return true;
}

// ── Utilities ────────────────────────────────────────────────────────────

function clearCache() { __cache = {}; }
function getCacheSize() { return Object.keys(__cache).length; }
function getCache() { return __cache; }

module.exports = {
  init: init,
  inferElement: inferElement,
  handleResult: handleResult,
  clearCache: clearCache,
  getCacheSize: getCacheSize,
  getCache: getCache
};
