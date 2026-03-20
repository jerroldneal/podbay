#!/usr/bin/env node
'use strict';

/**
 * PodBay Reverse Client — publishes all PodBay operations as MCP tools
 * on the broker via WebSocket. Runs as a long-lived process.
 *
 * Usage:
 *   node reverse-client.js                           # default ws://localhost:3099
 *   node reverse-client.js --url ws://myhost:3099    # custom broker URL
 */

const WebSocket = require('ws');
const http = require('http');
const { optIn, optOut, normalizeName, validateName, discover, resolveApp, pods, getAppPods, assignPod, unassignPod, renameApp, loadRegistry } = require('./index');
const asar = require('./lib/asar');

const TAG = '[PodBay RC]';
const DEFAULT_URL = 'ws://localhost:3099';
const PLUGIN_URL_BASE = (process.env.PODBAY_PLUGIN_URL_BASE || 'http://localhost:8080').replace(/\/$/, '');
const CLIENT_ID = 'podbay';
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const SWEEP_DELAY_MS = 2000; // delay before initial sweep after registration
const POLL_INTERVAL_MS = 5000; // poll broker for new clients

let activeWs = null;  // current WebSocket, set on connect
const _pushedClients = new Set(); // track clients we've already pushed to
let _pollTimer = null; // client poll timer
let _lastSweepError = null; // deduplicate repeated sweep errors

function log(...args) { process.stderr.write(TAG + ' ' + args.join(' ') + '\n'); }

/**
 * Send a push-activity notification through the broker WS.
 * The dashboard picks these up and displays them in the Push Activity log.
 * @param {'push-attempt'|'push-success'|'push-fail'|'push-skip'|'sweep-start'|'sweep-done'|'sweep-error'} event
 * @param {object} detail
 */
function notifyPush(event, detail) {
  if (!activeWs || activeWs.readyState !== 1) return;
  activeWs.send(JSON.stringify({
    type: 'notification',
    data: {
      category: 'push-activity',
      event,
      timestamp: Date.now(),
      ...detail,
    },
  }));
}

/**
 * Send an MCP-standard notifications/progress message via WS.
 * @param {string} callId - The tool_call callId (used as progressToken)
 * @param {number} progress - Current step (1-based)
 * @param {number} total - Total steps
 * @param {string} [message] - Human-readable step label
 */
function sendProgress(callId, progress, total, message) {
  if (!activeWs || activeWs.readyState !== 1) return;
  activeWs.send(JSON.stringify({
    type: 'notification',
    data: {
      method: 'notifications/progress',
      params: { progressToken: callId, progress, total, message: message || '' },
    },
  }));
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const tools = [
  {
    name: 'list',
    description: 'Discover installed Electron apps with portal status and plugin count',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const apps = discover();
      const reg = loadRegistry();
      return apps.map((a, i) => {
        const entry = Object.entries(reg).find(([, v]) => v.asarPath === a.asarPath);
        const regName = entry ? entry[0] : null;
        // Check pods by registered name, then by directory name (pod assignment is independent of opt-in)
        const appPods = getAppPods(regName) || [];
        const dirPods = regName ? [] : (getAppPods(normalizeName(a.name)) || []);
        return {
          index: i + 1,
          name: a.name,
          asarPath: a.asarPath,
          status: asar.status(a.asarPath),
          registeredName: regName,
          pods: appPods.length ? appPods : dirPods,
        };
      });
    },
  },
  {
    name: 'opt_in',
    description: 'Opt-in an Electron app — inject bootstrap for broker-driven plugin delivery. Name defaults to normalized app directory name.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name or 1-based index' },
        name: { type: 'string', description: 'Client name for broker registration (lowercase alphanumeric + hyphens). Defaults to normalized app name.' },
      },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex, name }, callId) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      if (!name) name = normalizeName(app.name);
      const err = validateName(name);
      if (err) return { error: err };
      optIn(app.asarPath, name, (step, progress, total) => {
        sendProgress(callId, progress, total, step);
      });
      return { name: name, app: app.name, status: 'opted-in' };
    },
  },
  {
    name: 'opt_out',
    description: 'Opt-out an Electron app — restore original ASAR',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }, callId) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      optOut(app.asarPath, (step, progress, total) => {
        sendProgress(callId, progress, total, step);
      });
      return { name: app.name, status: 'opted-out' };
    },
  },
  {
    name: 'status',
    description: 'Get portal status and plugin list for an Electron app',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      const reg = loadRegistry();
      const entry = Object.entries(reg).find(([, v]) => v.asarPath === app.asarPath);
      const regName = entry ? entry[0] : null;
      const appPods = getAppPods(regName) || [];
      const dirPods = regName ? [] : (getAppPods(normalizeName(app.name)) || []);
      return {
        name: app.name,
        asarPath: app.asarPath,
        status: asar.status(app.asarPath),
        registeredName: regName,
        pods: appPods.length ? appPods : dirPods,
      };
    },
  },
  {
    name: 'rename',
    description: 'Rename an opted-in app (change its registered broker name)',
    inputSchema: {
      type: 'object',
      properties: {
        oldName: { type: 'string', description: 'Current registered name' },
        newName: { type: 'string', description: 'New registered name' },
      },
      required: ['oldName', 'newName'],
    },
    handler: ({ oldName, newName }) => {
      renameApp(oldName, newName);
      return { oldName, newName, status: 'renamed' };
    },
  },
  // ── Injection tool (system plugin calls this) ────────────────────────
  {
    name: 'inject',
    description: 'Return combined injection bundle for an opted-in target. Called automatically when a bootstrap client connects, or manually for re-injection.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'Target client ID' },
        url: { type: 'string', description: 'Target page URL' },
        title: { type: 'string', description: 'Target page title' },
        product: { type: 'string', description: 'Product identifier' },
        userAgent: { type: 'string', description: 'Target user agent' },
        timestamp: { type: 'string', description: 'Request timestamp' },
      },
    },
    handler: (meta) => {
      log('Inject request from:', meta.clientId || 'unknown', '—', meta.url || 'no-url');

      // Look up which pods are assigned to this client
      const appPods = getAppPods(meta.clientId || '');

      if (!appPods.length) {
        log('No pods assigned to:', meta.clientId || 'unknown');
        return { code: null, plugins: 0, codeLength: 0, pods: [] };
      }

      // Resolve plugin code only from assigned pods
      const allPlugins = pods.getPluginCodeForPods(appPods);
      if (!allPlugins.length) {
        return { code: null, plugins: 0, codeLength: 0, pods: appPods };
      }

      // Combine all plugin code into a single injectable bundle.
      // Each plugin is wrapped in its own IIFE + try-catch so that:
      //   - a top-level `return` guard inside a plugin only exits that plugin's wrapper
      //   - an uncaught exception in one plugin doesn't prevent subsequent plugins from running
      // id + cache:true  → inline code + pre-register in require.cache
      // id + cache:false → register URL in __podbayModuleUrls; fetched dynamically at require() time
      // no id            → plain IIFE
      const parts = allPlugins.map(p => {
        const header = '// [PodBay] plugin: ' + (p.type || 'unknown') + ' — ' + (p.description || '');
        let body;
        if (p.id && p.cache) {
          // Inline mode: pre-register full module code in require.cache
          const safeId = p.id.replace(/'/g, "\\'");
          body = 'try { (function () {\n'
            + 'var __m = { exports: {}, id: \'' + safeId + '\', loaded: false };\n'
            + '(function (module, exports) {\n'
            + p.code + '\n'
            + '})(__m, __m.exports);\n'
            + '__m.loaded = true;\n'
            + 'if (window.require && window.require.cache) window.require.cache[\'' + safeId + '\'] = __m;\n'
            + '})(); }'
            + ' catch (__e) { console.error("[PodBay] lib error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        } else if (p.id && p.filePath) {
          // Dynamic mode: register serve URL; module fetched on first require(id)
          const safeId = p.id.replace(/'/g, "\\'");
          const safeUrl = (PLUGIN_URL_BASE + '/' + p.filePath).replace(/'/g, "\\'");
          body = 'try { (function () {\n'
            + 'window.__podbayModuleUrls = window.__podbayModuleUrls || {};\n'
            + 'window.__podbayModuleUrls[\'' + safeId + '\'] = \'' + safeUrl + '\';\n'
            + '})(); }'
            + ' catch (__e) { console.error("[PodBay] url-reg error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        } else {
          // Plain plugin: fire-and-forget IIFE
          body = 'try { (function () {\n' + p.code + '\n})(); }'
            + ' catch (__e) { console.error("[PodBay] plugin error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        }
        return header + '\n' + body;
      });
      const bundle = parts.join('\n\n');

      log('Bundle built:', allPlugins.length, 'plugins,', bundle.length, 'chars from', appPods.join(', '));

      return {
        code: bundle,
        plugins: allPlugins.length,
        codeLength: bundle.length,
        pods: appPods,
        target: meta.clientId || 'unknown',
      };
    },
  },
  // ── Pod management tools ─────────────────────────────────────────────
  {
    name: 'pods_list',
    description: 'List all .pod files from the pods directory',
    inputSchema: { type: 'object', properties: {} },
    handler: () => pods.loadPods(),
  },
  {
    name: 'pods_get',
    description: 'Get a single pod by filename',
    inputSchema: {
      type: 'object',
      properties: { filename: { type: 'string', description: 'Pod filename (e.g. my-pod.pod)' } },
      required: ['filename'],
    },
    handler: ({ filename }) => {
      const pod = pods.getPod(filename);
      if (!pod) return { error: 'Pod not found: ' + filename };
      return pod;
    },
  },
  {
    name: 'pods_save',
    description: 'Create or update a .pod file',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Pod filename (e.g. my-pod.pod)' },
        pod: { type: 'object', description: 'Pod object with name, description, and plugins array' },
      },
      required: ['filename', 'pod'],
    },
    handler: ({ filename, pod: podData }) => {
      if (!filename || !filename.endsWith('.pod')) return { error: 'Filename must end with .pod' };
      pods.savePod(filename, podData);
      return { saved: filename };
    },
  },
  {
    name: 'pods_delete',
    description: 'Delete a .pod file',
    inputSchema: {
      type: 'object',
      properties: { filename: { type: 'string', description: 'Pod filename to delete' } },
      required: ['filename'],
    },
    handler: ({ filename }) => {
      if (pods.deletePod(filename)) return { deleted: filename };
      return { error: 'Pod not found: ' + filename };
    },
  },
  {
    name: 'pods_resolve',
    description: 'Resolve all plugin code from all pods (preview what would be injected)',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const allPods = pods.loadPods();
      return allPods.map(p => ({
        name: p.name,
        file: p._file,
        plugins: pods.resolvePlugins(p.plugins).map(r => ({
          type: r.type,
          description: r.description,
          dashboard: r.dashboard,
          hasCode: !!r.code,
          codeLength: r.code ? r.code.length : 0,
          error: r.error,
        })),
      }));
    },
  },
  // ── Pod-to-app assignment tools ──────────────────────────────────────
  {
    name: 'pods_assign',
    description: 'Assign a .pod file to an app by name',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name (e.g. "clubwpt-desktop")' },
        pod: { type: 'string', description: 'Pod filename (e.g. "cwg-debug.pod")' },
      },
      required: ['name', 'pod'],
    },
    handler: ({ name, pod: podFile }) => {
      if (!pods.getPod(podFile)) return { error: 'Pod not found: ' + podFile };
      try {
        assignPod(name, podFile);
        return { assigned: podFile, app: name, pods: getAppPods(name) };
      } catch (e) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'pods_unassign',
    description: 'Unassign a .pod file from an app',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name (e.g. "clubwpt-desktop")' },
        pod: { type: 'string', description: 'Pod filename to unassign' },
      },
      required: ['name', 'pod'],
    },
    handler: ({ name, pod: podFile }) => {
      try {
        unassignPod(name, podFile);
        return { unassigned: podFile, app: name, pods: getAppPods(name) };
      } catch (e) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'pods_app',
    description: 'List pods assigned to a specific app',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App name' } },
      required: ['name'],
    },
    handler: ({ name }) => {
      const appPodsList = getAppPods(name);
      return { app: name, pods: appPodsList };
    },
  },
];

// ── Auto-push helpers ─────────────────────────────────────────────────────────

/**
 * Push pod plugins to a single client if it has assigned pods.
 * @param {WebSocket} ws - active WS connection
 * @param {string} clientId - target client
 */
function pushToClient(ws, clientId) {
  if (!clientId || clientId === CLIENT_ID) return; // ignore self
  const appPods = getAppPods(clientId);
  if (!appPods.length) {
    notifyPush('push-skip', { clientId, reason: 'No pods assigned' });
    return;
  }

  log('Pushing', appPods.length, 'pod(s) to', clientId + '...');
  notifyPush('push-attempt', { clientId, pods: appPods });

  try {
    const injectTool = tools.find(t => t.name === 'inject');
    const bundle = injectTool.handler({ clientId });
    if (!bundle || !bundle.code) {
      log('No injectable code for', clientId);
      notifyPush('push-fail', { clientId, error: 'No injectable code produced', pods: appPods });
      return;
    }

    ws.send(JSON.stringify({
      type: 'call_tool',
      callId: 'auto-push-' + Date.now(),
      tool: clientId + '__execute_plugin',
      arguments: { code: bundle.code },
    }));
    log('Pushed', bundle.plugins, 'plugins to', clientId, '(' + bundle.codeLength + ' chars)');
    notifyPush('push-success', { clientId, plugins: bundle.plugins, codeLength: bundle.codeLength, pods: appPods });
  } catch (e) {
    log('Push failed for', clientId + ':', e.message);
    notifyPush('push-fail', { clientId, error: e.message, pods: appPods });
  }
}

/**
 * After RC registers, query the broker via HTTP for existing clients and push
 * to any that have assigned pods. Also starts periodic polling for new clients.
 */
function sweepExistingClients(ws) {
  if (!ws || ws.readyState !== 1) return;
  log('Sweeping for existing bootstrap clients...');
  notifyPush('sweep-start', { message: 'Scanning for existing clients' });
  fetchBrokerClients(ws);
  // Start periodic polling for new clients
  startClientPoll(ws);
}

/**
 * Fetch client list via HTTP and push plugins to any with assigned pods.
 */
function fetchBrokerClients(ws) {
  if (!ws || ws.readyState !== 1) return;

  const brokerHttpPort = process.env.PODBAY_BROKER_HTTP_PORT || '3098';
  const brokerHttpHost = process.env.PODBAY_BROKER_HTTP_HOST || 'host.docker.internal';

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'list_broker_clients', arguments: {} },
    id: 1,
  });

  const req = http.request({
    hostname: brokerHttpHost,
    port: parseInt(brokerHttpPort, 10),
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 5000,
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        // SSE format: "event: message\ndata: {...}\n\n"
        const jsonStr = data.includes('data: ') ? data.split('data: ').pop().trim() : data.trim();
        const parsed = JSON.parse(jsonStr);
        const content = parsed.result && parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
        const clients = JSON.parse(content);
        let pushed = 0;
        for (const c of clients) {
          if (c.clientId === CLIENT_ID) continue;
          if (_pushedClients.has(c.clientId)) continue;
          if (getAppPods(c.clientId).length > 0) {
            pushToClient(ws, c.clientId);
            _pushedClients.add(c.clientId);
            pushed++;
          }
        }
        if (pushed > 0) log('Sweep complete:', pushed, 'client(s) received plugins');
        // Only notify when something actually happened (avoid 5s poll noise)
        if (pushed > 0) {
          notifyPush('sweep-done', { clientsFound: clients.length, clientsPushed: pushed });
        }
        _lastSweepError = null; // clear error dedup on success
      } catch (e) {
        log('Sweep parse error:', e.message);
        // Only notify on first occurrence of this error (avoid repeated noise)
        if (_lastSweepError !== e.message) {
          _lastSweepError = e.message;
          notifyPush('sweep-error', { error: e.message });
        }
      }
    });
  });

  req.on('error', (e) => {
    log('Sweep HTTP error:', e.message);
    if (_lastSweepError !== e.message) { _lastSweepError = e.message; notifyPush('sweep-error', { error: 'HTTP: ' + e.message }); }
  });
  req.on('timeout', () => {
    req.destroy(); log('Sweep HTTP timeout');
    if (_lastSweepError !== 'HTTP timeout') { _lastSweepError = 'HTTP timeout'; notifyPush('sweep-error', { error: 'HTTP timeout' }); }
  });
  req.write(payload);
  req.end();
}

/**
 * Poll broker periodically for new clients that need plugin injection.
 */
function startClientPoll(ws) {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      return;
    }
    fetchBrokerClients(ws);
  }, POLL_INTERVAL_MS);
}

// ── Minimal reverse-client protocol ──────────────────────────────────────────

function connect(url) {
  let reconnectDelay = RECONNECT_MS;
  let closed = false;

  function start() {
    const ws = new WebSocket(url);
    activeWs = ws;

    ws.on('open', () => {
      reconnectDelay = RECONNECT_MS;
      log('Connected to', url);
      ws.send(JSON.stringify({
        type: 'register',
        clientId: CLIENT_ID,
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'registered') {
        log('Registered as', msg.clientId, 'with', tools.length, 'tools');
        // Sweep: after a short delay, check for existing bootstrap clients
        // that connected before us and push their plugins
        setTimeout(() => sweepExistingClients(ws), SWEEP_DELAY_MS);
        return;
      }

      // ── React to broker client connect/disconnect events ──────────
      if (msg.type === 'client_connected') {
        const cid = msg.clientId;
        if (cid && cid !== CLIENT_ID && getAppPods(cid).length > 0) {
          log('Client connected:', cid, '— pushing pods...');
          _pushedClients.delete(cid); // allow re-push for fresh connection
          pushToClient(ws, cid);
          _pushedClients.add(cid);
        }
        return;
      }

      if (msg.type === 'client_disconnected') {
        const cid = msg.clientId;
        if (cid) {
          _pushedClients.delete(cid);
          log('Client disconnected:', cid, '— cleared from push cache');
        }
        return;
      }

      if (msg.type === 'tool_call') {
        const entry = tools.find(t => t.name === msg.tool);
        if (!entry) {
          ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: 'Unknown tool: ' + msg.tool }],
            isError: true,
          }));
          return;
        }

        try {
          const result = await entry.handler(msg.arguments || {}, msg.callId);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text }],
            isError: false,
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: 'Error: ' + err.message }],
            isError: true,
          }));
        }
      }
    });

    ws.on('close', () => {
      if (closed) return;
      log('Disconnected. Reconnecting in', reconnectDelay + 'ms...');
      setTimeout(start, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    });

    ws.on('error', (err) => {
      log('WebSocket error:', err.message);
    });
  }

  start();

  process.on('SIGINT', () => { closed = true; log('Shutting down.'); process.exit(0); });
  process.on('SIGTERM', () => { closed = true; log('Shutting down.'); process.exit(0); });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let url = process.env.PODBAY_BROKER_URL || DEFAULT_URL;
const urlIdx = args.indexOf('--url');
if (urlIdx !== -1 && args[urlIdx + 1]) url = args[urlIdx + 1];

log('PodBay reverse client starting...');
log('Broker:', url);
log('Tools:', tools.map(t => t.name).join(', '));
connect(url);
