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
 * Also sets up plugin loading from podbay-plugins.json and an IPC
 * channel (via console-message) for the renderer to persist plugin changes.
 * @param {string} dir - Extracted ASAR root
 * @param {string} payloadContent - JavaScript string to inject
 * @param {string} resourcesDir - Path to the app's resources directory (where podbay-plugins.json lives)
 * @param {string} [name] - Client name for system plugin registration (opt-in flow)
 */
function patchWindowManager(dir, payloadContent, resourcesDir, name) {
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

  // Normalize resourcesDir for embedding in code (escape backslashes for JS string)
  const escapedResourcesDir = resourcesDir.replace(/\\/g, '\\\\');

  // Build injection block
  const block = `
${PATCH_START}
    (function () {
      var fs = require('fs');
      var path = require('path');
      var __portalCode = fs.readFileSync(path.join(__dirname, '${payloadFile}'), 'utf8');
      var __pluginsFile = path.join('${escapedResourcesDir}', 'podbay-plugins.json');
      var __plugins = [];
      try { __plugins = JSON.parse(fs.readFileSync(__pluginsFile, 'utf8')); } catch (_) {}
      // Pod-based plugins
      var __podsDir = path.join('${escapedResourcesDir}', '..', 'pods');
      var __podPlugins = [];
      try {
        if (fs.existsSync(__podsDir)) {
          var podFiles = fs.readdirSync(__podsDir).filter(function(f) { return f.endsWith('.pod'); });
          podFiles.forEach(function(f) {
            try {
              var pod = JSON.parse(fs.readFileSync(path.join(__podsDir, f), 'utf8'));
              if (Array.isArray(pod.plugins)) {
                pod.plugins.forEach(function(pl) {
                  if (pl.code) __podPlugins.push({ code: pl.code, type: pl.type || 'unknown' });
                  else if (pl.file) {
                    try { __podPlugins.push({ code: fs.readFileSync(pl.file, 'utf8'), type: pl.type || 'file' }); }
                    catch (fe) { console.error('[PodBay] Pod plugin file failed:', pl.file, fe.message); }
                  }
                });
              }
            } catch (pe) { console.error('[PodBay] Pod parse failed:', f, pe.message); }
          });
        }
      } catch (_) {}
      window.webContents.on('did-finish-load', function () {
        var __namePrefix = '${name || ''}' ? 'var __podbayName = "${name || ''}";\\n' : '';
        window.webContents.executeJavaScript(__namePrefix + __portalCode);
        __plugins.forEach(function (p) {
          try {
            var code = fs.readFileSync(p.trim(), 'utf8');
            window.webContents.executeJavaScript(code);
          } catch (e) { console.error('[PodBay] Plugin load failed:', p, e.message); }
        });
        __podPlugins.forEach(function (pp) {
          try { window.webContents.executeJavaScript(pp.code); }
          catch (e) { console.error('[PodBay] Pod plugin exec failed:', pp.type, e.message); }
        });
      });
      window.webContents.on('console-message', function (_ev, _level, message) {
        if (typeof message === 'string' && message.indexOf('__PODBAY_SET_PLUGINS__:') === 0) {
          try {
            var list = JSON.parse(message.substring('__PODBAY_SET_PLUGINS__:'.length));
            fs.writeFileSync(__pluginsFile, JSON.stringify(list, null, 2));
          } catch (_) {}
        }
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
