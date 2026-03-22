'use strict';

var greeting = require('greeting');
var math = require('math-helper');
var BrokerClient = require('broker-client-sdk');

var client = new BrokerClient({
  clientId: 'clubwpt-desktop-test',
  tools: [
    {
      name: 'run',
      description: 'Run the plugin test — calls greeting.greet and math.add/factorial',
      inputSchema: { type: 'object', properties: {} },
      handler: function () {
        return {
          greet: greeting.greet('PodBay'),
          add: math.add(2, 3),
          factorial: math.factorial(5)
        };
      }
    },
    {
      name: 'greet',
      description: 'Generate a greeting',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to greet' } }
      },
      handler: function (args) {
        return { message: greeting.greet(args.name) };
      }
    },
    {
      name: 'calculate',
      description: 'Math operation: add, multiply, or factorial',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'add, multiply, or factorial' },
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand (for add/multiply)' }
        },
        required: ['operation', 'a']
      },
      handler: function (args) {
        if (args.operation === 'add') return { result: math.add(args.a, args.b || 0) };
        if (args.operation === 'multiply') return { result: math.multiply(args.a, args.b || 1) };
        if (args.operation === 'factorial') return { result: math.factorial(args.a) };
        return { error: 'Unknown operation: ' + args.operation };
      }
    }
  ]
});

client.connect();
console.log('[Test] registered run/greet/calculate tools on clubwpt-desktop-test');

module.exports = { greeting: greeting, math: math, client: client };
