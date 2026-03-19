# PodBay Architecture

> **Version**: 3.0.0
> **Last Updated**: 2026-03-19

PodBay is a runtime injection framework for Electron applications. It patches Electron's ASAR bundles to inject a minimal **bootstrap** into every renderer window, connects those windows to an MCP broker, and delivers composable plugin bundles ("pods") on demand via the `execute_plugin` tool. The entire system runs as Docker containers communicating over WebSocket and HTTP.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Concepts](#core-concepts)
3. [Module Reference](#module-reference)
4. [Injection Lifecycle](#injection-lifecycle)
5. [Pod & Plugin System](#pod--plugin-system)
6. [Broker Communication](#broker-communication)
7. [Client-Side Plugin Architecture](#client-side-plugin-architecture)
8. [Docker Infrastructure](#docker-infrastructure)
9. [Dashboard & Web UI](#dashboard--web-ui)
10. [Tool Registry](#tool-registry)

---

## System Overview

```mermaid
graph TB
    subgraph Host["Host Machine"]
        Broker["MCP Broker<br/>WS :3099 / HTTP :3098"]
        ElectronApp["Electron App<br/>(e.g. ClubWPT Gold)"]
    end

    subgraph Docker["Docker Containers"]
        RC["PodBay Reverse Client<br/>(podbay container)"]
        Dashboard["nginx Dashboard<br/>(podbay-dashboard :8080)"]
    end

    subgraph ElectronWindows["Electron Renderer Windows"]
        BS["Bootstrap<br/>(injected via ASAR patch)"]
        Plugins["Plugin Bundle<br/>(pushed via execute_plugin)"]
    end

    RC -- "WS register<br/>tools: list, opt_in,<br/>inject, pods_*" --> Broker
    BS -- "WS register<br/>tool: execute_plugin" --> Broker
    Broker -- "tool_call: execute_plugin<br/>(push stage-2 + plugins)" --> BS
    BS -- "eval(code)" --> Plugins
    Plugins -- "WS register<br/>per-plugin tools" --> Broker
    Dashboard -- "serves HTML/JS" --> Host
```

---

## Core Concepts

### 1. Opt-In / Opt-Out Model

PodBay never modifies applications without consent. An explicit **opt-in** step patches the Electron app's ASAR archive with a minimal bootstrap. **Opt-out** restores the original backup.

Opt-in state is tracked in `.opted-in.json` (name → ASAR path only). Pod assignments are tracked separately in `pods/app-pods.json`.

```mermaid
stateDiagram-v2
    [*] --> Closed: App discovered
    Closed --> BackingUp: opt_in(app, name)
    BackingUp --> Extracting: ASAR backed up
    Extracting --> Patching: Files extracted
    Patching --> Repacking: WindowManager.js patched
    Repacking --> Open: ASAR repacked
    Open --> Restoring: opt_out(app)
    Restoring --> Closed: Backup restored
    Open --> Open: App launches with injection
```

| State | Meaning |
|-------|---------|
| Closed | Original app, no PodBay involvement |
| Open | ASAR patched, bootstrap injected on every window load |

### 2. Reverse Client Pattern

PodBay acts as a **reverse client** — instead of exposing an API, it **publishes tools** to the MCP broker. External consumers (AI agents, dashboards, other clients) invoke PodBay operations through the broker's tool routing.

### 3. Pod Composition

Plugins are grouped into **pods** — JSON manifest files (`.pod`) that declare ordered plugin chains. Pods are assigned to applications, and on injection the assigned pods' plugins are bundled into a single executable payload.

### 4. Plugin Execution Order

Within a pod, plugins execute **top-to-bottom** in declaration order. This enables a layered dependency model:

```
broker-client-sdk → bridge → hook → identity → [domain plugins] → console-bridge
```

Each layer builds on the previous one's `window.*` exports.

### 5. Minimal Bootstrap Injection

The bootstrap (`lib/bootstrap.js`, ~95 lines) is the only code injected into the ASAR. Its sole responsibility is:
1. Derive a stable `clientId`
2. Connect to the broker via WebSocket
3. Register a single tool: `execute_plugin`
4. Handle incoming `tool_call` messages (eval arbitrary JS)
5. Reconnect on disconnect

All other capabilities (plugin registry, tool publishing, status reporting, pod loading) are **pushed** by the broker via `execute_plugin` after the bootstrap connects. This minimizes the ASAR patch surface and makes the injected code trivially simple.

---

## Module Reference

```mermaid
graph LR
    subgraph ServerSide["Server-Side (Node.js)"]
        index["index.js<br/>CLI & Core API"]
        rc["reverse-client.js<br/>Broker Reverse Client"]
        discover["lib/discover.js<br/>App Discovery"]
        asarMod["lib/asar.js<br/>ASAR Manipulation"]
        pods["lib/pods.js<br/>Pod Loader & Resolver"]
    end

    subgraph ClientSide["Client-Side (Browser Plugins)"]
        bs["lib/bootstrap.js<br/>Minimal Bootstrap"]
        sp["lib/system-plugin.js<br/>Legacy (reference)"]
        bc["lib/broker-client.js<br/>Broker Client SDK"]]
        bridge["lib/bridge.js<br/>Bridge Factory"]
        hook["lib/hook.js<br/>Method Interceptor"]
        identity["lib/identity.js<br/>Window Identity"]
        consoleBridge["lib/console-bridge.js<br/>Console Bridge"]
        tableWatcher["lib/table-watcher.js<br/>Table Watcher"]
    end

    index --> discover
    index --> asarMod
    index --> pods
    rc --> index
    rc --> pods
    sp --> bridge
    sp --> bc
    consoleBridge --> bridge
    consoleBridge --> hook
    consoleBridge --> identity
```

### Server-Side Modules

| Module | File | Purpose |
|--------|------|---------|
| **Core API** | `index.js` | CLI interface, opt-in/opt-out, registry management |
| **Reverse Client** | `reverse-client.js` | Long-lived process that publishes 13 MCP tools to the broker |
| **App Discovery** | `lib/discover.js` | Scans filesystem for Electron apps containing `app.asar` |
| **ASAR Manipulation** | `lib/asar.js` | Backup, extract, patch WindowManager.js, repack |
| **Pod Loader** | `lib/pods.js` | Parse `.pod` files, resolve plugin code, manage `app-pods.json` |

### Client-Side Modules (Injected Plugins)

| Module | File | Window Global | Purpose |
|--------|------|---------------|---------|
| **Bootstrap** | `lib/bootstrap.js` | `window.__podBayInstalled` | Minimal payload — connects to broker, exposes `execute_plugin` |
| **System Plugin** | `lib/system-plugin.js` | *(legacy, reference only)* | Former full-featured bootstrap — preserved for reference |
| **Broker Client SDK** | `lib/broker-client.js` | `window.PodBayBrokerClient` | Reusable WS client class with tool publishing & notification API |
| **Bridge Factory** | `lib/bridge.js` | `window.PodBayBridge(id)` | High-level bridge factory — `addTool()`, `connect()`, `notify()` |
| **Hook** | `lib/hook.js` | `window.PodBayHook(target, methods, cb)` | Generalized method interception on any object |
| **Identity** | `lib/identity.js` | `window.PodBayIdentity` | CWG window type detection from URL params |
| **Console Bridge** | `lib/console-bridge.js` | *(composes bridge+hook)* | eval/get_console/run_console tools + console hook notifications |
| **Table Watcher** | `lib/table-watcher.js` | `window.PodBayTableWatcher` | Cocos2d scene graph extraction for poker table state |
| **Portal Payload** | `lib/portal-payload.js` | `window.__portal` | Legacy v1 portal (includes require polyfill, plugin list via localStorage) |

---

## Injection Lifecycle

```mermaid
sequenceDiagram
    participant App as Electron App
    participant WM as WindowManager.js<br/>(patched)
    participant BS as Bootstrap
    participant Broker as MCP Broker
    participant RC as PodBay RC<br/>(Docker)

    Note over App: App launches (opted-in ASAR)
    App->>WM: createWindow()
    WM->>WM: window.loadURL(url)
    WM->>BS: did-finish-load → executeJavaScript(bootstrap)

    BS->>Broker: WS register(clientId, [execute_plugin])
    Broker-->>BS: registered ✓

    Note over Broker,RC: Broker detects new bootstrap client
    Broker->>RC: notify: new client registered
    RC->>RC: Look up assigned pods<br/>in pods/app-pods.json
    RC->>RC: Resolve plugin code<br/>from .pod files
    RC->>Broker: tool_call: {clientId}__execute_plugin<br/>(stage-2 + plugin bundle)
    Broker->>BS: tool_call: execute_plugin(code)
    BS->>BS: eval(code)

    Note over BS: Plugins initialize in order:<br/>1. broker-client-sdk<br/>2. bridge<br/>3. hook<br/>4. identity<br/>5. domain plugins<br/>6. console-bridge

    BS->>Broker: WS update_tools<br/>(plugin-registered tools)
```

### Step-by-Step

1. **App Launch**: Electron loads the patched ASAR containing the bootstrap (`podbay-portal.js`)
2. **Window Creation**: `WindowManager.js` fires the patch on `did-finish-load`, injecting the bootstrap via `executeJavaScript()`
3. **Broker Registration**: Bootstrap connects to broker WS (`:3099`), registers only `execute_plugin`
4. **Plugin Push**: PodBay reverse client detects the new client, looks up its pods in `pods/app-pods.json`, resolves plugin code, and pushes the bundle via `execute_plugin`
5. **Bundle Evaluation**: Bootstrap evaluates the pushed code with `new Function(code)()`
6. **Plugin Initialization**: Each plugin IIFE runs in declaration order, installing its `window.*` export
7. **Tool Publishing**: Plugins that register broker tools trigger an `update_tools` message with the expanded tool list

---

## Pod & Plugin System

### Pod File Format

Pods are JSON files in the `pods/` directory with `.pod` extension:

```json
{
  "name": "console",
  "description": "Remote JavaScript console",
  "plugins": [
    {
      "type": "broker-client-sdk",
      "file": "lib/broker-client.js",
      "description": "Broker client SDK"
    },
    {
      "type": "custom-inline",
      "code": "(function(){ /* inline JS */ })()",
      "description": "Inline plugin"
    }
  ]
}
```

### Plugin Resolution

```mermaid
flowchart TD
    Pod["Pod File (.pod)"] --> Plugins["plugins array"]
    Plugins --> P1{"Has 'code'?"}
    P1 -- Yes --> Inline["Use inline code string"]
    P1 -- No --> P2{"Has 'file'?"}
    P2 -- Yes --> FileRead["fs.readFileSync(file)"]
    P2 -- No --> P3{"Has 'require'?"}
    P3 -- Yes --> Require["require.resolve() → readFileSync()"]
    P3 -- No --> Skip["Skip (no code source)"]

    Inline --> Bundle["Combined Bundle"]
    FileRead --> Bundle
    Require --> Bundle
```

Three plugin code sources (checked in priority order):
1. **`code`** — inline JavaScript string embedded in the pod
2. **`file`** — path to a `.js` file read from disk at injection time
3. **`require`** — Node.js module resolved and read from disk

### Pod-to-App Assignment

```mermaid
flowchart LR
    Registry[".opted-in.json"] --> AppEntry["app-name:<br/>{asarPath}"]
    AppPods["pods/app-pods.json"] --> Mapping["app-name:<br/>[pod1, pod2]"]

    InjectRequest["inject(clientId)"] --> Lookup["pods.getAppPods(clientId)"]
    Lookup --> Resolve["getPluginCodeForPods(pods)"]
    Resolve --> Bundle["Combined JavaScript Bundle"]
```

Opt-in state and pod assignments are **separated concerns**:

`.opted-in.json` — only tracks whether an app is bootstrapped:
```json
{
  "clubwpt-desktop": {
    "asarPath": "C:\\Users\\...\\clubwpt-desktop\\resources\\app.asar"
  }
}
```

`pods/app-pods.json` — maps app names to their assigned pods:
```json
{
  "clubwpt-desktop": ["console.pod", "cwg-debug.pod"]
}
```

---

## Broker Communication

### Protocol Overview

```mermaid
flowchart TB
    subgraph Protocols["Communication Protocols"]
        WS["WebSocket :3099<br/>Registration, tool calls,<br/>notifications, results"]
        HTTP["HTTP POST :3098/mcp<br/>JSON-RPC → SSE response"]
    end

    subgraph Clients["Broker Clients"]
        PodBayRC["podbay (RC)<br/>13 tools"]
        Bootstrap["cwg-lobby, cwg-table-*<br/>execute_plugin<br/>+ dynamic tools (pushed)"]
        ConsoleBridge["cwg-lobby (bridge)<br/>eval, get_console,<br/>run_console"]
        External["AI Agents,<br/>Dashboards"]
    end

    PodBayRC -- "register" --> WS
    Bootstrap -- "register" --> WS
    ConsoleBridge -- "register" --> WS
    External -- "call_tool" --> HTTP
```

### WebSocket Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `register` | Client → Broker | Register clientId + tools + metadata |
| `registered` | Broker → Client | Acknowledge registration |
| `tool_call` | Broker → Client | Execute a tool with arguments |
| `tool_result` | Client → Broker | Return tool execution result |
| `update_tools` | Client → Broker | Update tool list after plugin registration |
| `notification` | Client → Broker | Push event data (console logs, state changes) |

### Tool Namespacing

The broker namespaces tools as `{clientId}__{toolName}` (double underscore). A tool `eval` registered by client `cwg-lobby` becomes `cwg-lobby__eval` in the broker's global tool registry.

### Reconnection Strategy

```mermaid
stateDiagram-v2
    [*] --> Connecting
    Connecting --> Connected: WS open
    Connected --> Registered: register → registered
    Registered --> Disconnected: WS close
    Disconnected --> Connecting: after delay

    note right of Disconnected
        Exponential backoff:
        3s → 4.5s → 6.75s → ... → 30s max
        Plus random jitter (0-1s)
    end note
```

---

## Client-Side Plugin Architecture

### Plugin Pattern

Every client-side plugin follows the same IIFE pattern:

```javascript
;(function () {
  'use strict';

  // 1. Duplicate guard — prevent re-execution
  if (window.MyPlugin) return;

  // 2. Window-type guard (optional) — skip irrelevant windows
  var params = new URLSearchParams(window.location.search);
  if (params.get('windowType') === '1') return;  // skip lobby

  // 3. Plugin logic
  // ...

  // 4. Export to window
  window.MyPlugin = { /* public API */ };
})();
```

### Plugin Dependency Chain

```mermaid
graph TB
    SDK["PodBayBrokerClient<br/>(broker-client.js)"]
    Bridge["PodBayBridge<br/>(bridge.js)"]
    Hook["PodBayHook<br/>(hook.js)"]
    Identity["PodBayIdentity<br/>(identity.js)"]
    TW["PodBayTableWatcher<br/>(table-watcher.js)"]
    CB["Console Bridge<br/>(console-bridge.js)"]

    SDK --> Bridge
    Bridge --> CB
    Hook --> CB
    Identity --> CB
    Identity --> TW

    style SDK fill:#2563eb,color:#fff
    style Bridge fill:#7c3aed,color:#fff
    style Hook fill:#7c3aed,color:#fff
    style Identity fill:#059669,color:#fff
    style TW fill:#d97706,color:#fff
    style CB fill:#dc2626,color:#fff
```

| Layer | Module | Depends On | Provides |
|-------|--------|------------|----------|
| 1 | Broker Client SDK | *(none)* | `window.PodBayBrokerClient` class |
| 2 | Bridge | Broker Client SDK | `window.PodBayBridge(clientId)` factory |
| 3 | Hook | *(none)* | `window.PodBayHook(target, methods, cb)` |
| 4 | Identity | *(none)* | `window.PodBayIdentity` object |
| 5 | Table Watcher | *(none, requires `cc`)* | `window.PodBayTableWatcher` |
| 6 | Console Bridge | Bridge, Hook, Identity | Broker tools: eval, get_console, run_console |

### Identity System

```mermaid
flowchart TD
    URL["Window URL Parameters"] --> Parse["Parse: windowType,<br/>window_id, _egc,<br/>game_id, room_id"]
    Parse --> WT{"windowType?"}
    WT -- "= '1'" --> Lobby["type: 'lobby'<br/>clientId: 'cwg-lobby'"]
    WT -- "≠ '1'" --> GID{"gameId?"}
    GID -- "exists" --> Table["type: 'table'<br/>clientId: 'cwg-table-{gameId}-{roomId}'"]
    GID -- "null" --> WID{"windowId?"}
    WID -- "exists" --> Window["type: 'window'<br/>clientId: 'cwg-window-{id}'"]
    WID -- "null" --> Unknown["type: 'unknown'<br/>clientId: 'cwg-{random}'"]

    Lobby --> Export["window.PodBayIdentity"]
    Table --> Export
    Window --> Export
    Unknown --> Export

    Export --> LobbyRef["lobbyClientId: 'cwg-lobby'<br/>(always available for<br/>cross-window broker calls)"]
```

### Bridge Factory

The bridge factory provides a high-level API that composes `PodBayBrokerClient`:

```mermaid
sequenceDiagram
    participant Plugin as Domain Plugin
    participant Bridge as PodBayBridge
    participant SDK as PodBayBrokerClient
    participant Broker as MCP Broker

    Plugin->>Bridge: PodBayBridge(clientId)
    Note over Bridge: Creates or returns<br/>cached bridge instance

    Plugin->>Bridge: addTool('eval', handler, desc, schema)
    Note over Bridge: Queues tool definition

    Plugin->>Bridge: connect()
    Bridge->>SDK: new PodBayBrokerClient({clientId, tools})
    SDK->>Broker: WS register

    Plugin->>Bridge: notify({level: 'error', ...})
    Bridge->>SDK: client.notify(data)
    SDK->>Broker: WS notification
```

### Hook Mechanism

```mermaid
sequenceDiagram
    participant Caller as Application Code
    participant Target as console.log
    participant Hook as PodBayHook Wrapper
    participant Original as Original console.log
    participant Callback as Notification Callback

    Caller->>Hook: console.log("hello")
    Hook->>Original: original.apply(console, args)
    Note over Original: Normal console output
    Hook->>Callback: callback('log', ['hello'])
    Callback->>Callback: bridge.notify({...})
```

---

## Docker Infrastructure

```mermaid
graph TB
    subgraph DockerNetwork["Docker Containers"]
        subgraph PodBayContainer["podbay (Node.js 18-alpine)"]
            RCProcess["reverse-client.js"]
            Pods["pods/ volume"]
            Lib["lib/ volume"]
            Registry[".opted-in.json volume"]
        end

        subgraph DashboardContainer["podbay-dashboard (nginx:alpine)"]
            Nginx["nginx :80 → :8080"]
            DashHTML["dashboard.html"]
            ConsoleHTML["console.html"]
            PodEdHTML["pod-editor.html"]
            PlugEdHTML["plugin-editor.html"]
        end
    end

    subgraph HostMachine["Host Machine"]
        Broker["MCP Broker :3099/:3098"]
        Programs["LOCALAPPDATA/Programs<br/>(Electron apps)"]
    end

    RCProcess -- "ws://host.docker.internal:3099" --> Broker
    Programs -- "/host/programs (volume)" --> PodBayContainer
    Pods -- "./pods:/app/pods" --> PodBayContainer
    Lib -- "./lib:/app/lib" --> PodBayContainer
    Registry -- ".opted-in.json" --> PodBayContainer
```

### Volumes

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `${LOCALAPPDATA}/Programs` | `/host/programs` | rw | Electron app discovery & ASAR patching |
| `./pods` | `/app/pods` | rw | Pod file persistence |
| `./lib` | `/app/lib` | rw | Live plugin code updates without rebuild |
| `./.opted-in.json` | `/app/.opted-in.json` | rw | Opt-in registry persistence |
| `./nginx.conf` | `/etc/nginx/conf.d/default.conf` | ro | nginx configuration |
| `./dashboard.html` | `.../index.html` | ro | Dashboard UI |
| `./console.html` | `.../console.html` | ro | Remote console UI |
| `./pod-editor.html` | `.../pod-editor.html` | ro | Pod editor UI |
| `./plugin-editor.html` | `.../plugin-editor.html` | ro | Plugin editor UI |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PODBAY_BROKER_URL` | `ws://localhost:3099` | Broker WebSocket URL (overridden to `ws://host.docker.internal:3099` in Docker) |
| `PODBAY_SEARCH_ROOTS` | *(none)* | Additional directories to scan for Electron apps |

---

## Dashboard & Web UI

The dashboard system is served by the `podbay-dashboard` nginx container on port `8080`.

```mermaid
flowchart LR
    subgraph Pages["Dashboard Pages"]
        Main["dashboard.html<br/>(App list, opt-in/out,<br/>pod assignment)"]
        PodEd["pod-editor.html<br/>(Create/edit pods)"]
        PlugEd["plugin-editor.html<br/>(Create/edit plugins)"]
        Console["console.html<br/>(Multi-instance tabbed<br/>remote console)"]
    end

    subgraph BrokerAPI["Broker HTTP API"]
        MCP["/mcp<br/>JSON-RPC POST"]
        Clients["/clients<br/>List broker clients"]
    end

    Main -- "podbay__list<br/>podbay__opt_in<br/>podbay__pods_assign" --> MCP
    PodEd -- "podbay__pods_get<br/>podbay__pods_save" --> MCP
    Console -- "list_broker_clients<br/>{clientId}__eval" --> MCP
    Console -- "discover instances" --> Clients
```

### Console Page Architecture

The console page provides a tabbed multi-instance remote JavaScript console:

```mermaid
flowchart TB
    Discovery["Instance Discovery<br/>(every 5s)"] --> BrokerClients["GET /clients<br/>filter: has 'eval' tool"]
    BrokerClients --> TabBar["Tab Bar<br/>(one tab per instance)"]

    TabBar --> ActiveTab["Active Tab"]
    ActiveTab --> Input["Code Input"]
    ActiveTab --> Output["Output Buffer<br/>(per-tab)"]

    Input -- "eval code" --> EvalCall["POST /mcp<br/>{clientId}__eval"]
    EvalCall --> Result["eval result"]
    Result --> Output

    Discovery --> Notifications["Notification Polling<br/>(per instance)"]
    Notifications --> Output
```

---

## Tool Registry

### PodBay Reverse Client Tools (13 tools)

| Tool | Description |
|------|-------------|
| `list` | Discover installed Electron apps with portal status |
| `opt_in` | Inject bootstrap via ASAR patch |
| `opt_out` | Restore original ASAR from backup |
| `status` | Get portal status for an app |
| `rename` | Rename an opted-in app |
| `inject` | Return combined plugin bundle for a target app |
| `pods_list` | List all `.pod` files |
| `pods_get` | Get a single pod by filename |
| `pods_save` | Create or update a `.pod` file |
| `pods_delete` | Delete a `.pod` file |
| `pods_resolve` | Preview resolved plugin code for all pods |
| `pods_assign` | Assign a pod to an opted-in app |
| `pods_unassign` | Unassign a pod from an app |
| `pods_app` | List pods assigned to an app |

### Bootstrap Tool (per window)

| Tool | Description |
|------|-------------|
| `execute_plugin` | Execute arbitrary JavaScript in the renderer |

The bootstrap registers only `execute_plugin`. All additional tools (e.g., `plugin`, `eval`, `get_console`) are pushed by the broker via `execute_plugin` and registered dynamically by the injected plugins.

### Dynamic Plugin-Registered Tools (per window)

Plugins can register additional tools at runtime via `window.PodBayBrokerClient.upsertTool()` or through the Bridge API. These appear in the broker as `{clientId}__{toolName}`.

**Console Bridge** registers:
- `eval` — Evaluate JavaScript in page context
- `get_console` — Return console page URL
- `run_console` — Open console page in browser

---

## ASAR Patch Detail

```mermaid
flowchart TD
    Original["Original app.asar"] --> Backup["app.asar.backup"]
    Original --> Extract["Extract to .work/"]
    Extract --> FindWM["Find WindowManager.js"]
    FindWM --> StripOld["Strip existing<br/>PODBAY PATCH markers"]
    StripOld --> InjectPatch["Insert patch block<br/>before window.loadURL()"]
    InjectPatch --> WritePlugin["Write podbay-portal.js<br/>alongside WindowManager.js"]
    WritePlugin --> Repack["Repack .work/ → app.asar"]
    Repack --> Cleanup["Remove .work/"]

    subgraph PatchBlock["Injected Patch Block"]
        ReadPlugin["fs.readFileSync('podbay-portal.js')"]
        OnLoad["window.webContents.on('did-finish-load')"]
        Exec["executeJavaScript(__podbayName + portalCode)"]
        ReadPlugin --> OnLoad --> Exec
    end
```

The patch adds a block between `// === PODBAY PATCH START ===` and `// === PODBAY PATCH END ===` markers in `WindowManager.js`. On every `did-finish-load` event, it reads the bootstrap file and executes it in the renderer context, optionally prefixing a `__podbayName` variable for client identification.

---

## Data Flow Summary

```mermaid
flowchart LR
    subgraph Startup["1. Startup"]
        Docker["docker compose up"] --> RC["Reverse Client<br/>registers 13 tools"]
    end

    subgraph OptIn["2. Opt-In"]
        Agent["AI Agent / Dashboard"] --> BrokerOI["podbay__opt_in"]
        BrokerOI --> ASAR["ASAR Patched"]
    end

    subgraph Launch["3. App Launch"]
        ASAR --> Electron["Electron loads<br/>patched ASAR"]
        Electron --> BS["Bootstrap<br/>injected per window"]
    end

    subgraph Inject["4. Plugin Push"]
        BS --> Push["Broker pushes plugins<br/>via execute_plugin"]
        Push --> Bundle["Pod bundle<br/>assembled"]
        Bundle --> Eval["eval(bundle)<br/>plugins activate"]
    end

    subgraph Runtime["5. Runtime"]
        Eval --> Tools["Plugin tools<br/>available via broker"]
        Eval --> Hooks["Console hooks<br/>→ notifications"]
        Eval --> State["Table state<br/>extraction"]
    end
```
