'use strict';

const fs = require('fs');
const path = require('path');

// Common Electron install locations on Windows
const SEARCH_ROOTS = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  process.env.PROGRAMFILES,
  process.env['PROGRAMFILES(X86)']
].filter(Boolean);

// Additional search roots (e.g. Docker volume mounts) via PODBAY_SEARCH_ROOTS
if (process.env.PODBAY_SEARCH_ROOTS) {
  const sep = process.env.PODBAY_SEARCH_ROOTS.includes(';') ? ';' : ',';
  process.env.PODBAY_SEARCH_ROOTS.split(sep)
    .map(s => s.trim()).filter(Boolean)
    .forEach(r => SEARCH_ROOTS.push(r));
}

/**
 * Scan known directories for installed Electron apps (those containing app.asar).
 * @returns {Array<{name: string, asarPath: string}>}
 */
function discover() {
  const found = [];
  for (const root of SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let dirs;
    try { dirs = fs.readdirSync(root); } catch (_) { continue; }
    for (const dir of dirs) {
      const asar = path.join(root, dir, 'resources', 'app.asar');
      if (fs.existsSync(asar)) {
        found.push({ name: dir, asarPath: asar });
      }
    }
  }
  return found;
}

module.exports = { discover };
