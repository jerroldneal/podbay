'use strict';

const fs = require('fs');
const path = require('path');

const PODS_DIR = path.join(__dirname, '..', 'pods');

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
    const result = {
      type: p.type || 'unknown',
      description: p.description || '',
      dashboard: p.dashboard || null,
      code: null,
      error: null,
    };
    try {
      if (p.code) {
        result.code = p.code;
      } else if (p.file) {
        result.code = fs.readFileSync(p.file, 'utf8');
      } else if (p.require) {
        const resolved = require.resolve(p.require);
        result.code = fs.readFileSync(resolved, 'utf8');
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
      if (r.code && !r.error) all.push(r);
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
      if (r.code && !r.error) all.push(r);
    }
  }
  return all;
}

module.exports = { loadPods, getPod, savePod, deletePod, resolvePlugins, getAllPluginCode, getPluginCodeForPods, PODS_DIR };
