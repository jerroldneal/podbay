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
 * @param {string} filename
 * @returns {object|null}
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
 * @param {string} filename
 * @param {object} pod - { name, description, plugins }
 */
function savePod(filename, pod) {
  if (!fs.existsSync(PODS_DIR)) fs.mkdirSync(PODS_DIR, { recursive: true });
  const { _file, ...data } = pod;
  fs.writeFileSync(path.join(PODS_DIR, filename), JSON.stringify(data, null, 2));
}

/**
 * Delete a pod file.
 * @param {string} filename
 * @returns {boolean}
 */
function deletePod(filename) {
  const filePath = path.join(PODS_DIR, filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Resolve all plugin code from a pod's plugin list.
 * Each plugin can specify code via: require, file, or code property.
 * @param {Array} plugins
 * @returns {Array<{type: string, code: string|null, description: string, dashboard: string|null, error: string|null}>}
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
      filePath: null,
      code: null,
      error: null,
    };
    try {
      if (p.code) {
        result.code = p.code;
      } else if (p.file) {
        result.filePath = p.file;
        if (!isDynamic) result.code = fs.readFileSync(p.file, 'utf8');
      } else if (p.require) {
        const resolved = require.resolve(p.require);
        result.filePath = path.relative(path.join(__dirname, '..'), resolved).replace(/\\/g, '/');
        if (!isDynamic) result.code = fs.readFileSync(resolved, 'utf8');
      }
    } catch (e) {
      result.error = e.message;
    }
    return result;
  });
}

/**
 * Get all resolved plugin code for all pods combined.
 * @returns {Array<{type: string, code: string, description: string, dashboard: string|null}>}
 */
function getAllPluginCode() {
  const pods = loadPods();
  const all = [];
  for (const pod of pods) {
    const resolved = resolvePlugins(pod.plugins);
    for (const r of resolved) {
      if (!r.error && (r.code || (r.id && !r.cache && r.filePath))) all.push(r);
    }
  }
  return all;
}

/**
 * Get resolved plugin code only for specific pod files.
 * @param {string[]} podFiles - Array of pod filenames (e.g. ['cwg-debug.pod', 'example.pod'])
 * @returns {Array<{type: string, code: string, description: string, dashboard: string|null}>}
 */
function getPluginCodeForPods(podFiles) {
  if (!Array.isArray(podFiles) || !podFiles.length) return [];
  const all = [];
  for (const file of podFiles) {
    const pod = getPod(file);
    if (!pod) continue;
    const resolved = resolvePlugins(pod.plugins);
    for (const r of resolved) {
      if (!r.error && (r.code || (r.id && !r.cache && r.filePath))) all.push(r);
    }
  }
  return all;
}

// ── App-to-pod mapping (app-pods.json) ──────────────────────────────────

/**
 * Load the app-pods mapping.
 * @returns {object} e.g. { "clubwpt-desktop": ["test-pod.pod"] }
 */
function loadAppPods() {
  try {
    return JSON.parse(fs.readFileSync(APP_PODS_PATH, 'utf8'));
  } catch (_) { return {}; }
}

/**
 * Save the app-pods mapping.
 */
function saveAppPods(mapping) {
  if (!fs.existsSync(PODS_DIR)) fs.mkdirSync(PODS_DIR, { recursive: true });
  fs.writeFileSync(APP_PODS_PATH, JSON.stringify(mapping, null, 2) + '\n');
}

/**
 * Get pod filenames assigned to an app.
 * @param {string} name - app name
 * @returns {string[]}
 */
function getAppPods(name) {
  if (!name) return [];
  const mapping = loadAppPods();
  return mapping[name] || [];
}

/**
 * Assign a pod to an app.
 */
function assignPod(name, podFile) {
  const mapping = loadAppPods();
  if (!mapping[name]) mapping[name] = [];
  if (!mapping[name].includes(podFile)) {
    mapping[name].push(podFile);
    saveAppPods(mapping);
  }
}

/**
 * Unassign a pod from an app.
 */
function unassignPod(name, podFile) {
  const mapping = loadAppPods();
  if (!mapping[name]) return;
  const idx = mapping[name].indexOf(podFile);
  if (idx >= 0) {
    mapping[name].splice(idx, 1);
    if (mapping[name].length === 0) delete mapping[name];
    saveAppPods(mapping);
  }
}

/**
 * Rename an app key in app-pods.json.
 */
function renameAppPods(oldName, newName) {
  const mapping = loadAppPods();
  if (mapping[oldName]) {
    mapping[newName] = mapping[oldName];
    delete mapping[oldName];
    saveAppPods(mapping);
  }
}

module.exports = { loadPods, getPod, savePod, deletePod, resolvePlugins, getAllPluginCode, getPluginCodeForPods, PODS_DIR, loadAppPods, saveAppPods, getAppPods, assignPod, unassignPod, renameAppPods };
