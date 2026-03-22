/**
 * PodBay Bridge Plugin
 *
 * Reusable broker bridge factory. Handles broker client creation,
 * tool registration, notifications, and value formatting.
 *
 * Usage:
 *   var bridge = require('bridge');
 *   var b = bridge('my-client-id');
 *   b.addTool('greet', function (args) { return 'hi ' + args.name; },
 *             'Greet someone', { name: { type: 'string' } });
 *   b.connect();
 *
 * Requires: broker-client-sdk
 */
'use strict';

var BrokerClient = require('broker-client-sdk');

function fmt(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

var bridges = {};

function PodBayBridge(clientId) {
  if (bridges[clientId]) return bridges[clientId];

  var tools = [];

  var bridge = {
    clientId: clientId,
    client: null,
    fmt: fmt,

    addTool: function (name, handler, description, properties, required) {
      var schema = { type: 'object', properties: properties || {} };
      if (required) schema.required = required;
      var toolDef = { name: name, description: description || name, inputSchema: schema, handler: handler };
      tools.push(toolDef);
      if (bridge.client) bridge.client.addTool(toolDef);
    },

    connect: function () {
      bridge.client = new BrokerClient({ clientId: clientId, tools: tools });
      bridge.client.connect();
    },

    notify: function (data) {
      if (bridge.client) bridge.client.notify(data);
    },

    disconnect: function () {
      if (bridge.client) bridge.client.disconnect();
    }
  };

  bridges[clientId] = bridge;
  return bridge;
}

// Also install on window for backward compat
window.PodBayBridge = PodBayBridge;

module.exports = PodBayBridge;
