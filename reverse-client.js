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
const { open, close, discover, readPlugins, writePlugins, resolveApp } = require('./index');
const asar = require('./lib/asar');

const TAG = '[PodBay RC]';
const DEFAULT_URL = 'ws://localhost:3099';
const CLIENT_ID = 'podbay';
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;

function log(...args) { process.stderr.write(TAG + ' ' + args.join(' ') + '\n'); }

// ── Tool definitions ─────────────────────────────────────────────────────────

const tools = [
  {
    name: 'list',
    description: 'Discover installed Electron apps with portal status and plugin count',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const apps = discover();
      return apps.map((a, i) => ({
        index: i + 1,
        name: a.name,
        status: asar.status(a.asarPath),
        plugins: readPlugins(a.asarPath).length,
      }));
    },
  },
  {
    name: 'open',
    description: 'Open portal for an Electron app',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      open(app.asarPath);
      return { name: app.name, status: 'open' };
    },
  },
  {
    name: 'close',
    description: 'Close portal for an Electron app',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      close(app.asarPath);
      return { name: app.name, status: 'closed' };
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
      return {
        name: app.name,
        status: asar.status(app.asarPath),
        plugins: readPlugins(app.asarPath),
      };
    },
  },
  {
    name: 'plugins_list',
    description: 'List configured plugins for an Electron app',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name or 1-based index' } },
      required: ['app'],
    },
    handler: ({ app: nameOrIndex }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      return readPlugins(app.asarPath);
    },
  },
  {
    name: 'plugins_add',
    description: 'Add a plugin by file path to an Electron app',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name or 1-based index' },
        path: { type: 'string', description: 'Plugin file path (must be require-resolvable)' },
      },
      required: ['app', 'path'],
    },
    handler: ({ app: nameOrIndex, path: pluginPath }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      try { require.resolve(pluginPath); }
      catch (_) { return { error: 'require.resolve() failed for: ' + pluginPath }; }
      const list = readPlugins(app.asarPath);
      if (list.includes(pluginPath)) return { error: 'Already in list: ' + pluginPath };
      list.push(pluginPath);
      writePlugins(app.asarPath, list);
      return { added: pluginPath, total: list.length };
    },
  },
  {
    name: 'plugins_remove',
    description: 'Remove a plugin by 1-based index from an Electron app',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name or 1-based index' },
        index: { type: 'number', description: '1-based plugin index' },
      },
      required: ['app', 'index'],
    },
    handler: ({ app: nameOrIndex, index }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      const list = readPlugins(app.asarPath);
      const idx = index - 1;
      if (idx < 0 || idx >= list.length) return { error: 'Invalid plugin index: ' + index };
      const removed = list.splice(idx, 1)[0];
      writePlugins(app.asarPath, list);
      return { removed, total: list.length };
    },
  },
  {
    name: 'plugins_set',
    description: 'Replace the full plugin list for an Electron app',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name or 1-based index' },
        plugins: { type: 'array', items: { type: 'string' }, description: 'Array of plugin file paths' },
      },
      required: ['app', 'plugins'],
    },
    handler: ({ app: nameOrIndex, plugins }) => {
      const apps = discover();
      const app = resolveApp(apps, nameOrIndex);
      if (!app) return { error: 'App not found: ' + nameOrIndex };
      if (!Array.isArray(plugins)) return { error: 'plugins must be an array' };
      writePlugins(app.asarPath, plugins);
      return { total: plugins.length };
    },
  },
];

// ── Minimal reverse-client protocol ──────────────────────────────────────────

function connect(url) {
  let reconnectDelay = RECONNECT_MS;
  let closed = false;

  function start() {
    const ws = new WebSocket(url);

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
          const result = await entry.handler(msg.arguments || {});
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
