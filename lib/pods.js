'use strict';

const fs = require('fs');
const path = require('path');

const PODS_DIR = path.join(__dirname, '..', 'pods');
const APP_PODS_PATH = path.join(PODS_DIR, 'app-pods.json');

/**
 * Read and parse all .pod files from the pods directory.
 * @returns {Array<{name: string, description: string, plugins: Array, _file: string}>}
 */
function loadPods() {
  if (!fs.existsSync(PODS_DIR)) return [];
  const files = fs.readdirSync(PODS_DIR).filter(f => f.endsWith('.pod'));
  const pods = [];
  for (const file of files) {
    const filePath = path.join(PODS_DIR, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const pod = JSON.parse(raw);
      pod._file = file;
      pods.push(pod);
    } catch (e) {
      console.error('[PodBay] Failed to parse pod file:', file, e.message);
    }
  }
  return pods;
}

/**
 * Get a single pod by filename.
 */
function getPod(filename) {
  const filePath = path.join(PODS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    const pod = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    pod._file = filename;
    return pod;
  } catch (_) { return null; }
}

/**
 * Save a pod to a .pod file.
 */
function savePod(filename, pod) {
  if (!fs.existsSync(PODS_DIR)) fs.mkdirSync(PODS_DIR, { recursive: true });
  const { _file, ...data } = pod;
  fs.writeFileSync(path.join(PODS_DIR, filename), JSON.stringify(data, null, 2));
}

/**
 * Delete a pod file.
 */
function deletePod(filename) {
  const filePath = path.join(PODS_DIR, filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Resolve all plugin code from a pod's plugin list.
 * Each plugin can specify code via: resolve, file, code, and/or require properties.
 *
 * Properties (all optional, combinable):
 *   - file:    string | string[]  — read code from file(s) on disk
 *   - code:    string | string[]  — inline code string(s)
 *   - require: string | string[]  — auto-generate require() calls (browser-side)
 *   - resolve: string             — Node.js require.resolve() to find a file path
 *
 * When combined, the final code is assembled in order: require → file → code.
 *
 * NOTE: the `id` field is OPTIONAL. Every plugin is
 * auto-registered by its `type` name in the inject handler. The `id`
 * field is only needed if you want a different module name than the type.
 */
function resolvePlugins(plugins) {
  if (!Array.isArray(plugins)) return [];
  return plugins.map(p => {
    const isDynamic = p.id && p.cache !== true;
    const result = {
      type: p.type || 'unknown',
      description: p.description || '',
      dashboard: p.dashboard || null,
      id: p.id || null,
      cache: p.cache === true,
      mandatory: p.mandatory === true,
      filePath: null,
      code: null,
      error: null,
    };
    try {
      const codeParts = [];

      // 1. require: generate require() statements (browser-side)
      if (p.require) {
        const reqs = Array.isArray(p.require) ? p.require : [p.require];
        for (const r of reqs) {
          codeParts.push("var " + r.replace(/[^a-zA-Z0-9_$]/g, '_') + " = require('" + r + "');");
        }
      }

      // 2. file: read code from file(s)
      if (p.file) {
        const files = Array.isArray(p.file) ? p.file : [p.file];
        result.filePath = files[0]; // primary file path for reference
        if (!isDynamic) {
          const workspaceRoot = path.join(__dirname, '..');
          for (const f of files) {
            const filePath = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
            codeParts.push(fs.readFileSync(filePath, 'utf8'));
          }
        }
      }

      // 3. code: inline code string(s)
      if (p.code) {
        const codes = Array.isArray(p.code) ? p.code : [p.code];
        for (const c of codes) {
          codeParts.push(c);
        }
      }

      // 4. resolve: Node.js require.resolve() to find a file (legacy/advanced)
      if (!p.file && !p.code && !p.require && p.resolve) {
        const resolved = require.resolve(p.resolve);
        result.filePath = path.relative(path.join(__dirname, '..'), resolved).replace(/\\/g, '/');
        if (!isDynamic) codeParts.push(fs.readFileSync(resolved, 'utf8'));
      }

      if (codeParts.length) {
        result.code = codeParts.join('\n');
      }
    } catch (e) {
      result.error = e.message;
    }
    return result;
  });
}

/**
 * Get resolved plugin code only for specific pod files.
 */
function getPluginCodeForPods(podFiles) {
  if (!Array.isArray(podFiles) || !podFiles.length) return [];
  const all = [];
  for (const file of podFiles) {
    const pod = getPod(file);
    if (!pod) continue;

    // Implied broker-client-sdk: auto-prepend if not explicitly declared
    let plugins = pod.plugins || [];
    const hasSdk = plugins.some(p => p.type === 'broker-client-sdk');
    if (!hasSdk) {
      plugins = [
        { type: 'broker-client-sdk', file: 'plugins/broker-client-sdk.js' },
        ...plugins
      ];
    }

    const resolved = resolvePlugins(plugins);
    for (const r of resolved) {
      // Include valid plugins, or plugins with errors so errors can be reported
      if (r.code || r.error || (r.id && !r.cache && r.filePath)) {
        all.push(r);
      }
    }
  }
  return all;
}

// ── App-to-pod mapping ──────────────────────────────────────────────────

function loadAppPods() {
  try {
    return JSON.parse(fs.readFileSync(APP_PODS_PATH, 'utf8'));
  } catch (_) { return {}; }
}

function saveAppPods(mapping) {
  if (!fs.existsSync(PODS_DIR)) fs.mkdirSync(PODS_DIR, { recursive: true });
  fs.writeFileSync(APP_PODS_PATH, JSON.stringify(mapping, null, 2) + '\n');
}

function getAppPods(name) {
  if (!name) return [];
  const mapping = loadAppPods();
  return mapping[name] || [];
}

function assignPod(name, podFile) {
  const mapping = loadAppPods();
  if (!mapping[name]) mapping[name] = [];
  if (!mapping[name].includes(podFile)) mapping[name].push(podFile);
  saveAppPods(mapping);
}

function unassignPod(name, podFile) {
  const mapping = loadAppPods();
  if (!mapping[name]) return;
  mapping[name] = mapping[name].filter(f => f !== podFile);
  if (!mapping[name].length) delete mapping[name];
  saveAppPods(mapping);
}

function renameAppPods(oldName, newName) {
  const mapping = loadAppPods();
  if (!mapping[oldName]) return;
  mapping[newName] = mapping[oldName];
  delete mapping[oldName];
  saveAppPods(mapping);
}

module.exports = {
  loadPods,
  getPod,
  savePod,
  deletePod,
  resolvePlugins,
  getPluginCodeForPods,
  getAppPods,
  assignPod,
  unassignPod,
  renameAppPods,
};
