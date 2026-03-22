// PodBay Tool Handler — tool definitions and call dispatch for the bootstrap
// CommonJS module loaded via bootstrap's require polyfill.
//
// Usage:
//   var tools = require('tool-handler');
//   var defs = tools.definitions();
//   var result = tools.handleCall('execute', { code: '1+1' }, context);
'use strict';

var TAG = '[PodBay Tools]';

var TOOLS = [
  {
    name: 'execute',
    description: 'Execute JavaScript in the renderer main world',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to execute' },
        useIIFE: { type: 'boolean', description: 'Wrap code in an IIFE (default: true)', default: true }
      },
      required: ['code']
    }
  },
  {
    name: 'info',
    description: 'Get bootstrap status and metadata for this window',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'inspect',
    description: 'Open Chrome DevTools for this renderer window (full main world access)',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'DevTools dock mode: detach (separate window), right, bottom, or close',
          enum: ['detach', 'right', 'bottom', 'close'],
          default: 'detach'
        }
      }
    }
  }
];

// context: { clientId, transport, steps }
function handleCall(toolName, args, context) {
  var transport = context.transport;
  var clientId = context.clientId;

  if (toolName === 'execute' && args && args.code) {
    try {
      var code = args.code;
      var useIIFE = args.useIIFE !== false;
      transport.step('execute', 'start', code.length + ' chars, useIIFE=' + useIIFE);

      var execErrors = [];
      var evalResult;
      try {
        var execCode = useIIFE ? '(function(){' + code + '\n})();' : code;
        evalResult = (0, eval)(execCode);
      } catch (evalErr) {
        execErrors.push({ message: evalErr.message, source: 'eval', line: 0, col: 0 });
      }

      var pluginsBefore = window.__podbayPlugins ? Object.keys(window.__podbayPlugins) : [];
      var requireStats = window.require && window.require.stats ? window.require.stats() : null;

      // Serialize return value safely
      var returnValue;
      if (evalResult !== undefined) {
        try { returnValue = JSON.parse(JSON.stringify(evalResult)); } catch (_) { returnValue = String(evalResult); }
      }

      var result = {
        result: 'executed',
        codeLength: code.length,
        returnValue: returnValue,
        pluginsRegistered: pluginsBefore,
        requireStats: requireStats,
        errors: execErrors.length > 0 ? execErrors : undefined
      };

      if (execErrors.length > 0) {
        transport.step('execute', 'fail', execErrors.length + ' error(s)');
      } else {
        transport.step('execute', 'ok', pluginsBefore.length + ' plugins, ' + (requireStats ? requireStats.cached : 0) + ' modules cached');
      }
      return result;
    } catch (err) {
      transport.step('execute', 'fail', err.message);
      return { error: err.message };
    }
  }

  if (toolName === 'info') {
    transport.step('info', 'ok', 'returning bootstrap status');

    // Electron / Node introspection
    var electron = {};
    electron.hasProcess = typeof process !== 'undefined';
    electron.nodeVersion = electron.hasProcess && process.versions ? process.versions.node : null;
    electron.electronVersion = electron.hasProcess && process.versions ? process.versions.electron : null;
    electron.chromeVersion = electron.hasProcess && process.versions ? process.versions.chrome : null;
    electron.nodeIntegration = electron.hasProcess && typeof process.type === 'string';
    try {
      var _electron = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__('electron') : (typeof module !== 'undefined' && module.require ? module.require('electron') : null);
      electron.electronModuleAvailable = !!_electron;
      electron.hasWebFrame = !!(_electron && _electron.webFrame);
      electron.hasIpcRenderer = !!(_electron && _electron.ipcRenderer);
      electron.contextIsolation = !!(window.trustedTypes || (!_electron && electron.hasProcess));
    } catch (e) {
      electron.electronModuleAvailable = false;
      electron.electronRequireError = e.message;
    }

    // Iframe inventory
    var iframes = [];
    try {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var info = { src: f.src || '', id: f.id || '', name: f.name || '' };
        try { info.contentDocumentAccessible = !!f.contentDocument; } catch (_) { info.contentDocumentAccessible = false; }
        iframes.push(info);
      }
    } catch (_) { }

    return {
      clientId: clientId,
      url: location.href,
      title: document.title || '',
      userAgent: navigator.userAgent,
      podBayInstalled: !!window.__podBayInstalled,
      requireAvailable: !!window.__PodBayRequire,
      requireVersion: window.__PodBayRequire ? window.__PodBayRequire.version : null,
      requireStats: window.require && window.require.stats ? window.require.stats() : null,
      pluginRegistry: window.__podbayPlugins ? Object.keys(window.__podbayPlugins) : [],
      electron: electron,
      iframes: iframes,
      steps: transport.steps(),
      timestamp: new Date().toISOString()
    };
  }

  if (toolName === 'inspect') {
    var mode = (args && args.mode) || 'detach';
    var validModes = ['detach', 'right', 'bottom', 'close'];
    if (validModes.indexOf(mode) === -1) mode = 'detach';
    var cmd = mode === 'close' ? 'devtools_close' : 'devtools' + (mode === 'detach' ? '' : '_' + mode);
    transport.step('inspect', 'start', 'sending __podbay_cmd:' + cmd + ' to main process');
    console.log('__podbay_cmd:' + cmd);
    transport.step('inspect', 'ok', 'DevTools ' + (mode === 'close' ? 'close' : 'open (' + mode + ')') + ' requested via console-message IPC');
    return { opened: mode !== 'close', mode: mode, method: 'console-message IPC \u2192 main process openDevTools' };
  }

  transport.step('tool-call', 'fail', 'unknown tool: ' + toolName);
  return { error: 'Unknown tool or missing code: ' + toolName };
}

module.exports = {
  definitions: function () { return TOOLS; },
  handleCall: handleCall
};
