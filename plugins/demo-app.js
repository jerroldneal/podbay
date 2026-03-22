/**
 * Demo App Plugin — Uses require() + publishes tools to the broker
 *
 * This plugin demonstrates the PodBay's key features:
 * 1. Requiring other plugins by type name (greeting, math-helper)
 * 2. Using broker-client-sdk to publish tools back to the MCP broker
 *
 * Tools registered:
 *   demo-app__greet     — Generate a greeting message
 *   demo-app__calculate — Perform math operations (add, multiply, factorial)
 *   demo-app__status    — Report plugin status and loaded modules
 */
'use strict';

var TAG = '[DemoApp]';

// ── Require other plugins by type name — just works! ──
var greeting = require('greeting');
var math = require('math-helper');
var BrokerClient = require('broker-client-sdk');

// Use the greeting module
console.log(TAG, greeting.greet('PodBay User'));

// Use the math module
console.log(TAG, '5! =', math.factorial(5));
console.log(TAG, '3 + 4 =', math.add(3, 4));
console.log(TAG, '6 × 7 =', math.multiply(6, 7));

// ── Register tools with the broker ──
var client = new BrokerClient({
  clientId: 'demo-app',
  metadata: { description: 'PodBay demo — inter-plugin require + tool publishing' },
  tools: [
    {
      name: 'greet',
      description: 'Generate a greeting message for a given name',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet (default: World)' }
        }
      },
      handler: function (args) {
        return { message: greeting.greet(args.name) };
      }
    },
    {
      name: 'calculate',
      description: 'Perform a math operation: add, multiply, or factorial',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'Operation: add, multiply, or factorial' },
          a: { type: 'number', description: 'First operand (or n for factorial)' },
          b: { type: 'number', description: 'Second operand (for add/multiply)' }
        },
        required: ['operation', 'a']
      },
      handler: function (args) {
        var op = args.operation;
        if (op === 'add') return { result: math.add(args.a, args.b || 0) };
        if (op === 'multiply') return { result: math.multiply(args.a, args.b || 1) };
        if (op === 'factorial') return { result: math.factorial(args.a) };
        return { error: 'Unknown operation: ' + op + '. Use add, multiply, or factorial.' };
      }
    },
    {
      name: 'status',
      description: 'Report demo-app plugin status and loaded modules',
      inputSchema: { type: 'object', properties: {} },
      handler: function () {
        return {
          plugin: 'demo-app',
          modules: ['greeting', 'math-helper', 'broker-client-sdk'],
          greetingSample: greeting.greet('Test'),
          mathSample: { factorial5: math.factorial(5), sum: math.add(10, 20) },
          brokerConnected: client._connected,
          brokerRegistered: client._registered
        };
      }
    }
  ]
});

client.connect();
console.log(TAG, 'Demo app initialized — tools published to broker as demo-app');

// Expose our own API for further composition
module.exports = {
  name: 'demo-app',
  greeting: greeting,
  math: math,
  client: client,
  run: function () {
    return {
      message: greeting.greet('PodBay'),
      computation: math.factorial(10)
    };
  }
};
