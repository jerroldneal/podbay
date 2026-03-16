# PodBay Plugin Injection — End-to-End Walkthrough

> **Question answered**: Can an asar-based app opt in, select pods to inject plugins, and have those plugins `require()` dependencies loaded from the host?
>
> **Answer: Yes — all three conditions are confirmed.**

---

## Layer 1: Opt-In (ASAR patch)

`lib/asar.js` patches the target Electron app:

1. Creates a backup of `app.asar`
2. Extracts the asar to a temp directory
3. Injects `lib/portal-payload.js` at the top of the renderer entry point
4. Repacks the asar

On next launch the patched app connects to the PodBay broker via WebSocket using its `clientId`.

**Key file:** `lib/asar.js`

---

## Layer 2: Pod Selection (dashboard assignment)

Once an app is opted in it appears in the PodBay dashboard. The user assigns pods to it:

- **UI:** `dashboard.html` calls `podbay__pods_assign` with `{ name, pod }`
- **Storage:** `index.js` → `assignPod()` writes the assignment to the app registry
- **Retrieval:** at inject time, `getAppPods(clientId)` returns the array of assigned pod filenames

```js
// index.js
function getAppPods(name) { ... }  // returns e.g. ['cwg-plugin-library.pod', 'cwg-debug.pod']
```

**Key files:** `dashboard.html`, `index.js`

---

## Layer 3: Plugin Resolution (host file reads)

`lib/pods.js` resolves the actual plugin source code from the host filesystem:

```
getPluginCodeForPods(podFiles)
  → for each pod file: readFileSync(pod)
  → resolvePlugins(pod.plugins)
    → for each plugin entry:
        if p.code  → use inline code
        if p.file  → readFileSync(p.file)       ← from host /app/plugins/ (Docker mount)
        if p.require → require.resolve + readFileSync
      → return { type, description, id, code }  ← id field passed through
```

The `id` field is preserved verbatim:

```js
// lib/pods.js — resolvePlugins()
id: p.id || null,
```

Docker mount provides the host paths:
```
./lib:/app/lib:rw
./plugins:/app/plugins:rw
./pods:/app/pods:rw
```

**Key file:** `lib/pods.js`

---

## Layer 4: Bundle Assembly (dual-mode wrapping)

`reverse-client.js` maps over all resolved plugins and wraps them differently based on whether they have an `id` field:

### Lib module (has `id`) — pre-registered in `require.cache`

```js
// reverse-client.js — inject handler
if (p.id) {
  body = 'try { (function () {\n'
    + 'var __m = { exports: {}, id: \'' + safeId + '\', loaded: false };\n'
    + '(function (module, exports) {\n'
    + p.code + '\n'
    + '})(__m, __m.exports);\n'
    + '__m.loaded = true;\n'
    + 'if (window.require && window.require.cache) window.require.cache[\'' + safeId + '\'] = __m;\n'
    + '})(); }'
    + ' catch (__e) { console.error("[PodBay] lib error [...]:", __e && __e.message); }';
}
```

This runs the plugin code inside a CommonJS-style wrapper, then registers the resulting module object at `window.require.cache['cwg-proto-tap']` (etc.) before any consumer plugin runs.

### Plain plugin (no `id`) — fire-and-forget IIFE

```js
} else {
  body = 'try { (function () {\n' + p.code + '\n})(); }'
    + ' catch (__e) { console.error("[PodBay] plugin error [...]:", __e && __e.message); }';
}
```

The full bundle is the parts joined with `\n\n` — lib modules first (they appear first in the pod file), consumer plugins after.

**Key file:** `reverse-client.js`

---

## Layer 5: Require Resolution (polyfill cache hit)

`lib/portal-payload.js` installs `window.require` in the renderer before any plugin code runs:

```js
// lib/portal-payload.js
window.require = function (path) {
  var parent = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1] : undefined;
  return loadModule(path, parent);
};
window.require.cache = moduleCache;  // ← plain object {}
```

`loadModule` checks the cache first:

```js
function loadModule(modulePath, parentPath) {
  var resolved = resolvePath(modulePath, parentPath);
  if (moduleCache[resolved]) return moduleCache[resolved].exports;  // ← CACHE HIT
  // ... HTTP fetch fallback only if not in cache
}
```

When a consumer plugin calls `require('cwg-proto-tap')`:

1. `loadModule('cwg-proto-tap', ...)` is called
2. `moduleCache['cwg-proto-tap']` already exists (populated by the lib-module bundle entry in Layer 4)
3. Returns `moduleCache['cwg-proto-tap'].exports` immediately — **no HTTP fetch**

**Key file:** `lib/portal-payload.js`

---

## Summary: Full Flow Diagram

```
User assigns pods in dashboard
        │
        ▼
podbay__pods_assign → registry (index.js)
        │
        ▼ (at inject time)
getAppPods(clientId) → ['cwg-plugin-library.pod', ...]
        │
        ▼
getPluginCodeForPods() → resolvePlugins()
  reads source from host ./plugins/ (Docker mount)
  passes id field through
        │
        ▼
Bundle assembler (reverse-client.js)
  lib entries (id set)    → require.cache registration wrappers  ← loaded FIRST
  plugin entries (no id)  → IIFEs                                ← loaded AFTER
        │
        ▼
Bundle eval'd in target renderer window
  portal-payload.js already installed window.require
  lib modules populate window.require.cache
  consumer plugins call require('cwg-proto-tap') → cache hit → exports returned
        │
        ▼
✅ Plugins running with full require() dependency resolution
   Source from host paths, no bundler, no build step
```

---

## Confirmed Capabilities

| Capability | Status | Mechanism |
|---|---|---|
| Asar app opt-in | ✅ | `lib/asar.js` patches the asar; `portal-payload.js` bootstraps WebSocket |
| Pod selection per app | ✅ | `pods_assign` → `getAppPods` → `getPluginCodeForPods` |
| Plugins injected into renderer | ✅ | Bundle assembled server-side, eval'd in target window |
| `require()` of dependencies | ✅ | Lib-module entries pre-populate `window.require.cache` |
| Source loaded from host paths | ✅ | `readFileSync` from Docker-mounted `./plugins:/app/plugins` at bundle-assemble time |
| Backward compat (window globals) | ✅ | All converted modules also set `window.CWGProtoTap = module.exports` etc. |
