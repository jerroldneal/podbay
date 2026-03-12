#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { discover } = require('./lib/discover');
const asar = require('./lib/asar');

const TAG = '[PodBay]';
const WORK_DIR = path.join(__dirname, '.work');
const PAYLOAD_PATH = path.join(__dirname, 'lib', 'portal-payload.js');

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

// ── CLI ──────────────────────────────────────────────────────────────────────

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function main() {
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

module.exports = { open, close, discover, readPlugins, writePlugins, pluginsPath };

if (require.main === module) {
  main().catch(e => { console.error(TAG, e.message); process.exit(1); });
}
