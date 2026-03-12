#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { discover } = require('./lib/discover');
const asar = require('./lib/asar');
const pods = require('./lib/pods');

const TAG = '[PodBay]';
const WORK_DIR = path.join(__dirname, '.work');
const PAYLOAD_PATH = path.join(__dirname, 'lib', 'portal-payload.js');
const SYSTEM_PLUGIN_PATH = path.join(__dirname, 'lib', 'system-plugin.js');

function log(...args) { console.log(TAG, ...args); }

/**
 * Open the pod bay doors — backup ASAR, inject portal payload, repack.
 * @param {string} asarPath
 */
function open(asarPath) {
  if (asar.status(asarPath) === 'open') {
    log('Already open for', asarPath);
    return;
  }

  const payload = fs.readFileSync(PAYLOAD_PATH, 'utf8');
  const resourcesDir = path.dirname(asarPath);

  log('Backing up ASAR...');
  asar.backup(asarPath);

  log('Extracting...');
  asar.extract(asarPath, WORK_DIR);

  log('Patching WindowManager...');
  asar.patchWindowManager(WORK_DIR, payload, resourcesDir);

  log('Repacking...');
  asar.repack(WORK_DIR, asarPath);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log('Portal opened. Restart the app to activate.');
}

/**
 * Close the pod bay doors — restore original ASAR from backup.
 * @param {string} asarPath
 */
function close(asarPath) {
  if (asar.status(asarPath) === 'closed') {
    log('Already closed for', asarPath);
    return;
  }

  log('Restoring original ASAR...');
  asar.restore(asarPath);
  log('Portal closed. Restart the app to deactivate.');
}

// ── Opt-In / Opt-Out (System Plugin model) ───────────────────────────────

/**
 * Opt-in an Electron app — inject system plugin via ASAR patch.
 * The system plugin connects to the broker and requests its injection bundle
 * from PodBay, replacing the old portal-payload approach.
 * @param {string} asarPath
 */
function optIn(asarPath) {
  if (asar.status(asarPath) === 'open') {
    log('Already opted-in for', asarPath);
    return;
  }

  const payload = fs.readFileSync(SYSTEM_PLUGIN_PATH, 'utf8');
  const resourcesDir = path.dirname(asarPath);

  log('Backing up ASAR...');
  asar.backup(asarPath);

  log('Extracting...');
  asar.extract(asarPath, WORK_DIR);

  log('Patching with system plugin...');
  asar.patchWindowManager(WORK_DIR, payload, resourcesDir);

  log('Repacking...');
  asar.repack(WORK_DIR, asarPath);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log('Opted-in. Restart the app to activate.');
}

/**
 * Opt-out an Electron app — restore original ASAR from backup.
 * @param {string} asarPath
 */
function optOut(asarPath) {
  if (asar.status(asarPath) === 'closed') {
    log('Already opted-out for', asarPath);
    return;
  }

  log('Restoring original ASAR...');
  asar.restore(asarPath);
  log('Opted-out. Restart the app to restore original behavior.');
}

// ── Plugin config helpers ────────────────────────────────────────────────

function pluginsPath(asarPath) {
  return path.join(path.dirname(asarPath), 'podbay-plugins.json');
}

function readPlugins(asarPath) {
  const p = pluginsPath(asarPath);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return []; }
}

function writePlugins(asarPath, list) {
  fs.writeFileSync(pluginsPath(asarPath), JSON.stringify(list, null, 2));
}

// ── Plugin CLI ───────────────────────────────────────────────────────────

function pluginAdd(rl, asarPath) {
  return new Promise(resolve => {
    rl.question('  Plugin path: ', answer => {
      const p = answer.trim();
      if (!p) { log('Cancelled.'); return resolve(); }
      try {
        require.resolve(p);
      } catch (_) {
        log('Invalid — require.resolve() failed for:', p);
        return resolve();
      }
      const list = readPlugins(asarPath);
      if (list.includes(p)) {
        log('Already in list:', p);
      } else {
        list.push(p);
        writePlugins(asarPath, list);
        log('Added:', p);
      }
      resolve();
    });
  });
}

function pluginList(rl, asarPath) {
  return new Promise(resolve => {
    const list = readPlugins(asarPath);
    if (!list.length) { log('No plugins configured.'); return resolve(); }
    console.log();
    list.forEach((p, i) => {
      let resolved = '';
      try { resolved = require.resolve(p); } catch (_) { resolved = '(unresolved)'; }
      console.log(`  ${i + 1}. ${p}`);
      if (resolved !== p) console.log(`     → ${resolved}`);
    });
    console.log();
    rl.question('  Select number for info (or Enter to go back): ', answer => {
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= list.length) return resolve();
      const entry = list[idx];
      let resolved, size;
      try {
        resolved = require.resolve(entry);
        size = fs.statSync(resolved).size;
      } catch (_) { resolved = '(unresolved)'; size = 0; }
      console.log(`\n  Path:     ${entry}`);
      console.log(`  Resolved: ${resolved}`);
      console.log(`  Size:     ${size} bytes\n`);
      resolve();
    });
  });
}

function pluginRemove(rl, asarPath) {
  return new Promise(resolve => {
    const list = readPlugins(asarPath);
    if (!list.length) { log('No plugins configured.'); return resolve(); }
    console.log();
    list.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    console.log();
    rl.question('  Remove number: ', answer => {
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= list.length) {
        log('Invalid selection.');
        return resolve();
      }
      const removed = list.splice(idx, 1)[0];
      writePlugins(asarPath, list);
      log('Removed:', removed);
      resolve();
    });
  });
}

// ── Resolve app by name or 1-based index ─────────────────────────────────

function resolveApp(apps, nameOrIndex) {
  const idx = parseInt(nameOrIndex, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= apps.length) return apps[idx - 1];
  return apps.find(a => a.name.toLowerCase() === nameOrIndex.toLowerCase()) || null;
}

// ── Non-interactive CLI ──────────────────────────────────────────────────

function cliList() {
  const apps = discover();
  const result = apps.map((a, i) => ({
    index: i + 1,
    name: a.name,
    status: asar.status(a.asarPath),
    plugins: readPlugins(a.asarPath).length,
    asarPath: a.asarPath,
  }));
  console.log(JSON.stringify(result, null, 2));
}

function cliOpen(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  open(app.asarPath);
}

function cliClose(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  close(app.asarPath);
}

function cliStatus(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  console.log(JSON.stringify({
    name: app.name,
    status: asar.status(app.asarPath),
    plugins: readPlugins(app.asarPath),
  }, null, 2));
}

function cliPluginsList(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  console.log(JSON.stringify(readPlugins(app.asarPath), null, 2));
}

function cliPluginsAdd(nameOrIndex, pluginPath) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  try { require.resolve(pluginPath); }
  catch (_) { log('Invalid — require.resolve() failed for:', pluginPath); process.exit(1); }
  const list = readPlugins(app.asarPath);
  if (list.includes(pluginPath)) { log('Already in list:', pluginPath); return; }
  list.push(pluginPath);
  writePlugins(app.asarPath, list);
  log('Added:', pluginPath);
}

function cliPluginsRemove(nameOrIndex, indexStr) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  const idx = parseInt(indexStr, 10) - 1;
  const list = readPlugins(app.asarPath);
  if (isNaN(idx) || idx < 0 || idx >= list.length) {
    log('Invalid plugin index:', indexStr);
    process.exit(1);
  }
  const removed = list.splice(idx, 1)[0];
  writePlugins(app.asarPath, list);
  log('Removed:', removed);
}

function cliPluginsSet(nameOrIndex, jsonStr) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  let list;
  try { list = JSON.parse(jsonStr); }
  catch (_) { log('Invalid JSON:', jsonStr); process.exit(1); }
  if (!Array.isArray(list)) { log('Plugin list must be an array'); process.exit(1); }
  writePlugins(app.asarPath, list);
  log('Plugin list updated:', list.length, 'plugin(s)');
}

function handleCli(args) {
  const cmd = args[0];
  switch (cmd) {
    case 'list':    return cliList();
    case 'open':    return cliOpen(args[1]);
    case 'close':   return cliClose(args[1]);
    case 'status':  return cliStatus(args[1]);
    case 'plugins': {
      const sub = args[1];
      switch (sub) {
        case 'list':   return cliPluginsList(args[2]);
        case 'add':    return cliPluginsAdd(args[2], args[3]);
        case 'remove': return cliPluginsRemove(args[2], args[3]);
        case 'set':    return cliPluginsSet(args[2], args[3]);
        default:
          log('Unknown plugins command:', sub);
          log('Usage: podbay plugins <list|add|remove|set> <app> [args]');
          process.exit(1);
      }
    }
    case 'pods': {
      const sub = args[1];
      switch (sub) {
        case 'list':
          console.log(JSON.stringify(pods.loadPods(), null, 2));
          return;
        case 'get':
          if (!args[2]) { log('Usage: podbay pods get <filename>'); process.exit(1); }
          const pod = pods.getPod(args[2]);
          if (!pod) { log('Pod not found:', args[2]); process.exit(1); }
          console.log(JSON.stringify(pod, null, 2));
          return;
        case 'delete':
          if (!args[2]) { log('Usage: podbay pods delete <filename>'); process.exit(1); }
          if (pods.deletePod(args[2])) log('Deleted:', args[2]);
          else { log('Pod not found:', args[2]); process.exit(1); }
          return;
        default:
          log('Unknown pods command:', sub);
          log('Usage: podbay pods <list|get|delete> [args]');
          process.exit(1);
      }
    }
    default:
      log('Unknown command:', cmd);
      log('Usage: podbay <list|open|close|status|plugins> [args]');
      process.exit(1);
  }
}

// ── Interactive CLI ─────────────────────────────────────────────────────────

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const apps = discover();
    if (!apps.length) {
      log('No Electron apps found.');
      process.exit(1);
    }

    console.log('\n  Open the Pod Bay\n');
    apps.forEach((app, i) => {
      const s = asar.status(app.asarPath);
      const pc = readPlugins(app.asarPath).length;
      const extra = pc ? ` (${pc} plugin${pc > 1 ? 's' : ''})` : '';
      console.log(`  ${i + 1}. ${app.name}  [${s}]${extra}`);
    });

    const pick = await ask(rl, '\nSelect app: ');
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= apps.length) {
      log('Invalid selection.');
      process.exit(1);
    }

    const app = apps[idx];
    const current = asar.status(app.asarPath);
    console.log(`\n  ${app.name} — ${current}\n`);
    console.log('  1. Open');
    console.log('  2. Close');
    console.log('  3. Add plugin');
    console.log('  4. List plugins');
    console.log('  5. Remove plugin');

    const action = await ask(rl, '\nAction: ');
    const a = action.trim();

    switch (a) {
      case '1': case 'open':  open(app.asarPath); break;
      case '2': case 'close': close(app.asarPath); break;
      case '3': case 'add':   await pluginAdd(rl, app.asarPath); break;
      case '4': case 'list':  await pluginList(rl, app.asarPath); break;
      case '5': case 'remove': await pluginRemove(rl, app.asarPath); break;
      default: log('Unknown action:', action);
    }
  } finally {
    rl.close();
  }
}

module.exports = { open, close, optIn, optOut, discover, readPlugins, writePlugins, pluginsPath, resolveApp, pods };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    handleCli(args);
  } else {
    interactive().catch(e => { console.error(TAG, e.message); process.exit(1); });
  }
}
