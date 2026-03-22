'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PATCH_START = '// === PODBAY PATCH START ===';
const PATCH_END = '// === PODBAY PATCH END ===';

function backupPath(asarPath) { return asarPath + '.backup'; }

function status(asarPath) {
  return fs.existsSync(backupPath(asarPath)) ? 'open' : 'closed';
}

function backup(asarPath) {
  const bp = backupPath(asarPath);
  if (fs.existsSync(bp)) {
    throw new Error('Backup already exists. Close the portal first.');
  }
  fs.copyFileSync(asarPath, bp);
}

function restore(asarPath) {
  const bp = backupPath(asarPath);
  if (!fs.existsSync(bp)) {
    throw new Error('No backup found — portal is already closed.');
  }
  fs.copyFileSync(bp, asarPath);
  fs.unlinkSync(bp);
}

function extract(asarPath, dest) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  execSync(`npx asar extract "${asarPath}" "${dest}"`, { stdio: 'pipe', timeout: 120000 });
}

function repack(src, asarPath) {
  execSync(`npx asar pack "${src}" "${asarPath}"`, { stdio: 'pipe', timeout: 120000 });
}

function findWindowManager(dir) {
  const candidates = [
    path.join(dir, 'js', 'window', 'WindowManager.js'),
    path.join(dir, 'WindowManager.js')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Write the bootstrap payload into the extracted ASAR and patch
 * WindowManager.js to load it in every renderer window at startup.
 * @param {string} dir - Extracted ASAR directory
 * @param {string} payloadContent - Bootstrap payload JS
 * @param {string} resourcesDir - Path to the app's resources directory
 * @param {string} [name] - Client name for system plugin registration
 * @param {Object} [frameClients] - Map of { urlPattern: clientName } for frame injection
 */
function patchWindowManager(dir, payloadContent, resourcesDir, name, frameClients) {
  const wmPath = findWindowManager(dir);
  if (!wmPath) throw new Error('WindowManager.js not found in ASAR');

  const wmDir = path.dirname(wmPath);
  const payloadFile = 'podbay-portal.js';
  fs.writeFileSync(path.join(wmDir, payloadFile), payloadContent, 'utf8');

  // Frame client support — frames become reverse clients with standard tools
  const frameConfig = {};
  if (frameClients && typeof frameClients === 'object') {
    Object.assign(frameConfig, frameClients);
  }
  if (Object.keys(frameConfig).length > 0) {
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
  const hasFrameClients = Object.keys(frameConfig).length > 0;
  const frameInjectorCode = hasFrameClients ? `
      // ── Frame Injector: frames become reverse clients with standard bootstrap ──
      var __frameConfig = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, 'podbay-frame-config.json'), 'utf8'));
      var __frameNames = {};
      var __frameCounter = 0;

      function __matchFrame(url) {
        for (var p in __frameConfig) {
          if (url.indexOf(p) !== -1) return p;
        }
        return null;
      }

      window.webContents.on('did-frame-navigate', function (_event, url, _httpStatus, _httpMsg, isMainFrame, frameProcessId, frameRoutingId) {
        if (isMainFrame) return;
        var matched = __matchFrame(url);
        if (!matched) return;
        var frameKey = frameProcessId + ':' + frameRoutingId;
        var clientName;
        if (__frameNames[frameKey]) {
          clientName = __frameNames[frameKey];
        } else {
          __frameCounter++;
          clientName = __frameConfig[matched] + '-' + __frameCounter;
          __frameNames[frameKey] = clientName;
        }
        console.log('[PodBay] Frame matched:', matched, '→ client:', clientName, '(key:', frameKey + ')');
        var frames = window.webContents.mainFrame.framesInSubtree;
        for (var i = 0; i < frames.length; i++) {
          if (frames[i].url === url && frames[i] !== window.webContents.mainFrame) {
            var frameCode = 'var __podbayName = "' + clientName + '";\\n' + __portalCode;
            frames[i].executeJavaScript(frameCode).catch(function (err) {
              console.log('[PodBay] Frame bootstrap error (' + clientName + '):', err.message);
            });
            // Register frame client in parent renderer's registry
            var regPayload = JSON.stringify({ url: url, ts: new Date().toISOString() });
            window.webContents.executeJavaScript(
              'if (!window.__podbayFrameClients) window.__podbayFrameClients = {};' +
              'window.__podbayFrameClients[' + JSON.stringify(clientName) + '] = ' + regPayload + ';'
            ).catch(function () {});
            console.log('[PodBay] Injected bootstrap into frame:', clientName, url);
            break;
          }
        }
      });` : '';

  const block = `
${PATCH_START}
    (function () {
      var fs = require('fs');
      var path = require('path');
      var Menu = require('electron').Menu;
      var __portalCode = fs.readFileSync(path.join(__dirname, '${payloadFile}'), 'utf8');

      // Force-show menu bar with standard Electron menus (includes View > Toggle Developer Tools)
      try {
        window.setMenuBarVisibility(true);
        window.setAutoHideMenuBar(false);
        Menu.setApplicationMenu(Menu.buildFromTemplate([
          { role: 'fileMenu' },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' }
        ]));
      } catch (_) {}

      // Intercept keyboard shortcuts to open DevTools (F12, Ctrl+Shift+I)
      // This fires before the page can suppress the key event
      window.webContents.on('before-input-event', function (event, input) {
        if (input.key === 'F12' ||
            (input.control && input.shift && input.key.toLowerCase() === 'i')) {
          window.webContents.toggleDevTools();
          event.preventDefault();
        }
      });

      // Console-message IPC bridge — renderer sends commands via console.log('__podbay_cmd:...')
      // This allows the renderer (and any broker client via the inspect tool) to trigger
      // main-process actions like opening DevTools without needing ipcRenderer
      window.webContents.on('console-message', function (event, level, message) {
        if (typeof message === 'string' && message.indexOf('__podbay_cmd:') === 0) {
          var cmd = message.substring('__podbay_cmd:'.length);
          if (cmd === 'devtools' || cmd === 'devtools_detach') {
            window.webContents.openDevTools({ mode: 'detach' });
          } else if (cmd === 'devtools_right') {
            window.webContents.openDevTools({ mode: 'right' });
          } else if (cmd === 'devtools_bottom') {
            window.webContents.openDevTools({ mode: 'bottom' });
          } else if (cmd === 'devtools_close') {
            window.webContents.closeDevTools();
          }
        }
      });

      window.webContents.on('did-finish-load', function () {
        var __namePrefix = '${name || ''}' ? 'var __podbayName = "${name || ''}";\\n' : '';
        window.webContents.executeJavaScript(__namePrefix + __portalCode);
      });${frameInjectorCode}
    })();
${PATCH_END}`;

  const anchor = 'window.loadURL(url)';
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error('Could not find loadURL anchor in WindowManager.js');

  source = source.substring(0, idx) + block + '\n    ' + source.substring(idx);
  fs.writeFileSync(wmPath, source, 'utf8');
}

module.exports = { status, backup, restore, extract, repack, patchWindowManager, PATCH_START, PATCH_END };
