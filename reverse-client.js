#!/usr/bin/env node
'use strict';

/**
 * PodBay Reverse Client — publishes PodBay operations as MCP tools
 * on the broker via WebSocket.
 *
 * KEY DIFFERENCE from original: The inject handler auto-registers every
 * plugin by its `type` name in window.__podbayPlugins, so plugins are
 * requireable by name without manual `id` fields in pod specs.
 *
 * Also: universal-require is NOT included in the bundle — it's embedded
 * in the bootstrap payload, so require() is already available.
 */

const WebSocket = require('ws');
const http = require('http');
const { optIn, optOut, normalizeName, validateName, discover, resolveApp, pods, getAppPods, assignPod, unassignPod, renameApp, loadRegistry, sameAsarPath } = require('./index');
const asar = require('./lib/asar');

const TAG = '[PodBay RC]';
const DEFAULT_URL = 'ws://localhost:3099';
const PLUGIN_URL_BASE = (process.env.PODBAY_PLUGIN_URL_BASE || 'http://localhost:8080').replace(/\/$/, '');
const CLIENT_ID = 'podbay';
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const SWEEP_DELAY_MS = 2000;
const POLL_INTERVAL_MS = 5000;

let activeWs = null;
const _pushedClients = new Set();
let _pollTimer = null;
let _lastSweepError = null;

function log(...args) { process.stderr.write(TAG + ' ' + args.join(' ') + '\n'); }

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
        const entry = Object.entries(reg).find(([, v]) => v && sameAsarPath(v.asarPath, a.asarPath));
        const regName = entry ? entry[0] : null;
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
    description: 'Opt-in an Electron app — inject bootstrap for broker-driven plugin delivery',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name or 1-based index' },
        name: { type: 'string', description: 'Client name for broker registration' },
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
      const entry = Object.entries(reg).find(([, v]) => v && sameAsarPath(v.asarPath, app.asarPath));
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
    description: 'Rename an opted-in app',
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
  {
    name: 'rebuild',
    description: 'Rebuild an opted-in app (opt-out + opt-in) to refresh the bootstrap',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }, callId) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      const reg = loadRegistry();
      const entry = Object.entries(reg).find(([, v]) => v && sameAsarPath(v.asarPath, app.asarPath));
      const name = entry ? entry[0] : normalizeName(app.name);
      if (asar.status(app.asarPath) === 'open') {
        sendProgress(callId, 1, 3, 'opt-out');
        optOut(app.asarPath);
      }
      sendProgress(callId, 2, 3, 'opt-in');
      optIn(app.asarPath, name);
      sendProgress(callId, 3, 3, 'done');
      return { name, app: app.name, status: 'rebuilt' };
    },
  },
  // ── Injection tool — THE KEY CHANGE: __podbayPlugins auto-registration ──
  {
    name: 'inject',
    description: 'Return combined injection bundle for an opted-in target withJS plugin registry',
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

      const appPods = getAppPods(meta.clientId || '');

      if (!appPods.length) {
        log('No pods assigned to:', meta.clientId || 'unknown');
        return { code: null, plugins: 0, codeLength: 0, pods: [] };
      }

      const allPlugins = pods.getPluginCodeForPods(appPods);
      if (!allPlugins.length) {
        return { code: null, plugins: 0, codeLength: 0, pods: appPods };
      }

      // ════════════════════════════════════════════════════════════════
      // Build the injection bundle with __podbayPlugins registry
      // ════════════════════════════════════════════════════════════════
      //
      // Step 1: Emit the __podbayPlugins registration block FIRST.
      //   Every plugin with code gets registered by its `type` name,
      //   making it requireable as require('type-name').
      //
      // Step 2: Then emit execution blocks for each plugin — same as
      //   before (IIFE wraps, id+cache, id+filePath modes), BUT now
      //   plugins that use module.exports
      //   DON'T need an execution IIFE — they'll be loaded on-demand
      //   via require(). Only "fire-and-forget" plugins get IIFEs.
      //
      // NOTE: require() is already available from the bootstrap.
      //   No need to include universal-require in the bundle.

      const parts = [];

      // ── Telemetry: Execution start beacon ────────────────────────
      parts.push('console.log("[PodBay Bundle] ▶ Execution started —", ' + allPlugins.length + ', "plugins");');

      // ── Step 1: Plugin registry ──────────────────────────────────
      // Register ALL plugins by type name in __podbayPlugins.
      // This is the KEY addition over the original podbay.
      const registryLines = ['// [PodBay] Plugin Registry — auto-registered by type name'];
      registryLines.push('window.__podbayPlugins = window.__podbayPlugins || {};');
      for (const p of allPlugins) {
        if (!p.code) continue; // dynamic-only plugins don't have inline code
        const safeName = (p.type || 'unknown').replace(/'/g, "\\'");
        const escaped = p.code.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        registryLines.push("window.__podbayPlugins['" + safeName + "'] = '" + escaped + "';");
      }
      parts.push(registryLines.join('\n'));

      // ── Step 2: Plugin execution blocks ──────────────────────────
      // Each plugin is wrapped in its own IIFE + try-catch.
      // The id+cache and id+filePath modes also work as before for
      // backwards compatibility with existing pod specs.
      for (const p of allPlugins) {
        const header = '// [PodBay] plugin: ' + (p.type || 'unknown') + ' — ' + (p.description || '');
        let body;

        if (p.id && p.cache) {
          // Inline mode: also pre-register in require.cache
          const safeId = p.id.replace(/'/g, "\\'");
          const escaped = p.code.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
          body = 'try { (function () {\n'
            + 'if (window.require && window.require.register) { window.require.register(\'' + safeId + '\', \'' + escaped + '\'); }\n'
            + '})(); }'
            + ' catch (__e) { console.error("[PodBay] lib error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        } else if (p.id && p.filePath) {
          // Dynamic mode: register URL for on-demand fetch
          const safeId = p.id.replace(/'/g, "\\'");
          const safeUrl = (PLUGIN_URL_BASE + '/' + p.filePath).replace(/'/g, "\\'");
          body = 'try { (function () {\n'
            + 'window.__podbayModuleUrls = window.__podbayModuleUrls || {};\n'
            + 'window.__podbayModuleUrls[\'' + safeId + '\'] = \'' + safeUrl + '\';\n'
            + '})(); }'
            + ' catch (__e) { console.error("[PodBay] url-reg error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        } else {
          // Execution via require() — provides module/exports context
          const safeName = (p.type || 'unknown').replace(/'/g, "\\'");
          body = 'try { window.require(\'' + safeName + '\'); }'
            + ' catch (__e) { console.error("[PodBay] plugin error [' + (p.type || 'unknown') + ']:", __e && __e.message); }';
        }
        parts.push(header + '\n' + body);
      }

      // ── Telemetry: Execution end beacon ──────────────────────────
      parts.push('console.log("[PodBay Bundle] ✓ All", ' + allPlugins.length + ', "plugins processed. Registry:", window.__podbayPlugins ? Object.keys(window.__podbayPlugins).join(", ") : "NONE");');
      parts.push('console.log("[PodBay Bundle] require stats:", window.require && window.require.stats ? JSON.stringify(window.require.stats()) : "require not available");');

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
    description: 'List all .pod files',
    inputSchema: { type: 'object', properties: {} },
    handler: () => pods.loadPods(),
  },
  {
    name: 'pods_get',
    description: 'Get a single pod by filename',
    inputSchema: {
      type: 'object',
      properties: { filename: { type: 'string', description: 'Pod filename' } },
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
        filename: { type: 'string', description: 'Pod filename' },
        pod: { type: 'object', description: 'Pod object' },
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
      properties: { filename: { type: 'string', description: 'Pod filename' } },
      required: ['filename'],
    },
    handler: ({ filename }) => {
      if (pods.deletePod(filename)) return { deleted: filename };
      return { error: 'Pod not found: ' + filename };
    },
  },
  {
    name: 'pods_resolve',
    description: 'Resolve all plugin code from all pods (preview)',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const allPods = pods.loadPods();
      return allPods.map(p => ({
        name: p.name,
        file: p._file,
        plugins: pods.resolvePlugins(p.plugins).map(r => ({
          type: r.type,
          description: r.description,
          hasCode: !!r.code,
          codeLength: r.code ? r.code.length : 0,
          error: r.error,
        })),
      }));
    },
  },
  {
    name: 'pods_assign',
    description: 'Assign a .pod file to an app',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name' },
        pod: { type: 'string', description: 'Pod filename' },
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
        name: { type: 'string', description: 'App name' },
        pod: { type: 'string', description: 'Pod filename' },
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
  // ── Pull model: bootstrap calls this to get its plugins ──────────────
  {
    name: 'plugins',
    description: 'Get resolved plugin list for a client (pull model — returns individual plugins, not bundled)',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'Requesting client ID' },
      },
      required: ['clientId'],
    },
    handler: ({ clientId: cid }) => {
      const appPods = getAppPods(cid || '');
      if (!appPods.length) {
        log('plugins: no pods for', cid);
        return { plugins: [], pods: [] };
      }
      const allPlugins = pods.getPluginCodeForPods(appPods);
      log('plugins:', allPlugins.length, 'plugins for', cid, 'from', appPods.join(', '));
      return {
        pods: appPods,
        plugins: allPlugins.map(p => ({
          type: p.type || null,
          description: p.description || '',
          code: p.code || null,
        })),
      };
    },
  },
];

// ── Auto-push helpers ─────────────────────────────────────────────────────────

function pushToClient(ws, clientId) {
  if (!clientId || clientId === CLIENT_ID) return;
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
      notifyPush('push-fail', { clientId, error: 'No injectable code', pods: appPods });
      return;
    }

    const pushCallId = 'push-' + Date.now();
    const verifyCallId = 'verify-' + Date.now();

    // Track pending verification
    if (!pushToClient._pending) pushToClient._pending = {};
    pushToClient._pending[pushCallId] = { clientId, plugins: bundle.plugins, codeLength: bundle.codeLength, pods: appPods };
    pushToClient._pending[verifyCallId] = { clientId, type: 'verify' };

    // Step 1: Push the bundle
    ws.send(JSON.stringify({
      type: 'call_tool',
      callId: pushCallId,
      tool: clientId + '__execute',
      arguments: { code: bundle.code, useIIFE: false },
    }));
    log('Pushed', bundle.plugins, 'plugins to', clientId, '(' + bundle.codeLength + ' chars)');

    // Step 2: Immediately request verification via info tool
    ws.send(JSON.stringify({
      type: 'call_tool',
      callId: verifyCallId,
      tool: clientId + '__info',
      arguments: {},
    }));
    log('Verification request sent to', clientId);

    notifyPush('push-sent', { clientId, plugins: bundle.plugins, codeLength: bundle.codeLength, pods: appPods, awaitingVerification: true });
  } catch (e) {
    log('Push failed for', clientId + ':', e.message);
    notifyPush('push-fail', { clientId, error: e.message, pods: appPods });
  }
}

function sweepExistingClients(ws) {
  if (!ws || ws.readyState !== 1) return;
  log('Sweeping for existing bootstrap clients...');
  notifyPush('sweep-start', { message: 'Scanning for existing clients' });
  fetchBrokerClients(ws);
  startClientPoll(ws);
}

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
        const jsonStr = data.includes('data: ') ? data.split('data: ').pop().trim() : data.trim();
        const parsed = JSON.parse(jsonStr);
        const content = parsed.result && parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
        const clients = JSON.parse(content);
        let pushed = 0;
        for (const c of clients) {
          if (c.clientId === CLIENT_ID) continue;
          // TODO: re-enable push cache after debugging
          // if (_pushedClients.has(c.clientId)) continue;
          if (getAppPods(c.clientId).length > 0) {
            pushToClient(ws, c.clientId);
            // _pushedClients.add(c.clientId);
            pushed++;
          }
        }
        if (pushed > 0) log('Sweep complete:', pushed, 'client(s) received plugins');
        if (pushed > 0) {
          notifyPush('sweep-done', { clientsFound: clients.length, clientsPushed: pushed });
        }
        _lastSweepError = null;
      } catch (e) {
        log('Sweep parse error:', e.message);
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

// ── Reverse client connection ────────────────────────────────────────────────

function connect(url) {
  let reconnectDelay = RECONNECT_MS;

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
        // Pull model: bootstrap pulls its own plugins — no sweep needed
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

      // ── Push/Verify result handling ──────────────────────────────
      if (msg.type === 'tool_result' && msg.callId && pushToClient._pending) {
        const pending = pushToClient._pending[msg.callId];
        if (pending) {
          delete pushToClient._pending[msg.callId];
          const content = msg.content?.[0]?.text || '';
          let parsed;
          try { parsed = JSON.parse(content); } catch (_) { parsed = { raw: content }; }

          if (pending.type === 'verify') {
            // Verification result from info tool
            const cid = pending.clientId;
            if (parsed.error) {
              log('⚠ VERIFY FAILED:', cid, '—', parsed.error);
              notifyPush('verify-fail', { clientId: cid, error: parsed.error });
            } else {
              const registry = parsed.pluginRegistry || [];
              const requireOk = parsed.requireAvailable;
              const stats = parsed.requireStats || {};
              if (registry.length > 0) {
                log('✓ VERIFIED:', cid, '—', registry.length, 'plugins registered:', registry.join(', '));
                log('  require() available:', requireOk, '| cached modules:', stats.cached || 0);
                notifyPush('verify-success', { clientId: cid, pluginRegistry: registry, requireAvailable: requireOk, requireStats: stats });
                _pushedClients.add(cid);
              } else {
                log('⚠ VERIFY WARNING:', cid, '— 0 plugins in registry. Push may have failed silently.');
                log('  Full info:', JSON.stringify(parsed));
                _pushedClients.delete(cid);
                log('  Removed', cid, 'from push cache — will retry on next poll');
                notifyPush('verify-warning', { clientId: cid, info: parsed, message: 'No plugins in registry after push — will retry' });
              }
            }
          } else {
            // Push execution result
            const cid = pending.clientId;
            if (msg.isError || parsed.error) {
              log('✗ PUSH EXECUTE FAILED:', cid, '—', parsed.error || content);
              notifyPush('push-execute-fail', { clientId: cid, error: parsed.error || content });
            } else {
              log('✓ Push executed on', cid);
              notifyPush('push-executed', { clientId: cid, result: parsed });
            }
          }
          return;
        }
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
            type: 'tool_result',
            callId: msg.callId,
            content: [{ type: 'text', text }],
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'tool_result', callId: msg.callId,
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
            isError: true,
          }));
        }
      }
    });

    ws.on('close', () => {
      activeWs = null;
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      _pushedClients.clear();
      const d = Math.min(reconnectDelay + Math.random() * 1000, MAX_RECONNECT_MS);
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_MS);
      log('Disconnected. Reconnecting in', Math.round(d / 1000) + 's...');
      setTimeout(start, d);
    });

    ws.on('error', () => { });
  }

  start();
}

// ── Start ────────────────────────────────────────────────────────────────────

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : (process.env.PODBAY_BROKER_URL || DEFAULT_URL);

log('Starting PodBay reverse client...');
log('Broker:', url);
log('Plugin URL base:', PLUGIN_URL_BASE);
connect(url);
