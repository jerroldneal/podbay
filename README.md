# PodBay

> "Open the pod bay doors, HAL." — Unlike HAL, PodBay always opens the doors.

Self-contained CLI that manages Electron app opt-in to the MCP broker and delivers plugins via `.pod` files. When opted-in with a **client name**, every renderer window registers on the broker using that name and exposes tools prefixed as `{name}.toolName` (e.g., `cwg.execute_plugin`).

**Pod-centric plugin management**: Plugins are defined exclusively in `.pod` files (JSON) in the `pods/` directory. Each opted-in app is assigned 0-n `.pod` files. When the app launches, PodBay bundles all plugins from the app's assigned pods into a single injection payload. Pod files are app-agnostic — the same `.pod` file can be shared across multiple apps.

PodBay is **domain-agnostic** — it never embeds app-specific knowledge into client IDs or tool names. The caller chooses a name at opt-in time.

Supports three modes: interactive menu (default), scriptable CLI parameters, and MCP reverse client (publishes all operations as broker tools).

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

1. Lists installed Electron apps with portal status
2. Pick an app by number
3. Choose an action:
   - **1. Opt-In** — Inject system plugin (prompts for client name)
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
| `pods_assign` | Assign a `.pod` file to an opted-in app |
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
  lib/discover.js       ← Scan for installed Electron apps
  lib/asar.js           ← ASAR backup/extract/patch/repack/restore
  lib/system-plugin.js  ← Minimal injection client (name-based broker registration)
  lib/pods.js           ← Pod file CRUD and plugin resolution
  pods/                 ← Pod files (.pod JSON files)
  .opted-in.json        ← Registry: maps names → {asarPath, pods[]}
```

### Opt-In Flow

1. User opts-in an app with a name (e.g., `cwg`)
2. PodBay patches the ASAR to inject the system plugin with `var __podbayName = "cwg"`
3. User assigns pod files to the app (e.g., `cwg-debug.pod`)

### Injection Flow (at app launch)

1. App starts → system plugin loads in every renderer window
2. System plugin connects to broker as `cwg`
3. System plugin calls PodBay's `inject` tool
4. PodBay looks up which pods are assigned to `cwg`
5. PodBay resolves all plugins from those pods, bundles them
6. Bundle is returned and executed in the renderer

### Name Rules

The `name` parameter must be lowercase alphanumeric + hyphens (`[a-z0-9-]`), no leading/trailing hyphens. Defaults to normalized app directory name (e.g., "ClubWPT Gold" → "clubwpt-gold"). Must be unique across opted-in apps.

## Programmatic

```javascript
const { optIn, optOut, discover, resolveApp, pods, assignPod, unassignPod, getAppPods } = require('./podbay');

const apps = discover();
const app = resolveApp(apps, 'clubwpt-desktop');

// Opt-in
optIn(app.asarPath, 'cwg');

// Assign pods
assignPod('cwg', 'cwg-debug.pod');
assignPod('cwg', 'example.pod');

// Check assignments
getAppPods('cwg');  // ['cwg-debug.pod', 'example.pod']

// Unassign
unassignPod('cwg', 'example.pod');

// Opt-out (removes registry entry including pod assignments)
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
