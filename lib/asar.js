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
 * Write the system plugin file into the extracted ASAR and patch
 * WindowManager.js to load it in every renderer window at startup.
 * The system plugin handles broker connection and injection requests —
 * no direct plugin loading from the main process.
 * @param {string} dir - Extracted ASAR root
 * @param {string} payloadContent - JavaScript string to inject (system plugin)
 * @param {string} resourcesDir - Path to the app's resources directory
 * @param {string} [name] - Client name for system plugin registration (opt-in flow)
 * @param {Object} [frameScripts] - Map of { urlPattern: scriptContent } for frame injection
 */
function patchWindowManager(dir, payloadContent, resourcesDir, name, frameScripts) {
  const wmPath = findWindowManager(dir);
  if (!wmPath) throw new Error('WindowManager.js not found in ASAR');

  const wmDir = path.dirname(wmPath);
  const payloadFile = 'podbay-portal.js';
  fs.writeFileSync(path.join(wmDir, payloadFile), payloadContent, 'utf8');

  // Write frame scripts alongside the portal payload
  const frameConfig = {};
  if (frameScripts && typeof frameScripts === 'object') {
    for (const [pattern, content] of Object.entries(frameScripts)) {
      const filename = 'podbay-frame-' + pattern.replace(/[^a-z0-9]/gi, '_') + '.js';
      fs.writeFileSync(path.join(wmDir, filename), content, 'utf8');
      frameConfig[pattern] = filename;
    }
    fs.writeFileSync(path.join(wmDir, 'podbay-frame-config.json'), JSON.stringify(frameConfig, null, 2), 'utf8');
  }

  let source = fs.readFileSync(wmPath, 'utf8');

  // Strip any existing patch
  while (source.includes(PATCH_START)) {
    const s = source.indexOf(PATCH_START);
    const e = source.indexOf(PATCH_END);
    if (e > s) {
      source = source.substring(0, s).trimEnd() + '\n' + source.substring(e + PATCH_END.length).trimStart();
    } else break;
  }

  // Build injection block — renderer bootstrap + frame injector
  const hasFrameScripts = Object.keys(frameConfig).length > 0;
  const frameInjectorCode = hasFrameScripts ? `
      // ── Frame Injector: inject scripts into matching child frames ──
      var __frameConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'podbay-frame-config.json'), 'utf8'));
      var __frameScriptCache = {};
      function __matchFrame(url) {
        for (var pattern in __frameConfig) {
          if (url.indexOf(pattern) !== -1) return pattern;
        }
        return null;
      }
      window.webContents.on('did-frame-navigate', function (_event, url, _httpStatus, _httpMsg, isMainFrame, frameProcessId, frameRoutingId) {
        if (isMainFrame) return;
        var matched = __matchFrame(url);
        if (!matched) return;
        var scriptFile = __frameConfig[matched];
        if (!__frameScriptCache[scriptFile]) {
          __frameScriptCache[scriptFile] = fs.readFileSync(path.join(__dirname, scriptFile), 'utf8');
        }
        console.log('[PodBay Frame Injector] Injecting into frame:', url, '→', scriptFile);
        // Find the frame by process/routing ID and inject
        var frames = window.webContents.mainFrame.frames || [];
        for (var i = 0; i < frames.length; i++) {
          if (frames[i].processId === frameProcessId && frames[i].routingId === frameRoutingId) {
            frames[i].executeJavaScript(__frameScriptCache[scriptFile]);
            console.log('[PodBay Frame Injector] Injection complete for', matched);
            return;
          }
        }
        // Fallback: try all non-main frames
        for (var j = 0; j < frames.length; j++) {
          if (frames[j].url && frames[j].url.indexOf(matched) !== -1) {
            frames[j].executeJavaScript(__frameScriptCache[scriptFile]);
            console.log('[PodBay Frame Injector] Injection complete (url match) for', matched);
            return;
          }
        }
        console.warn('[PodBay Frame Injector] Could not find frame for', matched);
      });` : '';

  const block = `
${PATCH_START}
    (function () {
      var fs = require('fs');
      var path = require('path');
      var __portalCode = fs.readFileSync(path.join(__dirname, '${payloadFile}'), 'utf8');
      window.webContents.on('did-finish-load', function () {
        var __namePrefix = '${name || ''}' ? 'var __podbayName = "${name || ''}";\\n' : '';
        window.webContents.executeJavaScript(__namePrefix + __portalCode);
      });${frameInjectorCode}
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
