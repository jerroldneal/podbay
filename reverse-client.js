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
const { optIn, optOut, normalizeName, validateName, discover, resolveApp, pods, getAppPods, assignPod, unassignPod, renameApp, loadRegistry } = require('./index');
const asar = require('./lib/asar');

const TAG = '[PodBay RC]';
const DEFAULT_URL = 'ws://localhost:3099';
const CLIENT_ID = 'podbay';
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;

let activeWs = null;  // current WebSocket, set on connect

function log(...args) { process.stderr.write(TAG + ' ' + args.join(' ') + '\n'); }

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
        return {
          index: i + 1,
          name: a.name,
          asarPath: a.asarPath,
          status: asar.status(a.asarPath),
          registeredName: entry ? entry[0] : null,
          pods: entry ? (entry[1].pods || []) : [],
        };
      });
    },
  },
  {
    name: 'opt_in',
    description: 'Opt-in an Electron app — inject system plugin for broker-driven injection. Name defaults to normalized app directory name.',
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
      return {
        name: app.name,
        asarPath: app.asarPath,
        status: asar.status(app.asarPath),
        registeredName: entry ? entry[0] : null,
        pods: entry ? (entry[1].pods || []) : [],
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
    description: 'Return combined injection bundle for an opted-in target. Called by system plugin on startup.',
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

      // Combine all plugin code into a single injectable bundle
      const parts = allPlugins.map(p => {
        const header = '// [PodBay] plugin: ' + (p.type || 'unknown') + ' — ' + (p.description || '');
        return header + '\n' + p.code;
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
    description: 'Assign a .pod file to an opted-in app',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered app name (e.g. "cwg")' },
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
    description: 'Unassign a .pod file from an opted-in app',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered app name (e.g. "cwg")' },
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
    description: 'List pods assigned to a specific opted-in app',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Registered app name' } },
      required: ['name'],
    },
    handler: ({ name }) => {
      const appPodsList = getAppPods(name);
      return { app: name, pods: appPodsList };
    },
  },
];

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
