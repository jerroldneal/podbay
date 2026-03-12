# PodBay

> "Open the pod bay doors, HAL." — Unlike HAL, PodBay always opens the doors.

Self-contained CLI that opens and closes portals in Electron apps. When opened, every renderer window gets a live `inject` tool connected to the broker — no external payloads, no configuration.

## Usage

```bash
node podbay
```

1. Lists installed Electron apps with portal status (`open` / `closed`)
2. Pick an app by number
3. Choose **Open** or **Close**

**Open**: Backs up the ASAR, patches WindowManager.js to load the portal payload in every renderer window, repacks. The inject tool connects to `ws://localhost:3099` and registers automatically.

**Close**: Restores the original ASAR from backup. Clean, reversible.

## Programmatic

```javascript
const { open, close, discover } = require('./podbay');

const apps = discover();
open(apps[0].asarPath);   // Open portal
close(apps[0].asarPath);  // Close portal
```

## How It Works

```
podbay/
  index.js              ← CLI entry point
  lib/discover.js       ← Scan for installed Electron apps
  lib/asar.js           ← ASAR backup/extract/patch/repack/restore
  lib/portal-payload.js ← Inject tool payload (embedded in ASAR at open)
```

On **open**, the portal payload (`portal-payload.js`) is written into the ASAR alongside WindowManager.js. A patch in WindowManager.js loads it via `executeJavaScript` on every `did-finish-load` event.

The payload:
- Connects to the broker at `ws://localhost:3099`
- Registers with a client ID derived from URL params (e.g., `podbay-lobby`, `podbay-window-3`)
- Exposes one tool: `inject` — executes arbitrary JavaScript in the renderer
- Exposes `window.__portal` for downstream tools (e.g., cwg-table-helper) to reuse the connection

## Downstream Tools

Product 3+ (like cwg-table-helper) can be injected via the `inject` tool after PodBay opens the portal. They access `window.__portal.ws()` to register their own tools on the existing broker connection.
