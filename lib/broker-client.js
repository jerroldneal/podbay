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
;(function () {
  'use strict';

  if (window.PodBayBrokerClient) return;

  var BROKER_URL = 'ws://localhost:3099';
  var RECONNECT_MIN = 3000;
  var RECONNECT_MAX = 30000;

  /**
   * @param {object} config
   * @param {string} config.clientId   — unique broker client ID
   * @param {Array}  config.tools      — tool definitions with handler functions
   * @param {object} [config.metadata] — optional metadata sent on registration
   * @param {string} [config.brokerUrl] — override broker WebSocket URL
   */
  function PodBayBrokerClient(config) {
    if (!config || !config.clientId) throw new Error('PodBayBrokerClient: clientId is required');

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
  }

  // ── Connection ──────────────────────────────────────────────────────

  PodBayBrokerClient.prototype.connect = function () {
    var self = this;
    try { if (this._ws) this._ws.close(); } catch (_) {}

    try {
      this._ws = new WebSocket(this.brokerUrl);
    } catch (_) {
      this._schedule();
      return;
    }

    this._ws.onopen = function () {
      self._delay = RECONNECT_MIN;
      self._connected = true;
      self._register();
    };

    this._ws.onmessage = function (e) {
      self._onMessage(e);
    };

    this._ws.onclose = function () {
      self._connected = false;
      self._registered = false;
      self._ws = null;
      self._schedule();
    };

    this._ws.onerror = function () {};
  };

  PodBayBrokerClient.prototype.disconnect = function () {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this._connected = false;
    this._registered = false;
  };

  // ── Registration ────────────────────────────────────────────────────

  PodBayBrokerClient.prototype._register = function () {
    this._send({
      type: 'register',
      clientId: this.clientId,
      tools: this._toolSchemas,
      metadata: this.metadata
    });
  };

  // ── Tool management ─────────────────────────────────────────────────

  /**
   * Add a tool after construction. If already connected, re-registers.
   */
  PodBayBrokerClient.prototype.addTool = function (toolDef) {
    this._handlers[toolDef.name] = toolDef.handler;
    this._toolSchemas.push({
      name: toolDef.name,
      description: toolDef.description || '',
      inputSchema: toolDef.inputSchema || { type: 'object', properties: {} }
    });
    if (this._connected) this._register();
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
      return;
    }

    if (msg.type === 'tool_call') {
      var handler = this._handlers[msg.tool];
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
          self._sendResult(msg.callId, r, false);
        })['catch'](function (err) {
          self._sendResult(msg.callId, { error: err.message }, true);
        });
      } else {
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
