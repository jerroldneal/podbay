/**
 * Math Helper Plugin
 *
 * A utility module that other plugins can require('math-helper')
 * to use. Demonstrates inter-plugin require without id fields.
 */
'use strict';

var TAG = '[MathHelper]';

function add(a, b) { return a + b; }
function multiply(a, b) { return a * b; }
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

console.log(TAG, 'Plugin loaded — math utilities available via require("math-helper")');

module.exports = {
  add: add,
  multiply: multiply,
  factorial: factorial
};
