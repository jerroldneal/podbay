// PodBay Element Clients — DOM element observation and per-element broker clients
// CommonJS module loaded via bootstrap's require polyfill.
//
// Mirrors the frame client pattern: detect element → assign unique name →
// open dedicated WebSocket → register tools with broker.
//
// Tracks:
//   Containers: <form>, <nav>, <section>, <article>, <aside>, <dialog>,
//               <main>, <header>, <footer>, [role="dialog|navigation|form|region"]
//     → Each container becomes its own broker client with 'info' + 'children' tools.
//   Buttons: <button>, <input type="button|submit">, [role="button"]
//     → Each button becomes its own broker client with an 'info' tool.
//   Inputs:  <input> (text types), <textarea>, <select>, [contenteditable]
//     → Each input becomes its own broker client with 'info' + 'input' tools.
//
// Hierarchy: Document/Frame → Container → (nested Container | Button | Input)
// Elements are parented under their nearest container ancestor, not the root.
//
// Usage:
//   var elementClients = require('element-clients');
//   elementClients.init({ broker: 'ws://localhost:3099', parentClientId: 'my-app' });
'use strict';

var TAG = '[PodBay Elements]';
var __counter = 0;
var __clients = {};      // clientId → { ws, element, cleanup }
var __children = {};     // containerClientId → [childClientId, ...]
var __config = {};
var __observer = null;
var __inferenceClient = null;  // set in init() if ollamaUrl is configured

// ── Helpers ──────────────────────────────────────────────────────────────

function isButton(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'INPUT') {
    var t = (el.type || '').toLowerCase();
    return t === 'button' || t === 'submit';
  }
  if (el.getAttribute && el.getAttribute('role') === 'button') return true;
  return false;
}

function isInput(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    var t = (el.type || '').toLowerCase();
    // Exclude button-type and hidden inputs (buttons handled by isButton)
    return t !== 'button' && t !== 'submit' && t !== 'hidden';
  }
  if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

var CONTAINER_TAGS = { FORM: 1, NAV: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, DIALOG: 1, MAIN: 1, HEADER: 1, FOOTER: 1 };
var CONTAINER_ROLES = { dialog: 1, navigation: 1, form: 1, region: 1, banner: 1, complementary: 1, contentinfo: 1, search: 1 };

function isContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  if (CONTAINER_TAGS[el.tagName]) return true;
  var role = el.getAttribute && el.getAttribute('role');
  if (role && CONTAINER_ROLES[role]) return true;
  return false;
}

function isVisible(el) {
  try {
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  } catch (_) { return true; }
}

function getDataAttributes(el) {
  var attrs = {};
  if (!el.attributes) return attrs;
  for (var i = 0; i < el.attributes.length; i++) {
    var a = el.attributes[i];
    if (a.name.indexOf('data-') === 0) attrs[a.name] = a.value;
  }
  return attrs;
}

function sanitizeText(text) {
  return (text || '')
    .trim()
    .substring(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

function findAssociatedLabel(el) {
  // Try explicit <label for="id">
  if (el.id) {
    try {
      var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return (label.textContent || '').trim().substring(0, 100);
    } catch (_) { }
  }
  // Try wrapping <label>
  var parent = el.parentElement;
  while (parent) {
    if (parent.tagName === 'LABEL') return (parent.textContent || '').trim().substring(0, 100);
    parent = parent.parentElement;
  }
  // Fall back to aria-label, placeholder, name
  return (el.getAttribute && el.getAttribute('aria-label'))
    || el.placeholder
    || el.name
    || null;
}

function buildInputInfoPayload(clientId, el) {
  var rect = { top: 0, left: 0, width: 0, height: 0 };
  try {
    var r = el.getBoundingClientRect();
    rect = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  } catch (_) { }

  var payload = {
    clientId: clientId,
    tagName: el.tagName || '',
    type: el.type || null,
    value: el.value || '',
    placeholder: el.placeholder || null,
    name: el.name || null,
    id: el.id || null,
    label: findAssociatedLabel(el),
    required: !!el.required,
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
    visible: isVisible(el),
    rect: rect,
    dataAttributes: getDataAttributes(el),
    ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
    parentClient: getParentClientId(el),
    url: location.href,
    timestamp: new Date().toISOString()
  };

  // Type-specific fields
  var inputType = (el.type || '').toLowerCase();
  if (inputType === 'checkbox' || inputType === 'radio') {
    payload.checked = !!el.checked;
  }
  if (el.tagName === 'SELECT') {
    var opts = [];
    try {
      for (var i = 0; i < el.options.length; i++) {
        opts.push({ value: el.options[i].value, text: el.options[i].text, selected: el.options[i].selected });
      }
    } catch (_) { }
    payload.options = opts;
  }

  return payload;
}

function setInputValue(el, value) {
  var tag = el.tagName;
  var inputType = (el.type || '').toLowerCase();

  if (inputType === 'checkbox' || inputType === 'radio') {
    el.checked = value === 'true' || value === true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (tag === 'SELECT') {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // Text inputs, textareas, contenteditable — use native setter for framework compatibility
  try {
    var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
  } catch (_) {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Hierarchy Helpers ────────────────────────────────────────────────────

function findNearestContainer(el) {
  var parent = el.parentElement;
  while (parent) {
    if (parent.__podbayClientId && isContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function getParentClientId(el) {
  var container = findNearestContainer(el);
  if (container && container.__podbayClientId) return container.__podbayClientId;
  return __config.parentClientId;
}

function registerChild(parentClientId, childClientId) {
  if (!__children[parentClientId]) __children[parentClientId] = [];
  if (__children[parentClientId].indexOf(childClientId) === -1) {
    __children[parentClientId].push(childClientId);
  }
}

function unregisterChild(parentClientId, childClientId) {
  if (!__children[parentClientId]) return;
  var idx = __children[parentClientId].indexOf(childClientId);
  if (idx !== -1) __children[parentClientId].splice(idx, 1);
}

function sanitizeContainerLabel(el) {
  // Use id, aria-label, or first meaningful text
  var label = el.id
    || (el.getAttribute && el.getAttribute('aria-label'))
    || (el.getAttribute && el.getAttribute('name'))
    || '';
  if (!label) {
    // Try first heading child
    try {
      var heading = el.querySelector('h1, h2, h3, h4, h5, h6, legend, caption');
      if (heading) label = (heading.textContent || '').trim();
    } catch (_) { }
  }
  return sanitizeText(label || el.tagName.toLowerCase());
}

// ── Container Client ─────────────────────────────────────────────────────

function buildContainerInfoPayload(clientId, el, parentId) {
  var rect = { top: 0, left: 0, width: 0, height: 0 };
  try {
    var r = el.getBoundingClientRect();
    rect = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  } catch (_) { }

  return {
    clientId: clientId,
    tagName: el.tagName || '',
    role: el.getAttribute ? (el.getAttribute('role') || null) : null,
    id: el.id || null,
    className: el.className || null,
    visible: isVisible(el),
    rect: rect,
    childCount: (__children[clientId] || []).length,
    dataAttributes: getDataAttributes(el),
    ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
    parentClient: parentId,
    url: location.href,
    timestamp: new Date().toISOString()
  };
}

function buildChildrenPayload(clientId) {
  var childIds = __children[clientId] || [];
  var children = [];
  for (var i = 0; i < childIds.length; i++) {
    var entry = __clients[childIds[i]];
    if (!entry) continue;
    var el = entry.element;
    var child = { clientId: childIds[i] };
    if (isContainer(el)) {
      child.type = 'container';
      child.tagName = el.tagName || '';
      child.label = sanitizeContainerLabel(el);
    } else if (isButton(el)) {
      child.type = 'button';
      child.text = (el.textContent || el.value || '').trim().substring(0, 100);
    } else if (isInput(el)) {
      child.type = 'input';
      child.label = findAssociatedLabel(el) || el.name || el.type || '';
      child.inputType = el.type || el.tagName.toLowerCase();
    }
    children.push(child);
  }
  return { clientId: clientId, children: children };
}

function createContainerClient(el) {
  if (el.__podbayClientId) return el.__podbayClientId;

  __counter++;
  var containerType = (el.tagName || 'unknown').toLowerCase();
  var label = sanitizeContainerLabel(el);
  var parentId = getParentClientId(el);
  var clientId = parentId + '-cmp-' + containerType + '-' + label + '-' + __counter;

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      var infoDesc = desc || ('Get information about this ' + containerType + ' container');
      ws.send(JSON.stringify({
        type: 'register',
        clientId: clientId,
        tools: [
          { name: 'info', description: infoDesc, inputSchema: { type: 'object', properties: {} } },
          { name: 'children', description: 'List all child component clients within this container', inputSchema: { type: 'object', properties: {} } }
        ],
        metadata: {
          clientId: clientId,
          type: 'container',
          containerType: containerType,
          parentClient: parentId,
          url: location.href,
          title: document.title || '',
          inferredDescription: desc || null
        }
      }));
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      if (msg.tool === 'info') {
        var info = buildContainerInfoPayload(clientId, el, parentId);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
      } else if (msg.tool === 'children') {
        var payload = buildChildrenPayload(clientId);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false
        }));
      }
    }
  };

  ws.onclose = function () {
    console.log(TAG, 'Disconnected:', clientId);
  };

  ws.onerror = function () { };

  el.__podbayClientId = clientId;
  __clients[clientId] = { ws: ws, element: el };
  __children[clientId] = [];
  registerChild(parentId, clientId);
  return clientId;
}

function removeContainerClient(el) {
  var id = el.__podbayClientId;
  if (!id || !__clients[id]) return;
  // Unregister from parent
  var parentId = getParentClientId(el);
  unregisterChild(parentId, id);
  // Close WebSocket
  try { __clients[id].ws.close(); } catch (_) { }
  delete __clients[id];
  delete __children[id];
  delete el.__podbayClientId;
  console.log(TAG, 'Removed container:', id);
}

// ── Button Info Payload (buttons use existing buildInfoPayload) ──────────

function buildInfoPayload(clientId, el) {
  var rect = { top: 0, left: 0, width: 0, height: 0 };
  try {
    var r = el.getBoundingClientRect();
    rect = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  } catch (_) { }

  return {
    clientId: clientId,
    tagName: el.tagName || '',
    type: el.type || null,
    text: (el.textContent || '').trim().substring(0, 200),
    id: el.id || null,
    className: el.className || null,
    name: el.name || null,
    disabled: !!el.disabled,
    visible: isVisible(el),
    rect: rect,
    dataAttributes: getDataAttributes(el),
    ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
    title: el.title || null,
    parentClient: getParentClientId(el),
    url: location.href,
    timestamp: new Date().toISOString()
  };
}

// ── Per-Button Client ────────────────────────────────────────────────────

function createButtonClient(el) {
  if (el.__podbayClientId) return el.__podbayClientId;

  __counter++;
  var btnText = sanitizeText(el.textContent || el.value || '');
  var parentId = getParentClientId(el);
  var clientId = parentId + '-btn-' + btnText + '-' + __counter;

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      var clickDesc = desc || ('Click the ' + (el.textContent || el.value || 'button').trim().substring(0, 40) + ' button');
      ws.send(JSON.stringify({
        type: 'register',
        clientId: clientId,
        tools: [
          { name: 'info', description: 'Get information about this button element', inputSchema: { type: 'object', properties: {} } },
          { name: 'click', description: clickDesc, inputSchema: { type: 'object', properties: {} } }
        ],
        metadata: {
          clientId: clientId,
          type: 'button',
          parentClient: parentId,
          url: location.href,
          title: document.title || '',
          inferredDescription: desc || null
        }
      }));
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      if (msg.tool === 'info') {
        var info = buildInfoPayload(clientId, el);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
      } else if (msg.tool === 'click') {
        try {
          el.removeAttribute('disabled');
          el.classList.remove('v-btn--disabled', 'btn-disable');
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          var after = buildInfoPayload(clientId, el);
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: true, button: after }) }],
            isError: false
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
            isError: true
          }));
        }
      }
    }
  };

  ws.onclose = function () {
    console.log(TAG, 'Disconnected:', clientId);
  };

  ws.onerror = function () { };

  el.__podbayClientId = clientId;
  __clients[clientId] = { ws: ws, element: el };
  registerChild(parentId, clientId);
  return clientId;
}

function removeButtonClient(el) {
  var id = el.__podbayClientId;
  if (!id || !__clients[id]) return;
  var parentId = getParentClientId(el);
  unregisterChild(parentId, id);
  try { __clients[id].ws.close(); } catch (_) { }
  delete __clients[id];
  delete el.__podbayClientId;
  console.log(TAG, 'Removed:', id);
}

// ── Per-Input Client ─────────────────────────────────────────────────────

function createInputClient(el) {
  if (el.__podbayClientId) return el.__podbayClientId;

  __counter++;
  var labelText = sanitizeText(
    findAssociatedLabel(el) || el.name || el.type || ''
  );
  var parentId = getParentClientId(el);
  var clientId = parentId + '-inp-' + labelText + '-' + __counter;

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      var inputDesc = desc || ('Set the value of this ' + (el.type || el.tagName.toLowerCase()) + ' field');
      ws.send(JSON.stringify({
        type: 'register',
        clientId: clientId,
        tools: [
          { name: 'info', description: 'Get information about this input field', inputSchema: { type: 'object', properties: {} } },
          { name: 'input', description: inputDesc, inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'The value to set' } }, required: ['value'] } }
        ],
        metadata: {
          clientId: clientId,
          type: 'input',
          inputType: el.type || el.tagName.toLowerCase(),
          parentClient: parentId,
          url: location.href,
          title: document.title || '',
          inferredDescription: desc || null
        }
      }));
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      if (msg.tool === 'info') {
        var info = buildInputInfoPayload(clientId, el);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
      } else if (msg.tool === 'input') {
        try {
          var args = msg.arguments || {};
          setInputValue(el, args.value);
          var after = buildInputInfoPayload(clientId, el);
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: true, newValue: after.value, field: after }) }],
            isError: false
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
            isError: true
          }));
        }
      }
    }
  };

  ws.onclose = function () {
    console.log(TAG, 'Disconnected:', clientId);
  };

  ws.onerror = function () { };

  el.__podbayClientId = clientId;
  __clients[clientId] = { ws: ws, element: el };
  registerChild(parentId, clientId);
  return clientId;
}

function removeInputClient(el) {
  var id = el.__podbayClientId;
  if (!id || !__clients[id]) return;
  var parentId = getParentClientId(el);
  unregisterChild(parentId, id);
  try { __clients[id].ws.close(); } catch (_) { }
  delete __clients[id];
  delete el.__podbayClientId;
  console.log(TAG, 'Removed:', id);
}

// ── DOM Scanning ─────────────────────────────────────────────────────────

var INPUT_SELECTOR = 'input:not([type="button"]):not([type="submit"]):not([type="hidden"]), textarea, select, [contenteditable="true"]';
var BUTTON_SELECTOR = 'button, input[type="button"], input[type="submit"], [role="button"]';
var CONTAINER_SELECTOR = 'form, nav, section, article, aside, dialog, main, header, footer, [role="dialog"], [role="navigation"], [role="form"], [role="region"], [role="banner"], [role="complementary"], [role="contentinfo"], [role="search"]';

function scanForContainers(root) {
  var container = root || document;
  try {
    var containers = container.querySelectorAll(CONTAINER_SELECTOR);
    for (var i = 0; i < containers.length; i++) {
      if (!containers[i].__podbayClientId && isContainer(containers[i])) {
        createContainerClient(containers[i]);
      }
    }
  } catch (_) { }
}
function scanForButtons(root) {
  var container = root || document;
  try {
    var buttons = container.querySelectorAll(BUTTON_SELECTOR);
    for (var i = 0; i < buttons.length; i++) {
      if (!buttons[i].__podbayClientId) {
        createButtonClient(buttons[i]);
      }
    }
  } catch (_) { }
}

function scanForInputs(root) {
  var container = root || document;
  try {
    var inputs = container.querySelectorAll(INPUT_SELECTOR);
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].__podbayClientId) {
        createInputClient(inputs[i]);
      }
    }
  } catch (_) { }
}

// ── MutationObserver ─────────────────────────────────────────────────────

function startObserver() {
  if (__observer) return;
  var target = document.body || document.documentElement;
  if (!target) return;

  __observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];

      // Check added nodes — containers FIRST, then elements
      if (m.addedNodes) {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var added = m.addedNodes[j];
          if (added.nodeType !== 1) continue;
          if (!added.__podbayClientId) {
            if (isContainer(added)) createContainerClient(added);
            else if (isButton(added)) createButtonClient(added);
            else if (isInput(added)) createInputClient(added);
          }
          // Scan subtree: containers first for proper parenting
          scanForContainers(added);
          scanForButtons(added);
          scanForInputs(added);
        }
      }

      // Check removed nodes — clean up elements first, then containers
      if (m.removedNodes) {
        for (var k = 0; k < m.removedNodes.length; k++) {
          var removed = m.removedNodes[k];
          if (removed.nodeType !== 1) continue;
          // Clean up child elements first (buttons, inputs)
          try {
            var childBtns = removed.querySelectorAll(BUTTON_SELECTOR);
            for (var l = 0; l < childBtns.length; l++) {
              if (childBtns[l].__podbayClientId) removeButtonClient(childBtns[l]);
            }
            var childInputs = removed.querySelectorAll(INPUT_SELECTOR);
            for (var n = 0; n < childInputs.length; n++) {
              if (childInputs[n].__podbayClientId) removeInputClient(childInputs[n]);
            }
            // Clean up child containers
            var childContainers = removed.querySelectorAll(CONTAINER_SELECTOR);
            for (var p = 0; p < childContainers.length; p++) {
              if (childContainers[p].__podbayClientId) removeContainerClient(childContainers[p]);
            }
          } catch (_) { }
          // Clean up the removed node itself
          if (removed.__podbayClientId) {
            if (isContainer(removed)) removeContainerClient(removed);
            else if (isButton(removed)) removeButtonClient(removed);
            else if (isInput(removed)) removeInputClient(removed);
          }
        }
      }
    }
  });

  __observer.observe(target, { childList: true, subtree: true });
  console.log(TAG, 'MutationObserver started');
}

// ── Public API ───────────────────────────────────────────────────────────

function init(config) {
  __config = config;
  console.log(TAG, 'Initializing element clients for', config.parentClientId);
  if (config.ollamaUrl) {
    __inferenceClient = require('inference-client');
    __inferenceClient.init({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel || 'qwen2.5:3b' });
  }

  // Initial scan — containers FIRST for proper parent hierarchy
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scanForContainers();
    scanForButtons();
    scanForInputs();
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      scanForContainers();
      scanForButtons();
      scanForInputs();
      startObserver();
    });
  }

  // Expose for debugging
  window.__podbayElementClients = __clients;
  window.__podbayElementChildren = __children;
}

function getClients() { return __clients; }

function getCount() { return Object.keys(__clients).length; }

function getChildren() { return __children; }

module.exports = {
  init: init,
  getClients: getClients,
  getCount: getCount,
  getChildren: getChildren,
  scanForContainers: scanForContainers,
  scanForButtons: scanForButtons,
  scanForInputs: scanForInputs
};
