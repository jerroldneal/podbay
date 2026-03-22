# PodBay POC — Dynamic Plugin Composition

Proof-of-concept of PodBay's next-gen plugin architecture. Plugins are
first-class modules that can `require()` each other by type name — no manual
wiring, no `id` fields, no push model. See the
[plugin composition idea](../../ideas/architecture/commonjs-plugin-composition.md)
for background.

## Key Differences from Main PodBay

1. **Bootstrap has `require()` embedded** — available immediately on window load,
   before any plugins are pushed. No need for `universal-require` as a separate
   first plugin.

2. **Auto-registration via `__podbayPlugins`** — the RC inject handler
   registers every plugin by its `type` name in `window.__podbayPlugins`.
   Plugins become requireable by name without manual `id` fields in pod specs.

3. **Require resolution hierarchy** — cache → URL registry → **plugin registry** →
   URL fetch → relative path → error.

## Quick Start

```bash
npm install
npm start
```

Requires the MCP broker running on `ws://localhost:3099`.
