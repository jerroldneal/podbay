// PodBay MCP Client — pulls plugins from the broker's HTTP/MCP endpoint
// CommonJS module loaded via bootstrap's require polyfill.
//
// Usage:
//   var mcpClient = require('mcp-client');
//   mcpClient.pullPlugins({ httpUrl: '...', clientId: '...', transport: transport });
'use strict';

var TAG = '[PodBay MCP Client]';
var _pluginsPulled = false;

function pullPlugins(opts) {
  if (_pluginsPulled) return;
  var httpUrl = opts.httpUrl;
  var clientId = opts.clientId;
  var transport = opts.transport;

  transport.step('pull', 'start', 'requesting plugins for clientId=' + clientId + ' from ' + httpUrl);

  var body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'podbay__plugins', arguments: { clientId: clientId } },
    id: 1
  });
  var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

  fetch(httpUrl, { method: 'POST', headers: headers, body: body })
    .then(function (resp) {
      if (!resp.ok) {
        transport.step('pull', 'fail', 'HTTP ' + resp.status + ' from ' + httpUrl + ' — broker may be down or endpoint not responding');
        return null;
      }
      var ct = resp.headers.get('Content-Type') || '';
      if (ct.indexOf('text/event-stream') >= 0) {
        return parseSSEResponse(resp, transport);
      }
      return resp.text().then(function (rawText) {
        try {
          var json = JSON.parse(rawText);
          if (json.error) { transport.step('pull', 'fail', json.error.message || JSON.stringify(json.error)); return null; }
          return json.result;
        } catch (e) {
          var preview = rawText.length > 500 ? rawText.substring(0, 500) + '...' : rawText;
          transport.step('pull', 'fail', 'broker returned non-JSON (HTTP 200): ' + preview);
          console.error(TAG, 'full broker response:', rawText);
          return null;
        }
      });
    })
    .then(function (result) {
      if (!result) return;
      var text = '';
      if (result.content) {
        for (var i = 0; i < result.content.length; i++) {
          if (result.content[i].type === 'text') { text = result.content[i].text; break; }
        }
      }
      if (!text) { transport.step('pull', 'fail', 'empty/missing response from ' + httpUrl + ' — check pod assignment'); return; }
      try {
        var data = JSON.parse(text);
        handlePullResult(data, transport);
      } catch (e) {
        var preview = text.length > 500 ? text.substring(0, 500) + '...' : text;
        transport.step('pull', 'fail', 'parse error in plugin data: ' + e.message + ' | response: ' + preview);
        console.error(TAG, 'full plugin response text:', text);
      }
    })
  ['catch'](function (err) {
    transport.step('pull', 'fail', 'network error: ' + err.message);
  });
}

function parseSSEResponse(resp, transport) {
  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  function readChunk() {
    return reader.read().then(function (chunk) {
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('data: ') === 0) {
          try {
            var parsed = JSON.parse(lines[i].slice(6));
            if (parsed.result !== undefined) { reader.cancel(); return parsed.result; }
            if (parsed.error) { reader.cancel(); transport.step('pull', 'fail', parsed.error.message || JSON.stringify(parsed.error)); return null; }
          } catch (_) { }
        }
      }
      return readChunk();
    });
  }
  return readChunk();
}

function handlePullResult(data, transport) {
  if (!data.plugins || !data.plugins.length) {
    transport.step('pull', 'ok', 'no plugins assigned');
    return;
  }
  transport.step('pull', 'ok', data.plugins.length + ' plugins from ' + (data.pods || []).join(', '));
  _pluginsPulled = true;

  window.__podbayPlugins = window.__podbayPlugins || {};
  for (var i = 0; i < data.plugins.length; i++) {
    var p = data.plugins[i];
    // Report plugins that failed to load on the server side
    if (p.error) {
      transport.step('plugin-load', 'fail', (p.type || 'unknown') + ': ' + p.error);
      if (p.mandatory) {
        transport.fatal('Mandatory plugin "' + (p.type || 'unknown') + '" failed to load: ' + p.error);
      }
      continue;
    }
    if (!p.code || !p.type) {
      transport.step('plugin-load', 'skip', (p.type || 'unknown') + ': no code');
      continue;
    }
    try {
      window.__podbayPlugins[p.type] = p.code;
      window.require(p.type);
      transport.step('plugin-load', 'ok', p.type);
    } catch (err) {
      transport.step('plugin-load', 'fail', p.type + ': ' + err.message);
      if (p.mandatory) {
        transport.fatal('Mandatory plugin "' + p.type + '" failed to load: ' + err.message);
      }
    }
  }

  var stats = window.require.stats();
  transport.step('pull-complete', 'ok', stats.cached + ' modules cached');
}

module.exports = {
  pullPlugins: pullPlugins
};
