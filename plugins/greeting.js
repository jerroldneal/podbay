/**
 * Greeting Plugin
 *
 * Demonstrates the PodBay pattern: this plugin exports functions
 * via module.exports. Other plugins can require('greeting') to
 * use them — no id field needed in the pod spec.
 */
'use strict';

var TAG = '[Greeting]';

function greet(name) {
  return 'Hello, ' + (name || 'World') + '! Welcome to PodBay.';
}

function farewell(name) {
  return 'Goodbye, ' + (name || 'World') + '!';
}

console.log(TAG, 'Plugin loaded — greeting and farewell available via require("greeting")');

module.exports = {
  greet: greet,
  farewell: farewell
};
