/**
 * PodBay Broker Client SDK
 *
 * A reusable reverse client class for browser-injected plugins.
 * Installs window.PodBayBrokerClient — plugins use it to publish
 * tools and send notifications to the MCP broker.
 *
 * Usage (in a subsequent plugin):
 *   var client = new window.PodBayBrokerClient({
 *     clientId: 'my-plugin',
 *     tools: [
 *       { name: 'my_tool', description: '...', inputSchema: {...}, handler: function(args) { return {...}; } }
 *     ],
 *     metadata: { product: 'my-app' }
 *   });
 *   client.connect();
 *   client.notify({ type: 'status', message: 'ready' });
 */
; (function () {
  'use strict';
  if (window.PodBayBrokerClient) return;

  var BROKER_URL = 'ws://localhost:3099';
  var RECONNECT_MIN = 3000;
  var RECONNECT_MAX = 30000;

  // ── Instance registry ──────────────────────────────────────────────
  // Keyed by clientId so re-construction adds tools rather than replacing.
  var _instances = {};

  // ── Telemetry ───────────────────────────────────────────────────────
  // Maintains window.PodBayBrokerTelemetry — a live, discovery-driven
  // snapshot of all instances plus a bounded event history log.
  // Purely additive — no existing behaviour is altered.
  var MAX_HISTORY = 200;
  var _history = [];

  // Opt in to the shared PodBay telemetry bus if it is available on the page.
  // The bus is optional — broker-client works identically with or without it.
  var _BUS_NS = 'broker-client';
  if (window.PodBayTelemetry) {
    window.PodBayTelemetry.attach(_BUS_NS, {
      version: '1.0',
      description: 'PodBay reverse WebSocket client — lifecycle + tool events',
      events: {
        constructed: { color: 'info' },
        reused: { color: 'info' },
        connected: { color: 'success' },
        disconnected: { color: 'danger' },
        registered: { color: 'success' },
        server_ack: { color: 'success' },
        reconnect_scheduled: { color: 'warning' },
        tool_called: { color: 'warning' },
        tool_result: { color: 'info' },
        tool_upserted: { color: 'info' }
      }
    });
  }

  function _record(clientId, event, detail) {
    _history.push({ ts: Date.now(), clientId: clientId, event: event, detail: detail || {} });
    if (_history.length > MAX_HISTORY) _history.shift();
    // Dual-publish to shared bus (additive — no-op if bus is absent)
    window.PodBayTelemetry && window.PodBayTelemetry.record(_BUS_NS, clientId, event, detail);
    _publishTelemetry();
  }

  function _publishTelemetry() {
    var snap = {};
    for (var _id in _instances) {
      var _c = _instances[_id];
      snap[_id] = {
        clientId: _c.clientId,
        connected: _c._connected,
        registered: _c._registered,
        tools: _c._toolSchemas.map(function (s) { return s.name; }),
        metadata: _c.metadata,
        reconnectDelay: _c._delay
      };
    }
    window.PodBayBrokerTelemetry = {
      instances: snap,
      history: _history.slice(),
      snapshot: function () { return JSON.parse(JSON.stringify({ instances: snap, history: _history.slice() })); },
      clearHistory: function () { _history.length = 0; _publishTelemetry(); },
      disconnect: function (clientId) { if (_instances[clientId]) _instances[clientId].disconnect(); },
      reconnect: function (clientId) { if (_instances[clientId]) _instances[clientId].connect(); },
      // Alias to the shared bus namespace — available when bus.js is loaded before broker-client.js
      bus: window.PodBayTelemetry ? window.PodBayTelemetry.namespaces[_BUS_NS] : null
    };
  }

  /**
   * @param {object} config
   * @param {string} config.clientId   — unique broker client ID
   * @param {Array}  config.tools      — tool definitions with handler functions
   * @param {object} [config.metadata] — optional metadata sent on registration
   * @param {string} [config.brokerUrl] — override broker WebSocket URL
   */
  function PodBayBrokerClient(config) {
    if (!config || !config.clientId) throw new Error('PodBayBrokerClient: clientId is required');

    // If a client for this clientId already exists, upsert its tools and return it.
    // Existing tools with the same name are replaced; all others are left untouched.
    // (Returning an object from a constructor overrides the `new` result.)
    if (_instances[config.clientId]) {
      var existing = _instances[config.clientId];
      var newTools = config.tools || [];
      var upsertedNames = [];
      for (var j = 0; j < newTools.length; j++) {
        existing.upsertTool(newTools[j]);
        upsertedNames.push(newTools[j].name);
      }
      _record(config.clientId, 'reused', { upserted: upsertedNames });
      return existing;
    }

    this.clientId = config.clientId;
    this.brokerUrl = config.brokerUrl || BROKER_URL;
    this.metadata = config.metadata || {};

    // Separate tool schemas (for registration) from handlers (for dispatch)
    this._handlers = {};
    this._toolSchemas = [];
    var toolDefs = config.tools || [];
    for (var i = 0; i < toolDefs.length; i++) {
      var t = toolDefs[i];
      this._handlers[t.name] = t.handler;
      this._toolSchemas.push({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} }
      });
    }

    this._ws = null;
    this._delay = RECONNECT_MIN;
    this._reconnectTimer = null;
    this._connected = false;
    this._registered = false;

    _instances[this.clientId] = this;
    _record(this.clientId, 'constructed', { tools: this._toolSchemas.map(function (s) { return s.name; }) });
  }

  // ── Connection ──────────────────────────────────────────────────────

  PodBayBrokerClient.prototype.connect = function () {
    if (this._connected) return; // already connected — don't tear down a live socket

    var self = this;

    // Detach stale handlers before closing the old socket so its async onclose
    // cannot set self._ws = null and silently kill the new connection we're about
    // to create.
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      try { this._ws.close(); } catch (_) { }
      this._ws = null;
    }

    try {
      this._ws = new WebSocket(this.brokerUrl);
    } catch (_) {
      this._schedule();
      return;
    }

    this._ws.onopen = function () {
      self._delay = RECONNECT_MIN;
      self._connected = true;
      _record(self.clientId, 'connected', {});
      self._register();
    };

    this._ws.onmessage = function (e) {
      self._onMessage(e);
    };

    this._ws.onclose = function () {
      self._connected = false;
      self._registered = false;
      self._ws = null;
      _record(self.clientId, 'disconnected', { reconnecting: true });
      self._schedule();
    };

    this._ws.onerror = function () { };
  };

  PodBayBrokerClient.prototype.disconnect = function () {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (_) { }
      this._ws = null;
    }
    this._connected = false;
    this._registered = false; delete _instances[this.clientId];
    _record(this.clientId, 'disconnected', { reconnecting: false });
    _publishTelemetry();
  };

  // ── Registration ────────────────────────────────────────────────────

  PodBayBrokerClient.prototype._register = function () {
    _record(this.clientId, 'registered', { toolCount: this._toolSchemas.length });
    this._send({
      type: 'register',
      clientId: this.clientId,
      tools: this._toolSchemas,
      metadata: this.metadata
    });
  };

  // ── Tool management ─────────────────────────────────────────────────

  /**
   * Upsert a tool: replace the schema+handler if a tool with the same name already
   * exists, otherwise append it. If already connected, re-registers after the change.
   */
  PodBayBrokerClient.prototype.upsertTool = function (toolDef) {
    var schema = {
      name: toolDef.name,
      description: toolDef.description || '',
      inputSchema: toolDef.inputSchema || { type: 'object', properties: {} }
    };
    this._handlers[toolDef.name] = toolDef.handler;
    var idx = -1;
    for (var i = 0; i < this._toolSchemas.length; i++) {
      if (this._toolSchemas[i].name === toolDef.name) { idx = i; break; }
    }
    if (idx >= 0) {
      this._toolSchemas[idx] = schema;   // replace in-place
      _record(this.clientId, 'tool_upserted', { name: toolDef.name, replaced: true });
    } else {
      this._toolSchemas.push(schema);    // new tool — append
      _record(this.clientId, 'tool_upserted', { name: toolDef.name, replaced: false });
    }
    if (this._connected) this._register();
  };

  /**
   * Alias: addTool delegates to upsertTool for backward compatibility.
   */
  PodBayBrokerClient.prototype.addTool = function (toolDef) {
    this.upsertTool(toolDef);
  };

  // ── Notifications ───────────────────────────────────────────────────

  /**
   * Send a notification to the broker.
   */
  PodBayBrokerClient.prototype.notify = function (data) {
    this._send({ type: 'notification', data: data });
  };

  // ── Internals ───────────────────────────────────────────────────────

  PodBayBrokerClient.prototype._send = function (data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify(data));
    }
  };

  PodBayBrokerClient.prototype._schedule = function () {
    if (this._reconnectTimer) return;
    var self = this;
    var wait = Math.min(this._delay + Math.random() * 1000, RECONNECT_MAX);
    _record(this.clientId, 'reconnect_scheduled', { delayMs: Math.round(wait) });
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self.connect();
    }, wait);
    this._delay = Math.min(this._delay * 1.5, RECONNECT_MAX);
  };

  PodBayBrokerClient.prototype._onMessage = function (e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }

    if (msg.type === 'registered') {
      this._registered = true;
      _record(this.clientId, 'server_ack', {});
      return;
    }

    if (msg.type === 'tool_call') {
      var handler = this._handlers[msg.tool];
      var callStart = Date.now();
      _record(this.clientId, 'tool_called', { tool: msg.tool, callId: msg.callId });
      var result;
      try {
        result = handler
          ? handler(msg.arguments || {})
          : { error: 'Unknown tool: ' + msg.tool };
      } catch (err) {
        result = { error: err.message };
      }

      // Support async handlers (Promises)
      var self = this;
      if (result && typeof result.then === 'function') {
        result.then(function (r) {
          _record(self.clientId, 'tool_result', { tool: msg.tool, callId: msg.callId, isError: false, durationMs: Date.now() - callStart });
          self._sendResult(msg.callId, r, false);
        })['catch'](function (err) {
          _record(self.clientId, 'tool_result', { tool: msg.tool, callId: msg.callId, isError: true, durationMs: Date.now() - callStart });
          self._sendResult(msg.callId, { error: err.message }, true);
        });
      } else {
        _record(this.clientId, 'tool_result', { tool: msg.tool, callId: msg.callId, isError: !!result.error, durationMs: Date.now() - callStart });
        this._sendResult(msg.callId, result, !!result.error);
      }
    }
  };

  PodBayBrokerClient.prototype._sendResult = function (callId, result, isError) {
    this._send({
      type: 'tool_result',
      callId: callId,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: isError
    });
  };

  // ── Status ──────────────────────────────────────────────────────────

  PodBayBrokerClient.prototype.isConnected = function () {
    return this._connected;
  };

  PodBayBrokerClient.prototype.isRegistered = function () {
    return this._registered;
  };

  // ── Install on window ──────────────────────────────────────────────

  window.PodBayBrokerClient = PodBayBrokerClient;
})();
