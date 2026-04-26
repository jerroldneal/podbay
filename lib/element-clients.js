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
var __inferenceClient = null;  // set in init() — routes inference through broker call_tool protocol
var __elementLog = null;       // set in init() — element-log module reference
var __frameTransport = null;   // set in init() — frame's registered broker transport for inference

function _log(clientId, type, event, data) {
  if (__elementLog) __elementLog.record(clientId, type, event, data);
}

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

// ── Inference Retry Helper ──────────────────────────────────────────────
//
// When initial inference returns null (service not ready), schedule a retry.
// On successful retry, update the tooltip.

function scheduleInferenceRetry(clientId, elementType) {
  console.log(TAG, '[RETRY FUNC ENTERED]', clientId, elementType);
  var RETRY_DELAY = 2000;  // 2 seconds
  console.log(TAG, '[RETRY SCHEDULED]', clientId, elementType, '- will retry in', RETRY_DELAY, 'ms');

  setTimeout(function () {
    console.log(TAG, '[RETRY EXECUTING]', clientId, '- checking guards...');

    var client = __clients[clientId];
    if (!client) {
      console.warn(TAG, '[RETRY FAILED] Client not found:', clientId);
      return;
    }
    if (!client.ws) {
      console.warn(TAG, '[RETRY FAILED] WebSocket missing for:', clientId);
      return;
    }
    if (!client.element) {
      console.warn(TAG, '[RETRY FAILED] Element missing for:', clientId);
      return;
    }
    if (!__inferenceClient) {
      console.warn(TAG, '[RETRY FAILED] Inference client not available for:', clientId);
      return;
    }

    console.log(TAG, '[RETRY CALLING] Inference for:', clientId);
    _log(clientId, elementType, 'inference_retry', {});

    var retryWs = __frameTransport ? __frameTransport.ws() : client.ws;
    var retryPromise = __inferenceClient.inferElement(client.element, retryWs);
    retryPromise.then(function (desc) {
      if (desc) {
        client.element.setAttribute('title', desc);
        _log(clientId, elementType, 'inference_retry_success', { description: desc });
        console.log(TAG, '[RETRY SUCCESS]', clientId, ':', desc.substring(0, 60));
      } else {
        _log(clientId, elementType, 'inference_retry_failed', {});
        console.log(TAG, '[RETRY NULL]', clientId, '- inference returned null');
      }
    }).catch(function (err) {
      console.error(TAG, '[RETRY ERROR]', clientId, '- promise rejected:', err);
      _log(clientId, elementType, 'inference_retry_error', { error: String(err) });
    });
  }, RETRY_DELAY);
}

function createContainerClient(el) {
  if (el.__podbayClientId) return el.__podbayClientId;

  __counter++;
  var containerType = (el.tagName || 'unknown').toLowerCase();
  var label = sanitizeContainerLabel(el);
  var parentId = getParentClientId(el);
  var clientId = parentId + '-cmp-' + containerType + '-' + label + '-' + __counter;

  _log(clientId, 'container', 'discovered', { parentClientId: parentId, tag: containerType, url: location.href });

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    _log(clientId, 'container', 'inference_start', { configured: !!__inferenceClient });
    var inferWs = __frameTransport ? __frameTransport.ws() : null;
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el, inferWs) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      _log(clientId, 'container', 'inference_complete', { configured: !!__inferenceClient, description: desc });
      // Set tooltip for visual verification
      if (desc) {
        el.setAttribute('title', desc);
      } else {
        el.setAttribute('title', '(inference not available)');
        console.log(TAG, '[BEFORE RETRY SCHEDULE]', 'Inference returned null for container', clientId);
        scheduleInferenceRetry(clientId, 'container');  // Retry after delay
      }
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
      _log(clientId, 'container', 'registered', { parentClientId: parentId, inferredDescription: desc || null });
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      _log(clientId, 'container', 'tool_called', { tool: msg.tool, callId: msg.callId });
      if (msg.tool === 'info') {
        var info = buildContainerInfoPayload(clientId, el, parentId);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
        _log(clientId, 'container', 'tool_result', { tool: 'info', callId: msg.callId, success: true });
      } else if (msg.tool === 'children') {
        var payload = buildChildrenPayload(clientId);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false
        }));
        _log(clientId, 'container', 'tool_result', { tool: 'children', callId: msg.callId, success: true });
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
  _log(id, 'container', 'removed', null);
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

  _log(clientId, 'button', 'discovered', { parentClientId: parentId, text: (el.textContent || el.value || '').trim().substring(0, 60), url: location.href });

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    _log(clientId, 'button', 'inference_start', { configured: !!__inferenceClient });
    var inferWs = __frameTransport ? __frameTransport.ws() : null;
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el, inferWs) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      _log(clientId, 'button', 'inference_complete', { configured: !!__inferenceClient, description: desc });
      // Set tooltip for visual verification
      if (desc) {
        el.setAttribute('title', desc);
      } else {
        el.setAttribute('title', '(inference not available)');
        console.log(TAG, '[BEFORE RETRY SCHEDULE]', 'Inference returned null for button', clientId);
        scheduleInferenceRetry(clientId, 'button');  // Retry after delay
      }
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
      _log(clientId, 'button', 'registered', { parentClientId: parentId, inferredDescription: desc || null });
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      _log(clientId, 'button', 'tool_called', { tool: msg.tool, callId: msg.callId, args: msg.arguments || null });
      if (msg.tool === 'info') {
        var info = buildInfoPayload(clientId, el);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
        _log(clientId, 'button', 'tool_result', { tool: msg.tool, callId: msg.callId, success: true });
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
          _log(clientId, 'button', 'tool_result', { tool: 'click', callId: msg.callId, success: true });
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
            isError: true
          }));
          _log(clientId, 'button', 'tool_result', { tool: 'click', callId: msg.callId, success: false, error: err.message });
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
  _log(id, 'button', 'removed', null);
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

  _log(clientId, 'input', 'discovered', { parentClientId: parentId, inputType: el.type || el.tagName.toLowerCase(), label: labelText, url: location.href });

  var ws;
  try { ws = new WebSocket(__config.broker); }
  catch (err) {
    console.log(TAG, 'WebSocket error for', clientId, err.message);
    return null;
  }

  ws.onopen = function () {
    console.log(TAG, 'Connected:', clientId);
    _log(clientId, 'input', 'inference_start', { configured: !!__inferenceClient });
    var inferWs = __frameTransport ? __frameTransport.ws() : null;
    var inferPromise = __inferenceClient ? __inferenceClient.inferElement(el, inferWs) : Promise.resolve(null);
    inferPromise.then(function (desc) {
      _log(clientId, 'input', 'inference_complete', { configured: !!__inferenceClient, description: desc });
      // Set tooltip for visual verification
      if (desc) {
        el.setAttribute('title', desc);
      } else {
        el.setAttribute('title', '(inference not available)');
        console.log(TAG, '[BEFORE RETRY SCHEDULE]', 'Inference returned null for input', clientId);
        scheduleInferenceRetry(clientId, 'input');  // Retry after delay
      }
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
      _log(clientId, 'input', 'registered', { parentClientId: parentId, inferredDescription: desc || null });
    });
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === 'tool_call') {
      if (msg.tool === 'info') {
        _log(clientId, 'input', 'tool_called', { tool: 'info', callId: msg.callId });
        var info = buildInputInfoPayload(clientId, el);
        ws.send(JSON.stringify({
          type: 'tool_result',
          callId: msg.callId,
          content: [{ type: 'text', text: JSON.stringify(info) }],
          isError: false
        }));
        _log(clientId, 'input', 'tool_result', { tool: 'info', callId: msg.callId, success: true });
      } else if (msg.tool === 'input') {
        _log(clientId, 'input', 'tool_called', { tool: 'input', callId: msg.callId, value: (msg.arguments || {}).value });
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
          _log(clientId, 'input', 'tool_result', { tool: 'input', callId: msg.callId, success: true });
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
            isError: true
          }));
          _log(clientId, 'input', 'tool_result', { tool: 'input', callId: msg.callId, success: false, error: err.message });
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
  _log(id, 'input', 'removed', null);
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

function handleInferenceResult(msg) {
  if (__inferenceClient) __inferenceClient.handleResult(msg);
}

function init(config) {
  __config = config;
  __frameTransport = config.frameTransport || null;
  __elementLog = require('element-log');
  console.log(TAG, 'Initializing element clients for', config.parentClientId);
  __inferenceClient = require('inference-client');
  __inferenceClient.init({
    model: config.ollamaModel || 'qwen2.5:3b',
    onError: function (msg) {
      if (__elementLog) __elementLog.record('inference-client', 'system', 'inference_error', { error: msg });
    }
  });

  // Initial scan — containers FIRST for proper parent hierarchy
  function runScan() {
    scanForContainers();
    scanForButtons();
    scanForInputs();
    startObserver();
    var count = Object.keys(__clients).length;
    console.log(TAG, 'Initial scan complete:', count, 'element clients registered');
    if (config.onDiscoveryComplete) config.onDiscoveryComplete(count);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    runScan();
  } else {
    document.addEventListener('DOMContentLoaded', runScan);
  }

  // Expose for debugging
  window.__podbayElementClients = __clients;
  window.__podbayElementChildren = __children;
}

function getClients() { return __clients; }

function getCount() { return Object.keys(__clients).length; }

function getChildren() { return __children; }

// ── Public API ───────────────────────────────────────────────────────

function getStats() {
  var total = 0;
  var inferred = 0;
  var pending = 0;
  var failed = 0;
  var breakdown = [];

  for (var clientId in __clients) {
    if (!__clients.hasOwnProperty(clientId)) continue;
    var client = __clients[clientId];
    if (!client || !client.element) continue;

    total++;
    var el = client.element;
    var title = el.getAttribute('title');
    var type = 'unknown';

    if (isContainer(el)) type = 'container';
    else if (isButton(el)) type = 'button';
    else if (isInput(el)) type = 'input';

    var hasInference = title && title !== '(inference not available)';
    var isPending = !title;
    var hasFailed = title === '(inference not available)';

    if (hasInference) inferred++;
    else if (isPending) pending++;
    else if (hasFailed) failed++;

    breakdown.push({
      clientId: clientId,
      type: type,
      inferred: hasInference,
      pending: isPending,
      failed: hasFailed
    });
  }

  return {
    total: total,
    inferred: inferred,
    pending: pending,
    failed: failed,
    breakdown: breakdown
  };
}

module.exports = {
  init: init,
  handleInferenceResult: handleInferenceResult,
  getClients: getClients,
  getCount: getCount,
  getChildren: getChildren,
  getLog: function () { return __elementLog; },
  scanForContainers: scanForContainers,
  scanForButtons: scanForButtons,
  scanForInputs: scanForInputs,
  getStats: getStats,
  scheduleInferenceRetry: scheduleInferenceRetry  // For manual testing via DevTools
};
