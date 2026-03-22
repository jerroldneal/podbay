/**
 * Broker Client SDK — Reusable reverse client class for browser-injected plugins.
 *
 * Installs window.PodBayBrokerClient — plugins use it to publish
 * tools and send notifications to the MCP broker.
 *
 * Also available as: require('broker-client-sdk')
 */
'use strict';

if (!window.PodBayBrokerClient) {

  var BROKER_URL = 'ws://localhost:3099';
  var RECONNECT_MIN = 3000;
  var RECONNECT_MAX = 30000;

  var _instances = {};

  function PodBayBrokerClient(config) {
    if (!config || !config.clientId) throw new Error('clientId is required');

    // Reuse existing instance if same clientId
    if (_instances[config.clientId]) {
      var existing = _instances[config.clientId];
      if (config.tools) {
        for (var i = 0; i < config.tools.length; i++) {
          var found = false;
          for (var j = 0; j < existing._tools.length; j++) {
            if (existing._tools[j].name === config.tools[i].name) {
              existing._tools[j] = config.tools[i];
              found = true;
              break;
            }
          }
          if (!found) existing._tools.push(config.tools[i]);
        }
      }
      return existing;
    }

    this.clientId = config.clientId;
    this.metadata = config.metadata || {};
    this._tools = config.tools || [];
    this._brokerUrl = config.brokerUrl || BROKER_URL;
    this._ws = null;
    this._delay = RECONNECT_MIN;
    this._timer = null;
    this._connected = false;
    this._registered = false;

    _instances[this.clientId] = this;
  }

  PodBayBrokerClient.prototype.connect = function () {
    var self = this;
    try { if (self._ws) self._ws.close(); } catch (_) { }

    try { self._ws = new WebSocket(self._brokerUrl); } catch (_) {
      self._scheduleReconnect();
      return;
    }

    self._ws.onopen = function () {
      self._delay = RECONNECT_MIN;
      self._connected = true;
      var toolSchemas = self._tools.map(function (t) {
        return { name: t.name, description: t.description, inputSchema: t.inputSchema };
      });
      self._ws.send(JSON.stringify({
        type: 'register',
        clientId: self.clientId,
        tools: toolSchemas,
        metadata: self.metadata
      }));
    };

    self._ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }

      if (msg.type === 'registered') {
        self._registered = true;
        return;
      }

      if (msg.type === 'tool_call') {
        var tool = null;
        for (var i = 0; i < self._tools.length; i++) {
          if (self._tools[i].name === msg.tool) { tool = self._tools[i]; break; }
        }
        if (!tool || !tool.handler) {
          self._ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: 'Unknown tool: ' + msg.tool }],
            isError: true
          }));
          return;
        }
        try {
          var result = tool.handler(msg.arguments || {});
          var text = typeof result === 'string' ? result : JSON.stringify(result);
          self._ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: text }]
          }));
        } catch (err) {
          self._ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
            isError: true
          }));
        }
      }
    };

    self._ws.onclose = function () {
      self._ws = null;
      self._connected = false;
      self._registered = false;
      self._scheduleReconnect();
    };

    self._ws.onerror = function () { };
  };

  PodBayBrokerClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (self._timer) return;
    self._timer = setTimeout(function () {
      self._timer = null;
      self.connect();
    }, Math.min(self._delay + Math.random() * 1000, RECONNECT_MAX));
    self._delay = Math.min(self._delay * 1.5, RECONNECT_MAX);
  };

  PodBayBrokerClient.prototype.disconnect = function () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._ws) { try { this._ws.close(); } catch (_) { } }
    this._connected = false;
    this._registered = false;
  };

  PodBayBrokerClient.prototype.notify = function (data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: 'notification', data: data }));
    }
  };

  window.PodBayBrokerClient = PodBayBrokerClient;
  console.log('[PodBay BrokerClient] SDK installed — window.PodBayBrokerClient available');

} // end guard

module.exports = window.PodBayBrokerClient;
