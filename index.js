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

  log('Backing up ASAR...');
  asar.backup(asarPath);

  log('Extracting...');
  asar.extract(asarPath, WORK_DIR);

  log('Patching WindowManager...');
  asar.patchWindowManager(WORK_DIR, payload);

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
      console.log(`  ${i + 1}. ${app.name}  [${s}]`);
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

    const action = await ask(rl, 'Open or Close? ');
    const a = action.trim().toLowerCase();

    if (a === 'open') open(app.asarPath);
    else if (a === 'close') close(app.asarPath);
    else log('Unknown action:', action);
  } finally {
    rl.close();
  }
}

module.exports = { open, close, discover };

if (require.main === module) {
  main().catch(e => { console.error(TAG, e.message); process.exit(1); });
}
