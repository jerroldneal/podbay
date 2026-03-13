# PodBay

> "Open the pod bay doors, HAL." — Unlike HAL, PodBay always opens the doors.

Self-contained CLI that manages Electron app opt-in to the MCP broker and delivers plugins. When opted-in with a **client name**, every renderer window registers on the broker using that name and exposes tools prefixed as `{name}.toolName` (e.g., `my-app.execute_plugin`).

PodBay is **domain-agnostic** — it never embeds app-specific knowledge into client IDs or tool names. The caller chooses a name at opt-in time; if consumers want app metadata, they call the client's info tool.

Supports three modes: interactive menu (default), scriptable CLI parameters, and MCP reverse client (publishes all operations as broker tools).

## Usage

### Interactive Mode

```bash
node podbay
```

1. Lists installed Electron apps with portal status and plugin count
2. Pick an app by number
3. Choose an action:
   - **1. Open** — Patch the app with the portal payload
   - **2. Close** — Restore the original ASAR
   - **3. Add plugin** — Register a require-resolvable module
   - **4. List plugins** — Show configured plugins with resolved paths
   - **5. Remove plugin** — Remove a plugin by number

### CLI Parameters

Every interactive operation is available as a direct command with JSON output:

```bash
# App discovery
node podbay list                                        # JSON array of all apps

# Portal management (by app name or 1-based index)
node podbay open clubwpt-desktop                        # Open portal
node podbay close clubwpt-desktop                       # Close portal
node podbay status clubwpt-desktop                      # Status + plugins JSON

# Plugin management
node podbay plugins list clubwpt-desktop                # List plugins as JSON
node podbay plugins add clubwpt-desktop /path/to.js     # Add a plugin
node podbay plugins remove clubwpt-desktop 2            # Remove plugin at index 2
node podbay plugins set clubwpt-desktop '["/a.js"]'     # Replace full plugin list
```

### Reverse Client (MCP Tools)

Run as a long-lived process that publishes all operations as tools on the broker:

```bash
npm run serve                                           # ws://localhost:3099
node reverse-client.js --url ws://myhost:3099           # custom broker
```

Registers as `podbay` on the broker with tools:

| Tool | Description |
|------|-------------|
| `list` | Discover installed Electron apps |
| `open` | Open portal for an app (legacy) |
| `close` | Close portal for an app (legacy) |
| `opt_in` | Opt-in an app with a **required `name`** (e.g., `{app: "clubwpt-desktop", name: "cwg"}`) |
| `opt_out` | Opt-out an app — restore original ASAR |
| `status` | Get portal status and plugin list |
| `plugins_list` | List configured plugins |
| `plugins_add` | Add a plugin by path |
| `plugins_remove` | Remove a plugin by index |
| `plugins_set` | Replace full plugin list |

The `name` parameter on `opt_in` must be lowercase alphanumeric + hyphens (`[a-z0-9-]`). This name becomes the client's broker ID and tool prefix. For example, opting in with `name: "cwg"` means the client registers as `cwg` and its tools appear as `cwg.execute_plugin` and `cwg.plugin`.

### Docker

```bash
docker compose up -d
```

Runs the reverse client in a container. Requires volume mount for host Electron app directories. Set `PODBAY_BROKER_URL` to override the broker address (defaults to `ws://host.docker.internal:3099`).

## Plugins

Plugins are file paths stored in `podbay-plugins.json` alongside the app's `app.asar`. At startup, the main process reads this file and executes each plugin in every renderer window via `executeJavaScript`.

- **Add**: validates the path with `require.resolve()` before storing
- **List**: shows each plugin's resolved path and file size
- **Remove**: removes by number from a displayed list
- **Broker tool**: the `plugin` tool lets you edit the full list as JSON over the broker connection

## Programmatic

```javascript
const { open, close, optIn, optOut, discover, readPlugins, writePlugins, resolveApp } = require('./podbay');

const apps = discover();
const app = resolveApp(apps, 'clubwpt-desktop');  // By name or index

// Opt-in with a client name (recommended)
optIn(app.asarPath, 'cwg');    // Registers as 'cwg' on broker, tools prefixed 'cwg.'
optOut(app.asarPath);           // Restore original ASAR

// Legacy portal mode (URL-param-based client IDs)
open(app.asarPath);    // Open portal
close(app.asarPath);   // Close portal

const plugins = readPlugins(app.asarPath);  // Get plugin list
writePlugins(app.asarPath, [...plugins, 'd:\\path\\to\\plugin.js']);
```

## How It Works

```
podbay/
  index.js              ← CLI entry point + opt-in/opt-out + plugin management
  reverse-client.js     ← Reverse client — publishes tools on broker
  Dockerfile            ← Container image for reverse client
  docker-compose.yml    ← Docker orchestration with host volume mount
  lib/discover.js       ← Scan for installed Electron apps
  lib/asar.js           ← ASAR backup/extract/patch/repack/restore
  lib/system-plugin.js  ← Minimal injection client (name-based broker registration)
  lib/portal-payload.js ← Legacy portal payload with require polyfill
  lib/pods.js           ← Pod file CRUD and plugin resolution
```

On **opt-in** (or legacy **open**), the system plugin is written into the ASAR alongside WindowManager.js. A patch in WindowManager.js:
1. Prepends `var __podbayName = "{name}"` and loads the system plugin via `executeJavaScript` on every `did-finish-load`
2. Reads `podbay-plugins.json` and executes each plugin in the renderer
3. Loads plugins from `.pod` files in the pods directory
4. Listens for `console-message` IPC to persist plugin changes from the renderer

The system plugin:
- Connects to the broker at `ws://localhost:3099`
- Registers with the **client name** provided at opt-in time (injected as `__podbayName` by the ASAR patch)
- Exposes two tools: `{name}.execute_plugin` (run JS in renderer) and `{name}.plugin` (injection status)
- Falls back to URL-param-based IDs (`podbay-lobby`, `podbay-window-{id}`) for legacy `open` mode

## Downstream Tools

Plugins like cwg-table-helper can be added via the CLI or `plugin` tool. Once added, they load automatically at app startup — no manual injection needed. They access `window.__portal.ws()` to register their own tools on the existing broker connection.

## Walkthrough: Verify with ClubWPT Gold

This walkthrough confirms PodBay works end-to-end with the ClubWPT Gold Desktop app.

### Prerequisites

- ClubWPT Gold Desktop installed (`%LOCALAPPDATA%\Programs\clubwpt-desktop`)
- ClubWPT Gold Desktop is **closed** (not running)
- Broker running at `ws://localhost:3099` (cnr-ws-server)

### Step 1: Opt-In the App

Via CLI:
```bash
node podbay open clubwpt-desktop   # Legacy open (uses URL-param client IDs)
```

Or via broker tool (recommended):
```json
{
  "tool": "opt_in",
  "arguments": { "app": "clubwpt-desktop", "name": "cwg" }
}
```

This patches the ASAR with the system plugin configured to register as `cwg` on the broker.

### Step 2: Launch ClubWPT Gold

Open the app normally. Every renderer window will:
- Load the system plugin automatically
- Connect to the broker as `cwg`
- Register `cwg.execute_plugin` and `cwg.plugin` tools

### Step 3: Verify via Broker

Use any broker client (e.g., mcp-broker, VS Code Copilot) to call the `cwg.execute_plugin` tool on `cwg`:

```json
{
  "tool": "cwg.execute_plugin",
  "arguments": { "code": "return document.title" }
}
```

Expected response — the app's document title (e.g., `"ClubWPT Gold"`).

### Step 4: Add a Plugin (Optional)

```
> node podbay

Select app: 1

Action: 3
  Plugin path: d:\development\chrome-native-relay\cwg-table-helper\helper.js
[PodBay] Added: d:\development\chrome-native-relay\cwg-table-helper\helper.js
```

On next app restart, the helper loads automatically — no manual injection.

### Step 5: Verify Plugin Loaded

After restarting the app with the plugin configured, call via broker:

```json
{
  "tool": "execute_plugin",
  "arguments": { "code": "return typeof window.__portal !== 'undefined'" }
}
```

Expected: `true` — confirms both the portal payload and downstream tools are active.

### Step 6: Close the Portal

```
> node podbay

Select app: 1

Action: 2
[PodBay] Restoring original ASAR...
[PodBay] Portal closed. Restart the app to deactivate.
```

The app is restored to its original state. Plugin configuration in `podbay-plugins.json` is preserved for next time.
