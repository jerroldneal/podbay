// ClubWPT Gold Frame Bridge — injected into the clubwptgold.com iframe
// by the main process frame injector (did-frame-navigate).
//
// General-purpose bridge: listens for postMessage commands from the
// parent window and dispatches them to registered handlers.
// Extensible — new command handlers can be added below.
; (function () {
  'use strict';
  if (window.__podbayFrameBridge) return;
  window.__podbayFrameBridge = true;

  var TAG = '[PodBay Frame Bridge]';
  var CHANNEL = '__podbay_frame_cmd';

  // ── Command Registry ──────────────────────────────────────────────
  var handlers = {};

  function registerCommand(name, fn) {
    handlers[name] = fn;
    console.log(TAG, 'Registered command:', name);
  }

  // ── Message Listener ──────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    var cmd = data.command;
    if (!cmd || !handlers[cmd]) {
      console.warn(TAG, 'Unknown command:', cmd);
      return;
    }
    console.log(TAG, 'Executing command:', cmd);
    try {
      var result = handlers[cmd](data);
      // Respond to parent if a callbackId was provided
      if (data.callbackId && event.source) {
        event.source.postMessage({
          channel: CHANNEL,
          type: 'response',
          callbackId: data.callbackId,
          result: result
        }, '*');
      }
    } catch (e) {
      console.error(TAG, 'Command failed:', cmd, e.message);
      if (data.callbackId && event.source) {
        event.source.postMessage({
          channel: CHANNEL,
          type: 'response',
          callbackId: data.callbackId,
          error: e.message
        }, '*');
      }
    }
  });

  // ── Built-in Commands ─────────────────────────────────────────────

  // ── Helpers ─────────────────────────────────────────────────────
  // Force-set input value via native setter (triggers Vue/React reactivity)
  var nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  ).set;

  function setInputValue(input, val) {
    nativeSetter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Dispatch a full pointer + mouse event sequence (works on Vuetify v-btn)
  function fullClick(el) {
    el.removeAttribute('disabled');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // login — set phone input + click button (async: waits for Vue reactivity)
  registerCommand('login', function (data) {
    var input = document.querySelector(data.inputSelector);
    if (!input) throw new Error('Input not found: ' + data.inputSelector);
    // Use native setter so Vue detects the change
    setInputValue(input, '');
    input.focus();
    setInputValue(input, data.phone);
    // Defer button click to let Vue reactivity enable the button
    setTimeout(function () {
      var btn = document.querySelector(data.buttonSelector);
      if (!btn) {
        console.error(TAG, 'Button not found after delay:', data.buttonSelector);
        return;
      }
      // Remove disabled state and fire full event sequence
      btn.classList.remove('v-btn--disabled', 'btn-disable');
      fullClick(btn);
      console.log(TAG, 'Login complete — native setter + full event sequence');
    }, 500);
    return { success: true, note: 'native setter + full event sequence deferred 500ms' };
  });

  // query — querySelector and return text/value
  registerCommand('query', function (data) {
    var el = document.querySelector(data.selector);
    if (!el) return { found: false };
    return {
      found: true,
      tagName: el.tagName,
      text: el.textContent || '',
      value: el.value || '',
      id: el.id || '',
      className: el.className || ''
    };
  });

  // queryAll — querySelectorAll and return array of matches
  registerCommand('queryAll', function (data) {
    var els = document.querySelectorAll(data.selector);
    var results = [];
    for (var i = 0; i < els.length; i++) {
      results.push({
        tagName: els[i].tagName,
        text: (els[i].textContent || '').substring(0, 200),
        id: els[i].id || '',
        className: els[i].className || ''
      });
    }
    return { count: results.length, elements: results };
  });

  // click — click a specific element (full event sequence)
  registerCommand('click', function (data) {
    var el = document.querySelector(data.selector);
    if (!el) throw new Error('Element not found: ' + data.selector);
    fullClick(el);
    return { clicked: true };
  });

  // setValue — set value on an input element (native setter)
  registerCommand('setValue', function (data) {
    var el = document.querySelector(data.selector);
    if (!el) throw new Error('Element not found: ' + data.selector);
    setInputValue(el, data.value || '');
    return { set: true };
  });

  // exec — run arbitrary JS in the frame context (for debugging)
  registerCommand('exec', function (data) {
    var result = (0, eval)(data.code);
    return { result: result === undefined ? 'undefined' : String(result) };
  });

  // ping — health check
  registerCommand('ping', function () {
    return { pong: true, url: location.href, timestamp: new Date().toISOString() };
  });

  console.log(TAG, 'Bridge installed on', location.href);
  console.log(TAG, 'Commands:', Object.keys(handlers).join(', '));
})();
