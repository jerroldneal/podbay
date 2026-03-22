/**
 * ClubWPT Login Plugin
 *
 * Automates the ClubWPT login flow via broker execute tool:
 *   1. Discovers the login frame client from window.__podbayFrameClients
 *   2. Sends login JS to the frame via broker REST API (/api/call-tool)
 *   3. Login JS uses native value setter + full pointer/mouse events for Vue reactivity
 *
 * Also publishes a broker tool (clubwpt-login-svc__login) so other clients
 * can trigger login remotely.
 *
 * Usage:
 *   - Direct call: require('clubwpt/login').login()
 *   - Broker tool: call clubwpt-login-svc__login via broker
 *   - Auto-run on load: enabled by default (set AUTORUN_ON_LOAD = false to disable)
 */
'use strict';

var TAG = '[ClubWPT Login]';

var BROKER_API = 'http://localhost:3098/api/call-tool';
var FRAME_CLIENT_PREFIX = 'clubwpt-frame-login';
var SERVICE_CLIENT_ID = 'clubwpt-login-svc';
var PHONE_NUMBER = '8184450634';
var PHONE_INPUT_SELECTOR = '#input-0';
var PHONE_BUTTON_SELECTOR = '#app > div > div > main > div.w-screen.h-screen.d-flex.d-row.align-center.justify-center.cusLoginStyle > div > div.h-100.d-flex.flex-column.justify-space-between.bg-surfaceElevation1 > div:nth-child(2) > div > div.v-row.d-flex.justify-center.mt-10 > form > a > button';
var AUTORUN_ON_LOAD = true;

/**
 * Find the login frame client name from the parent's frame registry.
 * Prefers a client whose URL contains '/login', falls back to first match.
 */
function findFrameClient() {
  var registry = window.__podbayFrameClients;
  if (!registry) return null;
  for (var name in registry) {
    if (name.indexOf(FRAME_CLIENT_PREFIX) === 0 && registry[name].url && registry[name].url.indexOf('/login') !== -1) {
      return name;
    }
  }
  for (var name in registry) {
    if (name.indexOf(FRAME_CLIENT_PREFIX) === 0) return name;
  }
  return null;
}

/**
 * Call a broker tool via the REST API (/api/call-tool).
 */
function brokerCallTool(toolName, args) {
  return fetch(BROKER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, arguments: args || {} })
  }).then(function (resp) { return resp.json(); }).then(function (json) {
    if (json.error) throw new Error(json.error);
    return json;
  });
}

/**
 * Execute arbitrary JS in the login frame via broker execute tool.
 */
function executeInFrame(code) {
  var clientId = findFrameClient();
  if (!clientId) return Promise.reject(new Error('No frame client found with prefix: ' + FRAME_CLIENT_PREFIX));
  return brokerCallTool(clientId + '__execute', { code: code });
}

/**
 * Build the login JS that runs inside the frame.
 * Uses native HTMLInputElement.prototype.value setter for Vue reactivity
 * and full pointer/mouse event sequence for Vuetify button activation.
 */
function buildLoginCode(phone, inputSelector, buttonSelector) {
  return [
    'var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;',
    'function setInputValue(input, val) {',
    '  nativeSetter.call(input, val);',
    '  input.dispatchEvent(new Event("input", { bubbles: true }));',
    '  input.dispatchEvent(new Event("change", { bubbles: true }));',
    '}',
    'function fullClick(el) {',
    '  el.removeAttribute("disabled");',
    '  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));',
    '  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));',
    '  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));',
    '  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));',
    '  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));',
    '}',
    'var input = document.querySelector(' + JSON.stringify(inputSelector) + ');',
    'if (!input) { console.error("[ClubWPT Login] Input not found:", ' + JSON.stringify(inputSelector) + '); return; }',
    'setInputValue(input, "");',
    'input.focus();',
    'setInputValue(input, ' + JSON.stringify(phone) + ');',
    'setTimeout(function() {',
    '  var btn = document.querySelector(' + JSON.stringify(buttonSelector) + ');',
    '  if (!btn) { console.error("[ClubWPT Login] Button not found"); return; }',
    '  btn.classList.remove("v-btn--disabled", "btn-disable");',
    '  fullClick(btn);',
    '  console.log("[ClubWPT Login] Login complete — native setter + full event sequence");',
    '}, 500);'
  ].join('\n');
}

/**
 * Perform login automation via broker execute tool on the frame client.
 *
 * Discovers the frame client from window.__podbayFrameClients, then sends
 * the login JS to execute inside the frame via the broker REST API.
 */
function login(opts) {
  opts = opts || {};
  var phone = opts.phone || PHONE_NUMBER;
  var inputSelector = opts.inputSelector || PHONE_INPUT_SELECTOR;
  var buttonSelector = opts.buttonSelector || PHONE_BUTTON_SELECTOR;

  console.log(TAG, 'Starting login automation (broker execute)...');

  var clientId = findFrameClient();
  if (!clientId) {
    console.error(TAG, 'No frame client found with prefix:', FRAME_CLIENT_PREFIX);
    console.log(TAG, 'Frame registry:', JSON.stringify(window.__podbayFrameClients || {}));
    return Promise.resolve(false);
  }
  console.log(TAG, 'Using frame client:', clientId);

  var loginCode = buildLoginCode(phone, inputSelector, buttonSelector);
  return brokerCallTool(clientId + '__execute', { code: loginCode })
    .then(function (result) {
      console.log(TAG, 'Login executed via broker:', JSON.stringify(result));
      return true;
    })
    .catch(function (err) {
      console.error(TAG, 'Login failed:', err.message);
      return false;
    });
}

/**
 * Publish login as a callable broker tool via PodBayBrokerClient.
 * Tool name: clubwpt-login-svc__login
 */
function publishBrokerTool() {
  var BrokerClient = require('broker-client-sdk');
  var client = new BrokerClient({
    clientId: SERVICE_CLIENT_ID,
    tools: [
      {
        name: 'login',
        description: 'Trigger ClubWPT phone login automation in the login iframe',
        inputSchema: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Phone number', default: PHONE_NUMBER },
            inputSelector: { type: 'string', description: 'CSS selector for phone input', default: PHONE_INPUT_SELECTOR },
            buttonSelector: { type: 'string', description: 'CSS selector for submit button', default: PHONE_BUTTON_SELECTOR }
          }
        },
        handler: function (args) {
          login(args);
          return { triggered: true, phone: args.phone || PHONE_NUMBER };
        }
      }
    ],
    metadata: { type: 'service', parent: window.__podBay ? window.__podBay.clientId : 'unknown' }
  });
  client.connect();
  console.log(TAG, 'Published broker tool:', SERVICE_CLIENT_ID + '__login');
}

/**
 * Initialize plugin: publish broker tool and optionally auto-run login
 */
function init() {
  console.log(TAG, 'Plugin loaded');
  publishBrokerTool();
  if (AUTORUN_ON_LOAD) {
    console.log(TAG, 'Auto-running login in 1.5s...');
    setTimeout(function () {
      login();
    }, 1500);
  }
}

// Export the public API
module.exports = {
  login: login,
  executeInFrame: executeInFrame,
  findFrameClient: findFrameClient,
  publishBrokerTool: publishBrokerTool,
  PHONE_NUMBER: PHONE_NUMBER,
  AUTORUN_ON_LOAD: AUTORUN_ON_LOAD
};

// Initialize on load
init();
