'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PATCH_START = '// === PODBAY PATCH START ===';
const PATCH_END = '// === PODBAY PATCH END ===';

function backupPath(asarPath) { return asarPath + '.backup'; }

/**
 * Portal status based on whether a backup file exists.
 * @param {string} asarPath
 * @returns {'open'|'closed'}
 */
function status(asarPath) {
  return fs.existsSync(backupPath(asarPath)) ? 'open' : 'closed';
}

/**
 * Create a backup of the ASAR (fails if backup already exists).
 * @param {string} asarPath
 */
function backup(asarPath) {
  const bp = backupPath(asarPath);
  if (fs.existsSync(bp)) {
    throw new Error('Backup already exists. Close the portal first.');
  }
  fs.copyFileSync(asarPath, bp);
}

/**
 * Restore the original ASAR from backup and remove the backup.
 * @param {string} asarPath
 */
function restore(asarPath) {
  const bp = backupPath(asarPath);
  if (!fs.existsSync(bp)) {
    throw new Error('No backup found — portal is already closed.');
  }
  fs.copyFileSync(bp, asarPath);
  fs.unlinkSync(bp);
}

/**
 * Extract app.asar to a temporary directory.
 * @param {string} asarPath
 * @param {string} dest
 */
function extract(asarPath, dest) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  execSync(`npx asar extract "${asarPath}" "${dest}"`, { stdio: 'pipe', timeout: 120000 });
}

/**
 * Repack an extracted directory back into an ASAR.
 * @param {string} src
 * @param {string} asarPath
 */
function repack(src, asarPath) {
  execSync(`npx asar pack "${src}" "${asarPath}"`, { stdio: 'pipe', timeout: 120000 });
}

/**
 * Locate WindowManager.js inside the extracted ASAR.
 * @param {string} dir - Extracted ASAR root
 * @returns {string|null}
 */
function findWindowManager(dir) {
  const candidates = [
    path.join(dir, 'js', 'window', 'WindowManager.js'),
    path.join(dir, 'WindowManager.js')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Write the portal payload file into the extracted ASAR and patch
 * WindowManager.js to load it in every renderer window at startup.
 * @param {string} dir - Extracted ASAR root
 * @param {string} payloadContent - JavaScript string to inject
 */
function patchWindowManager(dir, payloadContent) {
  const wmPath = findWindowManager(dir);
  if (!wmPath) throw new Error('WindowManager.js not found in ASAR');

  const payloadFile = 'podbay-portal.js';
  fs.writeFileSync(path.join(path.dirname(wmPath), payloadFile), payloadContent, 'utf8');

  let source = fs.readFileSync(wmPath, 'utf8');

  // Strip any existing patch
  while (source.includes(PATCH_START)) {
    const s = source.indexOf(PATCH_START);
    const e = source.indexOf(PATCH_END);
    if (e > s) {
      source = source.substring(0, s).trimEnd() + '\n' + source.substring(e + PATCH_END.length).trimStart();
    } else break;
  }

  // Build injection block
  const block = `
${PATCH_START}
    (function () {
      var fs = require('fs');
      var path = require('path');
      var __portalCode = fs.readFileSync(path.join(__dirname, '${payloadFile}'), 'utf8');
      window.webContents.on('did-finish-load', function () {
        window.webContents.executeJavaScript(__portalCode);
      });
    })();
${PATCH_END}`;

  // Insert before window.loadURL(url)
  const anchor = 'window.loadURL(url)';
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error('Could not find loadURL anchor in WindowManager.js');

  source = source.substring(0, idx) + block + '\n    ' + source.substring(idx);
  fs.writeFileSync(wmPath, source, 'utf8');
}

module.exports = { status, backup, restore, extract, repack, patchWindowManager, PATCH_START, PATCH_END };
