/**
 * PodBay Bridge Plugin
 *
 * Reusable broker bridge factory. Handles IIFE guard, broker client creation,
 * tool registration, notifications, and value formatting.
 *
 * Usage (from a consumer plugin):
 *   var bridge = window.PodBayBridge('my-client-id');
 *   bridge.addTool('greet', function (args) { return 'hi ' + args.name; },
 *                  'Greet someone', { name: { type: 'string' } });
 *   bridge.connect();
 *
 * Requires: window.PodBayBrokerClient (from broker-client-sdk plugin)
 */
;(function () {
  'use strict';

  if (window.PodBayBridge) return;

  // ── Value formatting ───────────────────────────────────────────────

  function fmt(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }

  // ── Bridge factory ─────────────────────────────────────────────────

  var bridges = {};

  function PodBayBridge(clientId) {
    if (bridges[clientId]) return bridges[clientId];

    var tools = [];

    var bridge = {
      clientId: clientId,
      client: null,
      fmt: fmt,

      /** Register a tool before calling connect().
       *  @param {string} name
       *  @param {function} handler - receives (args) → return value
       *  @param {string} [description]
       *  @param {object} [properties] - simple {key: {type,description}} map (auto-wrapped in JSON Schema)
       *  @param {string[]} [required] - required property names
       */
      addTool: function (name, handler, description, properties, required) {
        var schema = { type: 'object', properties: properties || {} };
        if (required) schema.required = required;
        var toolDef = { name: name, description: description || name, inputSchema: schema, handler: handler };
        tools.push(toolDef);
        // If already connected, register the new tool immediately (triggers update_tools)
        if (bridge.client) bridge.client.addTool(toolDef);
      },

      /** Open the broker connection. Call after all addTool() calls. */
      connect: function () {
        bridge.client = new window.PodBayBrokerClient({ clientId: clientId, tools: tools });
        bridge.client.connect();
      },

      /** Send a notification through the broker. */
      notify: function (data) {
        if (bridge.client) bridge.client.notify(data);
      },

      /** Disconnect from the broker. */
      disconnect: function () {
        if (bridge.client) bridge.client.disconnect();
      }
    };

    bridges[clientId] = bridge;
    return bridge;
  }

  window.PodBayBridge = PodBayBridge;
})();
