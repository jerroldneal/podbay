# PodBay

> "Open the pod bay doors, HAL." — Unlike HAL, PodBay always opens the doors.

Self-contained CLI that manages Electron app opt-in to the MCP broker and delivers plugins via `.pod` files. When opted-in with a **client name**, every renderer window registers on the broker using that name and exposes an `execute_plugin` tool for remote code execution.

**Two-stage injection model**: Opt-in patches the app's ASAR with a minimal **bootstrap** (~95 lines) that only connects to the broker and exposes `execute_plugin`. Everything else — plugin loading, tool registration, status reporting — is pushed by the broker via `execute_plugin` after the bootstrap connects.

**Separated concerns** (decoupled data model):
- `.opted-in.json` — tracks which apps are bootstrapped (name → ASAR path only)
- `pods/app-pods.json` — maps app names to their assigned pod files (independent of opt-in state)

Pod files are app-agnostic — the same `.pod` file can be shared across multiple apps. Pod assignment does not require the app to be opted-in; pods can be pre-configured before bootstrap injection.

PodBay is **domain-agnostic** — it never embeds app-specific knowledge into client IDs or tool names. The caller chooses a name at opt-in time.

Supports three modes: interactive menu (default), scriptable CLI parameters, and MCP reverse client (publishes all operations as broker tools).

**Dashboard**: A web UI (nginx on `:8080`) provides app management, pod editing, plugin editing, a remote JavaScript console, and a push activity log with real-time notifications.

See [ARCHITECTURE.md](ARCHITECTURE.md) for system design and [PLUGIN_MANUAL.md](PLUGIN_MANUAL.md) for per-plugin documentation.

## Pod Files

Pod files live in `pods/` and define collections of injectable plugins:

```json
{
  "name": "cwg-debug",
  "description": "ClubWPT Gold debug tools",
  "plugins": [
    {
      "type": "room-id",
      "description": "Displays room ID badge",
      "code": "console.log('hello')"
    },
    {
      "type": "helper",
      "description": "Table helper",
      "file": "/path/to/helper.js"
    },
    {
      "type": "module",
      "description": "NPM module",
      "require": "some-module"
    }
  ]
}
```

Plugin resolution: `code` (inline JS), `file` (read from disk), or `require` (Node.js module resolution).

## Usage

### Interactive Mode

```bash
node podbay
```

1. Lists installed Electron apps with bootstrap status
2. Pick an app by number
3. Choose an action:
   - **1. Opt-In** — Inject bootstrap (prompts for client name)
   - **2. Opt-Out** — Restore original ASAR
   - **3. Assign pods** — Toggle pod file assignments for the app

### CLI Parameters

```bash
# App discovery
node podbay list                                        # JSON array of all apps

# Opt-in management
node podbay opt-in clubwpt-desktop cwg                  # Opt-in with name "cwg"
node podbay opt-out clubwpt-desktop                     # Restore original ASAR
node podbay status clubwpt-desktop                      # Status + assigned pods

# Pod management
node podbay pods list                                   # List all pod files
node podbay pods get cwg-debug.pod                      # Get pod details
node podbay pods delete cwg-debug.pod                   # Delete a pod file
node podbay pods assign cwg cwg-debug.pod               # Assign pod to app
node podbay pods unassign cwg cwg-debug.pod             # Unassign pod from app
node podbay pods app cwg                                # List pods assigned to app
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
| `list` | Discover installed Electron apps with status and assigned pods |
| `opt_in` | Opt-in an app with a **required `name`** |
| `opt_out` | Opt-out an app — restore original ASAR |
| `status` | Get portal status and assigned pods for an app |
| `inject` | Return combined injection bundle (called by system plugin on startup) |
| `pods_list` | List all `.pod` files |
| `pods_get` | Get a single pod by filename |
| `pods_save` | Create or update a `.pod` file |
| `pods_delete` | Delete a `.pod` file |
| `pods_resolve` | Preview resolved plugin code from all pods |
| `pods_assign` | Assign a `.pod` file to an app |
| `pods_unassign` | Unassign a `.pod` file from an app |
| `pods_app` | List pods assigned to a specific app |

### Docker

```bash
docker compose up -d
```

Runs the reverse client in a container. Set `PODBAY_BROKER_URL` to override the broker address (defaults to `ws://host.docker.internal:3099`).

## How It Works

```
podbay/
  index.js              ← CLI entry point + opt-in/opt-out + pod assignment
  reverse-client.js     ← Reverse client — publishes tools on broker
  Dockerfile            ← Container image for reverse client
  docker-compose.yml    ← Docker orchestration
  dashboard.html        ← Main dashboard UI (app list, pods, push activity)
  console.html          ← Remote JavaScript console (multi-tab)
  pod-editor.html       ← Pod file editor
  plugin-editor.html    ← Plugin editor
  lib/discover.js       ← Scan for installed Electron apps
  lib/asar.js           ← ASAR backup/extract/patch/repack/restore
  lib/bootstrap.js      ← Minimal injection payload (~95 lines)
  lib/broker-client.js  ← Browser-side broker client SDK
  lib/bridge.js         ← High-level bridge factory
  lib/hook.js           ← Method interception utility
  lib/pods.js           ← Pod file CRUD and plugin resolution
  plugins/              ← Reusable plugin source files
  plugins/cwg/          ← CWG-specific SRP plugin modules
  pods/                 ← Pod files (.pod JSON files)
  pods/app-pods.json    ← Maps app names → pod file arrays
  .opted-in.json        ← Registry: maps names → {asarPath}
```

### Opt-In Flow

1. User opts-in an app with a name (e.g., `cwg`)
2. PodBay patches the ASAR to inject the bootstrap with `var __podbayName = "cwg"`
3. User assigns pod files to the app (e.g., `cwg-debug.pod`) — this can be done before or after opt-in

### Injection Flow (at app launch)

1. App starts → bootstrap loads in every renderer window
2. Bootstrap connects to broker as `cwg`
3. Bootstrap calls PodBay's `inject` tool (or PodBay pushes automatically on client detection)
4. PodBay looks up which pods are assigned to `cwg` in `pods/app-pods.json`
5. PodBay resolves all plugins from those pods, bundles them
6. Bundle is returned and executed in the renderer
7. Push success/failure is logged and sent as a broker notification (visible in dashboard)

### Name Rules

The `name` parameter must be lowercase alphanumeric + hyphens (`[a-z0-9-]`), no leading/trailing hyphens. Defaults to normalized app directory name (e.g., "ClubWPT Gold" → "clubwpt-gold"). Must be unique across opted-in apps.

## Programmatic

```javascript
const { optIn, optOut, discover, resolveApp, pods, assignPod, unassignPod, getAppPods } = require('./podbay');

const apps = discover();
const app = resolveApp(apps, 'clubwpt-desktop');

// Assign pods (works before or after opt-in)
assignPod('clubwpt-desktop', 'cwg-debug.pod');
assignPod('clubwpt-desktop', 'example.pod');

// Check assignments
getAppPods('clubwpt-desktop');  // ['cwg-debug.pod', 'example.pod']

// Opt-in (patches ASAR with bootstrap)
optIn(app.asarPath, 'cwg');

// Unassign
unassignPod('clubwpt-desktop', 'example.pod');

// Opt-out (restores original ASAR; pod assignments in app-pods.json are preserved)
optOut(app.asarPath);
```

## Walkthrough: Verify with ClubWPT Gold

### Prerequisites

- ClubWPT Gold Desktop installed (`%LOCALAPPDATA%\Programs\clubwpt-desktop`)
- ClubWPT Gold Desktop is **closed**
- Broker running at `ws://localhost:3099`

### Step 1: Opt-In and Assign Pods

```bash
node podbay opt-in clubwpt-desktop cwg
node podbay pods assign cwg cwg-debug.pod
```

### Step 2: Launch ClubWPT Gold

Open the app. Every renderer window will:
- Load the system plugin
- Connect to broker as `cwg`
- Request injection bundle from PodBay
- Execute all plugins from `cwg-debug.pod`

### Step 3: Verify via Broker

```json
{
  "tool": "cwg.execute_plugin",
  "arguments": { "code": "return document.title" }
}
```

Expected: the app's document title.

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
