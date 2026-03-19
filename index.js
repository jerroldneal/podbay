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
const BOOTSTRAP_PATH = path.join(__dirname, 'lib', 'bootstrap.js');
const REGISTRY_PATH = path.join(__dirname, '.opted-in.json');

function log(...args) { console.log(TAG, ...args); }

// ── Path matching (cross-environment) ─────────────────────────────────────

/**
 * Extract the app folder name from an ASAR path.
 * Handles both Windows paths (C:\...\clubwpt-desktop\resources\app.asar)
 * and Docker paths (/host/programs/clubwpt-desktop/resources/app.asar).
 */
function appFolderName(asarPath) {
  if (!asarPath) return null;
  const normalized = asarPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const resIdx = parts.lastIndexOf('resources');
  return resIdx > 0 ? parts[resIdx - 1] : null;
}

/**
 * Compare two ASAR paths for logical equality, tolerating Windows vs Docker
 * path prefix differences (e.g. C:\Users\...\Programs vs /host/programs).
 */
function sameAsarPath(a, b) {
  if (a === b) return true;
  const fa = appFolderName(a);
  const fb = appFolderName(b);
  return Boolean(fa && fb && fa === fb);
}

// ── Name helpers ─────────────────────────────────────────────────────────

/**
 * Normalize an app directory name into a valid client name.
 * e.g. "ClubWPT Gold" → "clubwpt-gold"
 */
function normalizeName(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'app';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a client name: lowercase alphanumeric + hyphens, not blank.
 */
function validateName(name) {
  if (!name) return 'Name cannot be blank';
  if (!NAME_RE.test(name)) return 'Name must be lowercase letters, digits, and hyphens (no leading/trailing hyphen)';
  return null;
}

// ── Name registry (uniqueness tracking & pod assignments) ────────────────

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    // Migrate legacy formats: string → { asarPath }, object with pods → { asarPath }
    const reg = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        reg[k] = { asarPath: v };
      } else if (v && v.asarPath) {
        reg[k] = { asarPath: v.asarPath };
      }
    }
    return reg;
  }
  catch (_) { return {}; }
}

function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ── Pod-to-app mapping (delegated to pods module) ───────────────────────

function getAppPods(name) {
  return pods.getAppPods(name);
}

function assignPod(name, podFile) {
  const reg = loadRegistry();
  if (!reg[name]) throw new Error(`App "${name}" is not opted-in`);
  pods.assignPod(name, podFile);
}

function unassignPod(name, podFile) {
  const reg = loadRegistry();
  if (!reg[name]) throw new Error(`App "${name}" is not opted-in`);
  pods.unassignPod(name, podFile);
}

function renameApp(oldName, newName) {
  const err = validateName(newName);
  if (err) throw new Error(err);
  const reg = loadRegistry();
  if (!reg[oldName]) throw new Error(`App "${oldName}" is not opted-in`);
  if (reg[newName]) throw new Error(`Name "${newName}" is already taken`);
  reg[newName] = reg[oldName];
  delete reg[oldName];
  saveRegistry(reg);
  // Rename in app-pods.json too
  pods.renameAppPods(oldName, newName);
}

// ── Opt-In / Opt-Out (System Plugin model) ───────────────────────────────

/**
 * Opt-in an Electron app — inject system plugin via ASAR patch.
 * The system plugin connects to the broker and requests its injection bundle
 * from PodBay, replacing the old portal-payload approach.
 * @param {string} asarPath
 * @param {string} name - Required client name (lowercase alphanumeric + hyphens)
 * @param {function} [onProgress] - Optional callback: (step, progress, total) => void
 */
function optIn(asarPath, name, onProgress) {
  const err = validateName(name);
  if (err) throw new Error(err);

  const reg = loadRegistry();
  if (reg[name] && !sameAsarPath(reg[name].asarPath, asarPath)) {
    throw new Error(`Name "${name}" is already used by another app`);
  }

  if (asar.status(asarPath) === 'open') {
    log('Already opted-in for', asarPath);
    return;
  }

  const payload = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
  const resourcesDir = path.dirname(asarPath);

  onProgress?.('backup', 1, 5);
  log('Backing up ASAR...');
  asar.backup(asarPath);

  onProgress?.('extract', 2, 5);
  log('Extracting...');
  asar.extract(asarPath, WORK_DIR);

  onProgress?.('patch', 3, 5);
  log('Patching with bootstrap...');
  asar.patchWindowManager(WORK_DIR, payload, resourcesDir, name);

  onProgress?.('repack', 4, 5);
  log('Repacking...');
  asar.repack(WORK_DIR, asarPath);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  // Remove any existing entry for this asarPath under a different name
  for (const [n, entry] of Object.entries(reg)) {
    if (n !== name && sameAsarPath(entry.asarPath, asarPath)) { delete reg[n]; }
  }
  reg[name] = { asarPath };
  saveRegistry(reg);

  onProgress?.('done', 5, 5);
  log('Opted-in as', name + '. Restart the app to activate.');
}

/**
 * Opt-out an Electron app — restore original ASAR from backup.
 * @param {string} asarPath
 * @param {function} [onProgress] - Optional callback: (step, progress, total) => void
 */
function optOut(asarPath, onProgress) {
  if (asar.status(asarPath) === 'closed') {
    log('Already opted-out for', asarPath);
    return;
  }

  onProgress?.('restore', 1, 2);
  log('Restoring original ASAR...');
  asar.restore(asarPath);

  const reg = loadRegistry();
  for (const [n, entry] of Object.entries(reg)) {
    if (sameAsarPath(entry.asarPath, asarPath)) { delete reg[n]; }
  }
  saveRegistry(reg);

  onProgress?.('done', 2, 2);
  log('Opted-out. Restart the app to restore original behavior.');
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
  const reg = loadRegistry();
  const result = apps.map((a, i) => {
    const name = Object.entries(reg).find(([, p]) => p && sameAsarPath(p.asarPath, a.asarPath));
    return {
      index: i + 1,
      name: a.name,
      status: asar.status(a.asarPath),
      asarPath: a.asarPath,
      registeredName: name ? name[0] : null,
    };
  });
  console.log(JSON.stringify(result, null, 2));
}

function cliStatus(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  const reg = loadRegistry();
  const entry = Object.entries(reg).find(([, p]) => p && sameAsarPath(p.asarPath, app.asarPath));
  console.log(JSON.stringify({
    name: app.name,
    status: asar.status(app.asarPath),
    registeredName: entry ? entry[0] : null,
    pods: pods.getAppPods(entry ? entry[0] : null),
  }, null, 2));
}

function cliOptIn(nameOrIndex, name) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  if (!name) name = normalizeName(app.name);
  optIn(app.asarPath, name);
}

function cliOptOut(nameOrIndex) {
  const apps = discover();
  const app = resolveApp(apps, nameOrIndex);
  if (!app) { log('App not found:', nameOrIndex); process.exit(1); }
  optOut(app.asarPath);
}

function handleCli(args) {
  const cmd = args[0];
  switch (cmd) {
    case 'list': return cliList();
    case 'opt-in': return cliOptIn(args[1], args[2]);
    case 'opt-out': return cliOptOut(args[1]);
    case 'status': return cliStatus(args[1]);
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
        case 'assign':
          if (!args[2] || !args[3]) { log('Usage: podbay pods assign <app-name> <pod-filename>'); process.exit(1); }
          if (!pods.getPod(args[3])) { log('Pod not found:', args[3]); process.exit(1); }
          try { assignPod(args[2], args[3]); log('Assigned', args[3], 'to', args[2]); }
          catch (e) { log(e.message); process.exit(1); }
          return;
        case 'unassign':
          if (!args[2] || !args[3]) { log('Usage: podbay pods unassign <app-name> <pod-filename>'); process.exit(1); }
          try { unassignPod(args[2], args[3]); log('Unassigned', args[3], 'from', args[2]); }
          catch (e) { log(e.message); process.exit(1); }
          return;
        case 'app':
          if (!args[2]) { log('Usage: podbay pods app <app-name>'); process.exit(1); }
          console.log(JSON.stringify({ app: args[2], pods: getAppPods(args[2]) }, null, 2));
          return;
        default:
          log('Unknown pods command:', sub);
          log('Usage: podbay pods <list|get|delete|assign|unassign|app> [args]');
          process.exit(1);
      }
    }
    default:
      log('Unknown command:', cmd);
      log('Usage: podbay <list|opt-in|opt-out|status|pods> [args]');
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
    const defaultName = normalizeName(app.name);
    console.log(`\n  ${app.name} — ${current}\n`);
    console.log('  1. Opt-In');
    console.log('  2. Opt-Out');
    console.log('  3. Assign pods');

    const action = await ask(rl, '\nAction: ');
    const a = action.trim();

    switch (a) {
      case '1': case 'opt-in': {
        const input = (await ask(rl, `  Name [${defaultName}]: `)).trim();
        const name = input || defaultName;
        const err = validateName(name);
        if (err) { log(err); break; }
        optIn(app.asarPath, name);
        break;
      }
      case '2': case 'opt-out': optOut(app.asarPath); break;
      case '3': case 'pods': {
        const reg = loadRegistry();
        const entry = Object.entries(reg).find(([, v]) => v && sameAsarPath(v.asarPath, app.asarPath));
        if (!entry) { log('App must be opted-in first.'); break; }
        const name = entry[0];
        const appPods = getAppPods(name);
        const allPods = pods.loadPods();
        console.log(`\n  Pods assigned to ${name}:`);
        if (!appPods.length) console.log('    (none)');
        else appPods.forEach(p => console.log(`    - ${p}`));
        console.log('\n  Available pods:');
        allPods.forEach(p => console.log(`    - ${p._file}  (${p.name})`));
        const podFile = (await ask(rl, '\n  Assign/unassign pod file (or Enter to go back): ')).trim();
        if (!podFile) break;
        if (appPods.includes(podFile)) {
          unassignPod(name, podFile);
          log('Unassigned:', podFile);
        } else {
          if (!pods.getPod(podFile)) { log('Pod not found:', podFile); break; }
          assignPod(name, podFile);
          log('Assigned:', podFile);
        }
        break;
      }
      default: log('Unknown action:', action);
    }
  } finally {
    rl.close();
  }
}

module.exports = { optIn, optOut, normalizeName, validateName, discover, resolveApp, pods, getAppPods, assignPod, unassignPod, renameApp, loadRegistry };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    handleCli(args);
  } else {
    interactive().catch(e => { console.error(TAG, e.message); process.exit(1); });
  }
}
