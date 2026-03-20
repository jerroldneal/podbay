# PodBay Plugin Manual

> Complete reference for every plugin available in PodBay. Each entry documents the plugin's purpose, dependencies, window exports, MCP tools registered, and which pod files include it.

---

## Table of Contents

1. [Infrastructure Plugins](#infrastructure-plugins)
   - [Broker Client SDK](#broker-client-sdk)
   - [Bridge Factory](#bridge-factory)
   - [Hook](#hook)
   - [Identity](#identity)
2. [Console & Debug Plugins](#console--debug-plugins)
   - [Console Bridge](#console-bridge)
   - [Broker Dashboard](#broker-dashboard)
   - [Table Watcher](#table-watcher)
   - [Greeting (Example)](#greeting-example)
3. [CWG Card Plugins](#cwg-card-plugins)
   - [Card Reveal Hook](#card-reveal-hook)
   - [CWG Card Reveal Minimal](#cwg-card-reveal-minimal)
4. [CWG Action Plugins](#cwg-action-plugins)
   - [CWG Action (Legacy)](#cwg-action-legacy)
5. [CWG SRP Plugin Library](#cwg-srp-plugin-library)
   - [Core Utilities](#core-utilities)
   - [Protocol & Wire](#protocol--wire)
   - [Game State](#game-state)
   - [Card Observation](#card-observation)
   - [Action Tools](#action-tools)
   - [Pre-Action Toggles](#pre-action-toggles)
   - [Inspection & Debugging](#inspection--debugging)
   - [Strategy](#strategy)
6. [Pod File Reference](#pod-file-reference)

---

## Infrastructure Plugins

These are the foundational plugins loaded first in most pods. They provide broker connectivity, tool registration, method interception, and window identity.

### Broker Client SDK

| | |
|---|---|
| **File** | `lib/broker-client.js` |
| **Window Export** | `window.PodBayBrokerClient` |
| **Dependencies** | None |
| **MCP Tools** | None (provides the SDK for other plugins to register tools) |

Reusable WebSocket client class that connects to the MCP broker. Provides tool registration (`upsertTool`), notification sending (`notify`), and reconnection with exponential backoff. Every plugin that publishes MCP tools depends on this SDK.

**Pods**: `console.pod`, `card-capture.pod`, `example.pod`, `cwg-plugin-library.pod`

---

### Bridge Factory

| | |
|---|---|
| **File** | `lib/bridge.js` |
| **Window Export** | `window.PodBayBridge(clientId)` |
| **Dependencies** | Broker Client SDK |
| **MCP Tools** | None (provides `addTool()`, `connect()`, `notify()` API) |

High-level factory that wraps `PodBayBrokerClient`. Plugins call `PodBayBridge(clientId)` to get a cached bridge instance, then `addTool(name, handler, desc, schema)` to declare tools, and `connect()` to register them all at once. Handles tool queuing and JSON-safe formatting via `fmt()`.

**Pods**: `console.pod`

---

### Hook

| | |
|---|---|
| **File** | `lib/hook.js` |
| **Window Export** | `window.PodBayHook(target, methods, callback)` |
| **Dependencies** | None |
| **MCP Tools** | None |

Generalized method interception utility. Wraps specified methods on a target object, calling the original and then a callback with `(methodName, args)`. Used by Console Bridge to hook `console.log/error/warn/info` and forward them as broker notifications.

**Pods**: `console.pod`

---

### Identity

| | |
|---|---|
| **File** | `plugins/identity.js` |
| **Window Export** | `window.PodBayIdentity` |
| **Dependencies** | None |
| **MCP Tools** | None |

Detects window identity from URL parameters (`windowType`, `game_id`, `_egc`, `window_id`, `room_id`). Exposes a stable `clientId` used by all other plugins for broker registration.

| Property | Example | Description |
|----------|---------|-------------|
| `clientId` | `cwg-lobby`, `cwg-table-123-456` | Stable broker client ID |
| `type` | `lobby`, `table`, `window`, `unknown` | Window classification |
| `gameId` | `123` or `null` | Game ID from URL |
| `roomId` | `456` or `null` | Room ID from URL |
| `title` | *(live getter)* | Current `document.title` |
| `isLobby` | `true`/`false` | Shorthand for `type === 'lobby'` |
| `isGame` | `true`/`false` | Shorthand for `type === 'table'` |
| `lobbyClientId` | `cwg-lobby` | Always available for cross-window calls |

**Pods**: `console.pod`

---

## Console & Debug Plugins

### Console Bridge

| | |
|---|---|
| **File** | `plugins/console-bridge.js` |
| **Window Export** | None (composes Bridge + Hook + Identity) |
| **Dependencies** | Bridge Factory, Hook, Identity |
| **MCP Tools** | `eval`, `get_console`, `run_console` |

Provides a remote JavaScript console. Hooks `console.log/error/warn/info` and forwards them as broker notifications. Uses the Identity plugin's `clientId` for broker registration (e.g., `cwg-lobby__eval`).

| Tool | Description |
|------|-------------|
| `eval` | Evaluate JavaScript in the page context. Returns `{success, result, type}` or `{success: false, error, stack}` |
| `get_console` | Returns the URL for the remote console page (`http://localhost:8080/console.html`) |
| `run_console` | Opens the remote console page in a new browser tab |

**Pods**: `console.pod`

---

### Broker Dashboard

| | |
|---|---|
| **File** | `plugins/broker-dashboard.js` |
| **Window Export** | `window.__podBayBrokerDashboardInstalled` |
| **Dependencies** | Bridge Factory, Identity |
| **MCP Tools** | *(via embedded dashboard popup)* |

Opens the broker telemetry dashboard as a same-origin popup window. The dashboard HTML is embedded directly in the plugin source so it can access `window.opener.PodBayBrokerTelemetry` without CORS restrictions. Shows connected clients, tool call counts, errors, and live telemetry.

**Pods**: `cwg-action.pod`

---

### Table Watcher

| | |
|---|---|
| **File** | `plugins/table-watcher.js` |
| **Window Export** | `window.PodBayTableWatcher` |
| **Dependencies** | `cc` (Cocos2d engine) |
| **MCP Tools** | None (provides `snapshot()` and `gameStatus()` API) |

Extracts poker table state from the Cocos2d scene graph. Reads player seats, hole cards, community cards, pot, dealer/SB/BB positions, and active turn. Skips lobby windows (`windowType=1`).

| Method | Description |
|--------|-------------|
| `snapshot()` | Raw scene data extraction |
| `gameStatus()` | Structured game state (players, cards, pot, positions) |

**Pods**: `console.pod`

---

### Greeting (Example)

| | |
|---|---|
| **File** | `plugins/greeting.js` |
| **Window Export** | None |
| **Dependencies** | Broker Client SDK |
| **MCP Tools** | `say_hello` |

Minimal example plugin demonstrating broker client SDK usage. Registers a single `say_hello` tool that returns a greeting.

**Pods**: `example.pod`

---

## CWG Card Plugins

### Card Reveal Hook

| | |
|---|---|
| **File** | `plugins/card-reveal-hook.js` |
| **Window Export** | `window.PodBayCardRevealHook`, `window.PodBayCardRevealLog` |
| **Dependencies** | `cc` (Cocos2d), Broker Client SDK |
| **MCP Tools** | `get_card_log`, `clear_card_log` |

Intercepts `cc.Sprite.prototype` spriteFrame assignments to capture the ~1ms window where the Cocos2d engine briefly exposes a card's true identity before covering it with `cards_back_0`. This is the only reliable method to observe opponent hole cards — polling at frame rate (~16ms) would miss the sub-millisecond face assignment.

| Tool | Description |
|------|-------------|
| `get_card_log` | Full reveal log (or last N entries) |
| `clear_card_log` | Reset the capture log |

Control API: `status()`, `clear()`, `pause()`, `resume()`

**Pods**: `card-capture.pod`

---

### CWG Card Reveal Minimal

| | |
|---|---|
| **File** | `plugins/cwg-card-reveal-minimal.js` |
| **Window Export** | `window.__allCards`, `window.__cardLog`, `window.__cardHookOk` |
| **Dependencies** | `cc` (Cocos2d), Broker Client SDK |
| **MCP Tools** | `get_all_cards`, `get_card_log`, `clear_cards`, `get_hook_status` |

Standalone minimal card capture implementation. Uses the same spriteFrame hook technique as Card Reveal Hook but with a simpler, self-contained design. Handles dual-layout dedup (normal + celebrity card layouts), seat attribution via parent chain walking, and community card detection.

| Tool | Description |
|------|-------------|
| `get_all_cards` | Current hand's cards per seat (`seat_0..N`, `community`) |
| `get_card_log` | Rolling 50-event log with optional seat/last filters |
| `clear_cards` | Reset all card state for a new hand |
| `get_hook_status` | Hook installation status + seat/log counts |

**Pods**: *(standalone — not currently in a standard pod)*

---

## CWG Action Plugins

### CWG Action (Legacy)

| | |
|---|---|
| **File** | `plugins/cwg-action.js` |
| **Window Export** | `window.__cwgActionInstalled` |
| **Dependencies** | Identity (`isGame` guard) |
| **MCP Tools** | `fold`, `call`, `check`, `raise`, `allin` (via direct button lookup) |

Legacy monolithic action plugin. Finds Cocos2d button nodes by name (`giveUpRed`, `followFl_Blue`, `free_bet_button`, `raise_button_img`, `allin`) and clicks them via `cc.Button._releaseAction()`. Superseded by the SRP action modules in `plugins/cwg/` but still used in `console.pod` and `cwg-action.pod`.

**Pods**: `console.pod`, `cwg-action.pod`

---

## CWG SRP Plugin Library

The `plugins/cwg/` directory contains a decomposed, single-responsibility plugin library for ClubWPT Gold. Each plugin does one thing. They are assembled together in the `cwg-plugin-library.pod`. Load order matters — dependencies must appear before consumers.

### Core Utilities

#### CWG Core

| | |
|---|---|
| **File** | `plugins/cwg/cwg-core.js` |
| **Window Export** | `window.CWGCore` |
| **Dependencies** | `cc` (Cocos2d) |
| **MCP Tools** | None |

Shared Cocos2d scene utilities: `getScene()`, `findNode(root, name)` (BFS), `getText(node)`, `getGameView()`, `nodeChildren()`, `nodeName()`, `enableParentChain()`. Used by virtually every other CWG plugin.

#### CWG Card Atlas

| | |
|---|---|
| **File** | `plugins/cwg/cwg-card-atlas.js` |
| **Window Export** | `window.CWGCardAtlas` |
| **Dependencies** | None |
| **MCP Tools** | None |

Maps Cocos2d atlas frame IDs to human-readable card strings. Frame ranges: ♦ 18–30, ♣ 34–46, ♥ 66–78, ♠ 130–142. Provides `decode(frameId)` → `"A♠"` and `isBackFace(sfName)`.

#### CWG Hand Lifecycle

| | |
|---|---|
| **File** | `plugins/cwg/cwg-hand-lifecycle.js` |
| **Window Export** | `window.CWGHandLifecycle` |
| **Dependencies** | None |
| **MCP Tools** | None |

Tracks the current hand index. Debounced incrementing (800ms) triggered by end-of-hand cover sequences. Clears per-hand face tracking on new hand. All per-hand state plugins read `handIndex` from here.

#### CWG Action Core

| | |
|---|---|
| **File** | `plugins/cwg/cwg-action-core.js` |
| **Window Export** | `window.CWGActionCore` |
| **Dependencies** | CWG Core, `cc` (Cocos2d) |
| **MCP Tools** | None |

Shared button finder and clicker. Tries three click strategies in order: `_releaseAction()`, `clickEvents.emit()`, `node.emit('click')`. Provides `click(nodeNames[])` and `getActionPanelComp()`. Used by all individual action plugins (fold, call, check, bet, raise, allin).

---

### Protocol & Wire

#### CWG WebSocket Inspector

| | |
|---|---|
| **File** | `plugins/cwg/cwg-websocket-inspector.js` |
| **Window Export** | `window.CWGWebSocketInspector` |
| **Dependencies** | Bridge, Identity |
| **MCP Tools** | `get_websocket_connections`, `get_websocket_connection`, `clear_closed_websockets` |

Patches `window.WebSocket` constructor to track all WS connections: URL, readyState, message counts (in/out), last message timestamp. Useful for debugging connection issues.

#### CWG Proto Tap

| | |
|---|---|
| **File** | `plugins/cwg/cwg-proto-tap.js` |
| **Window Export** | `window.CWGProtoTap` |
| **Dependencies** | Bridge, Identity |
| **MCP Tools** | 5 tools (message log, filtering, subscriptions) |

WebSocket interceptor that patches the WS constructor and `prototype.send`. Decodes CWG protobuf wire frames (4-byte length + 2-byte msgId + body). Provides an event bus (`CWGProtoTap.on(msgName, callback)`) that other plugins subscribe to for real-time game events. This is the backbone of all protobuf-based state tracking.

#### CWG Proto Action

| | |
|---|---|
| **File** | `plugins/cwg/cwg-proto-action.js` |
| **Window Export** | `window.CWGProtoAction` |
| **Dependencies** | CWG Proto Tap, CWG Game Status, Bridge, Identity |
| **MCP Tools** | 7 tools (`proto_fold`, `proto_check`, `proto_call`, `proto_bet`, `proto_raise`, `proto_allin`, `get_action_constraints`) |

Wire-level action sender. Constructs and sends ActionReq protobuf frames directly over the game WebSocket, bypassing the Cocos2d UI entirely. Gates all actions on `isHeroTurn`. Falls back to DOM click if wire send fails. Captures ActionRes for confirmation.

#### CWG Proto Action Amount

| | |
|---|---|
| **File** | `plugins/cwg/cwg-proto-action-amount.js` |
| **Window Export** | `window.CWGProtoActionAmount` |
| **Dependencies** | CWG Game Status, Bridge, Identity |
| **MCP Tools** | `resolve_amount`, `proto_bet_amount`, `proto_raise_amount` |

Smart bet sizing resolver. Converts human-friendly expressions (`'pot'`, `'half'`, `'2bb'`, `'75%'`, `'3x'`, raw chip numbers) to exact chip amounts based on current game state (pot, blinds, stack).

---

### Game State

#### CWG Game Status

| | |
|---|---|
| **File** | `plugins/cwg/cwg-game-status.js` |
| **Window Export** | `window.CWGGameStatus` |
| **Dependencies** | CWG Proto Tap, Bridge, Identity |
| **MCP Tools** | `get_game_status`, `get_hero_cards`, `get_community_cards` |

Accumulated game status snapshot built from protobuf wire events. Maintains phase (preflop/flop/turn/river), seat data (stack, bet, status), pot, community cards, hero hole cards, action constraints (min/max raise, call amount), and `isHeroTurn` flag. The primary state source for all action plugins and validators.

#### CWG Room Config

| | |
|---|---|
| **File** | `plugins/cwg/cwg-room-config.js` |
| **Window Export** | `window.CWGRoomConfig` |
| **Dependencies** | CWG Proto Tap, Bridge, Identity |
| **MCP Tools** | `get_room_config` |

Room configuration snapshot from `EnterRoomRes`/`RoomSnapshotMsg`: roomId, gameType, limitType, blinds, ante, buyIn range, seat count, timeLimit, tourId, tourName.

#### CWG Tournament Status

| | |
|---|---|
| **File** | `plugins/cwg/cwg-tournament-status.js` |
| **Window Export** | `window.CWGTournamentStatus` |
| **Dependencies** | CWG Proto Tap, Bridge, Identity |
| **MCP Tools** | `get_tournament_status`, `get_blind_schedule`, `get_tournament_players` |

Tournament structure and live progress: blind level, SB/BB/ante, level time remaining, players entered/running/eliminated, prize pool, hero M-ratio and rank.

#### CWG Bet State

| | |
|---|---|
| **File** | `plugins/cwg/cwg-bet-state.js` |
| **Window Export** | `window.CWGBetState` |
| **Dependencies** | CWG Core, Bridge, Identity |
| **MCP Tools** | `get_bet_state` |

Reads call amount, raise amount, pot, and bet slider state from the Cocos2d UI. Complements the protobuf-based game status with live UI state.

#### CWG Table State

| | |
|---|---|
| **File** | `plugins/cwg/cwg-table-state.js` |
| **Window Export** | `window.CWGTableState` |
| **Dependencies** | CWG Core, Bridge, Identity |
| **MCP Tools** | `get_table_state` |

Structured table snapshot from the scene graph: player names, stacks, community cards, pot, street, dealer/SB/BB positions.

#### CWG Lobby Status

| | |
|---|---|
| **File** | `plugins/cwg/cwg-lobby-status.js` |
| **Window Export** | `window.CWGLobbyStatus` |
| **Dependencies** | CWG Proto Tap, Bridge, Identity |
| **MCP Tools** | `get_account_info`, `get_lobby_tournaments` |

Lobby and account visibility. Captures hero display name, userId, chip balance (free/paid/total) from `EnterRoomRes`/`PlayerInfo`. Also tracks the observed tournament list from lobby-level messages.

#### CWG Hand Result

| | |
|---|---|
| **File** | `plugins/cwg/cwg-hand-result.js` |
| **Window Export** | `window.CWGHandResult` |
| **Dependencies** | CWG Proto Tap, CWG Game Status, Bridge, Identity |
| **MCP Tools** | `get_last_hand`, `get_hand_history`, `clear_hand_history` |

Complete hand history recorder. Accumulates community cards, hole cards at showdown, all actions in sequence, pot distribution, winners with hand type. Ring buffer of the last 50 hands.

---

### Card Observation

#### CWG My Cards

| | |
|---|---|
| **File** | `plugins/cwg/cwg-my-cards.js` |
| **Window Export** | `window.CWGMyCards` |
| **Dependencies** | CWG Core, CWG Card Atlas, Bridge, Identity |
| **MCP Tools** | `get_my_cards` |

Reads hero hole cards from the Cocos2d scene graph by finding `holdem_card` nodes and decoding their sprite frame IDs.

#### CWG Opponent Cards

| | |
|---|---|
| **File** | `plugins/cwg/cwg-opponent-cards.js` |
| **Window Export** | `window.CWGOpponentCards` |
| **Dependencies** | CWG Card Atlas, CWG Hand Lifecycle, CWG Flip Hook, Bridge, Identity |
| **MCP Tools** | `get_card_log`, `get_opponent_hole_cards`, `clear_card_log` |

Intercepts `cc.Sprite.prototype.spriteFrame` setter to capture opponent hole cards during the ~1ms face-reveal window. Uses seat attribution via parent chain walking (`holdem_player_pkw` nodes). Handles end-of-hand cover detection with a 50ms threshold.

#### CWG Flip Hook

| | |
|---|---|
| **File** | `plugins/cwg/cwg-flip-hook.js` |
| **Window Export** | `window.CWGFlipHook` |
| **Dependencies** | None (requires `cc` Cocos2d) |
| **MCP Tools** | `get_flip_log` |

Patches `flipCardAction` prototype to log all card flip animations. Populates pending-flip state consumed by CWG Opponent Cards to correlate sprite changes with deal events.

---

### Action Tools

Each action plugin registers a single MCP tool via the Bridge API. They all depend on CWG Action Core for the actual button clicking.

#### CWG Fold

| | |
|---|---|
| **File** | `plugins/cwg/cwg-fold.js` |
| **MCP Tools** | `fold` — Fold the current hand |
| **Button nodes** | `giveUpRed`, `giveupred` |

#### CWG Call

| | |
|---|---|
| **File** | `plugins/cwg/cwg-call.js` |
| **MCP Tools** | `call` — Call the current bet |
| **Button nodes** | `callBtn`, `followFl_Blue` |

#### CWG Check

| | |
|---|---|
| **File** | `plugins/cwg/cwg-check.js` |
| **MCP Tools** | `check` — Check (pass) when no bet is pending |
| **Button nodes** | `checkBtn`, `free_bet_button` |

#### CWG Bet

| | |
|---|---|
| **File** | `plugins/cwg/cwg-bet.js` |
| **MCP Tools** | `bet` — Set bet amount and confirm |
| **Supports** | Number, `pot`, `half`, `min`, `max`, `Nbb` expressions |

Interacts with the bet slider component (`betSlider` / `BetSliderLandscape`) to set the bet amount, then confirms.

#### CWG Raise

| | |
|---|---|
| **File** | `plugins/cwg/cwg-raise.js` |
| **MCP Tools** | `raise` — Set raise amount and confirm |
| **Supports** | Number, `pot`, `half`, `min`, `max`, `Nbb` expressions |

#### CWG All-In

| | |
|---|---|
| **File** | `plugins/cwg/cwg-allin.js` |
| **MCP Tools** | `allin` — Go all-in with full chip stack |
| **Button nodes** | `AllInBtn`, `allin`, `all_in` |

---

### Pre-Action Toggles

Pre-action plugins arm or disarm pre-action toggles (the checkboxes that auto-act when it's your turn).

#### CWG Pre-Fold

| | |
|---|---|
| **File** | `plugins/cwg/cwg-pre-fold.js` |
| **MCP Tools** | `pre_fold` — Arm or disarm the pre-fold toggle |

#### CWG Pre-Call

| | |
|---|---|
| **File** | `plugins/cwg/cwg-pre-call.js` |
| **MCP Tools** | `pre_call` — Arm or disarm the pre-call toggle |

#### CWG Pre-Check

| | |
|---|---|
| **File** | `plugins/cwg/cwg-pre-check.js` |
| **MCP Tools** | `pre_check` — Arm or disarm the pre-check toggle (tries `prebetCheck` then `prebetCheckOrFold`) |

#### CWG Pre-Raise

| | |
|---|---|
| **File** | `plugins/cwg/cwg-pre-raise.js` |
| **MCP Tools** | `pre_raise` — Arm or disarm the pre-all-in toggle |

---

### Inspection & Debugging

#### CWG Action Validator

| | |
|---|---|
| **File** | `plugins/cwg/cwg-action-validator.js` |
| **Window Export** | `window.CWGActionValidator` |
| **Dependencies** | CWG Game Status, Bridge, Identity |
| **MCP Tools** | `validate_action`, `get_legal_actions` |

Pre-flight action validator. Checks whether fold/check/call/bet/raise/allin is legal given current game state. Returns `{valid, reason}`. `get_legal_actions` returns all currently available actions and their constraints.

#### CWG Action Log

| | |
|---|---|
| **File** | `plugins/cwg/cwg-action-log.js` |
| **Window Export** | `window.CWGActionLog` |
| **Dependencies** | CWG Proto Tap, CWG Game Status, Bridge, Identity |
| **MCP Tools** | `get_action_log`, `get_last_action_result_log`, `clear_action_log` |

Hero action history with ActionRes codes. Records hero actions with street, pot, stack, and server result. Ring buffer of 200 entries.

#### CWG Node Inspector

| | |
|---|---|
| **File** | `plugins/cwg/cwg-node-inspector.js` |
| **Window Export** | `window.CWGNodeInspector` |
| **Dependencies** | Bridge, Identity |
| **MCP Tools** | `set_node_inspect`, `get_node_inspect_log`, `get_last_clicked_node`, `clear_node_inspect_log` |

Click-to-inspect tool for Cocos2d development. Hooks `cc.Node._onTouchBegan` to capture clicked node details: name, uuid, parent chain, components, position, size, children. Toggle on/off via `set_node_inspect`.

#### CWG WebSocket Inspector

| | |
|---|---|
| **File** | `plugins/cwg/cwg-websocket-inspector.js` |
| **Window Export** | `window.CWGWebSocketInspector` |
| **Dependencies** | Bridge, Identity |
| **MCP Tools** | `get_websocket_connections`, `get_websocket_connection`, `clear_closed_websockets` |

Tracks all WebSocket connections created in the window. Reports URL, readyState, message counts, timestamps.

#### CWG Verbose Hook

| | |
|---|---|
| **File** | `plugins/cwg/cwg-verbose-hook.js` |
| **Window Export** | `window.CWGVerboseHook` |
| **Dependencies** | Bridge, Identity |
| **MCP Tools** | `set_verbose_log`, `get_verbose_log` |

Verbose logging of all `Holdem_Card_ts` method calls. Useful for reverse-engineering card animation sequences and understanding the engine's card lifecycle.

#### CWG Smoke Test

| | |
|---|---|
| **File** | `plugins/cwg/cwg-smoke-test.js` |
| **Window Export** | `window.CWGSmokeTest` |
| **Dependencies** | All CWG infrastructure globals |
| **MCP Tools** | `run_smoke_test` |

Verifies all infrastructure globals and hook plugins are loaded correctly. Checks for the presence of CWGCore, CWGCardAtlas, CWGHandLifecycle, CWGActionCore, CWGProtoTap, CWGGameStatus, etc. Returns a pass/fail report.

---

### Strategy

#### CWG Strategy Hook

| | |
|---|---|
| **File** | `plugins/cwg/cwg-strategy-hook.js` |
| **Window Export** | `window.CWGStrategyHook` |
| **Dependencies** | CWG Game Status, CWG Action Validator, Bridge, Identity |
| **MCP Tools** | `set_strategy_mode`, `get_strategy_decision`, `get_strategy_status` |

External strategy plug-in point. Supports three modes:
- `off` — No auto-action, purely observational
- `validate_only` — Validates strategy decisions but doesn't execute
- `auto` — Automatically executes strategy decisions when it's hero's turn

Built-in strategies: `always_fold`, `passive`, `tight_fold`. Also supports custom strategy functions for external AI integration.

---

### CWG Lobby Control

| | |
|---|---|
| **File** | `plugins/cwg/cwg-lobby-control.js` |
| **Window Export** | `window.CWGLobbyControl` |
| **Dependencies** | CWG Proto Tap, CWG Game Status, Bridge, Identity |
| **MCP Tools** | `leave_room`, `request_room_snapshot` |

Lobby-level controls. Sends `LeaveRoomReq` (gated on `isHeroTurn === false` to prevent leaving mid-hand) and `RoomSnapshotReq` protobuf frames over the game WebSocket.

---

## Pod File Reference

Pod files live in `pods/` and assemble plugins into composable bundles. Plugins execute top-to-bottom.

### console.pod

**Description**: Remote JavaScript console — eval tool, console hooks, and browser terminal UI

| # | Plugin | File |
|---|--------|------|
| 1 | Broker Client SDK | `lib/broker-client.js` |
| 2 | Bridge Factory | `lib/bridge.js` |
| 3 | Hook | `lib/hook.js` |
| 4 | Identity | `plugins/identity.js` |
| 5 | Table Watcher | `plugins/table-watcher.js` |
| 6 | CWG Action (Legacy) | `plugins/cwg-action.js` |
| 7 | Console Bridge | `plugins/console-bridge.js` |

### cwg-plugin-library.pod

**Description**: Full CWG SRP plugin library — observation, precise actions, protobuf wire interception

Contains **35 plugins** covering the complete CWG toolset: WebSocket inspection, protobuf decoding, game status, room config, tournament status, wire-level actions, smart bet sizing, hand history, action logging, node inspection, action validation, lobby control, scene utilities, card atlas, hand lifecycle, action core, bet state, table state, card observation (hero + opponent), flip hooks, verbose logging, all 6 action tools, all 4 pre-action toggles, lobby status, strategy hook, and smoke test. See the [CWG SRP Plugin Library](#cwg-srp-plugin-library) section for individual details.

### card-capture.pod

**Description**: Opponent hole card capture via spriteFrame hook

| # | Plugin | File |
|---|--------|------|
| 1 | Broker Client SDK | `lib/broker-client.js` |
| 2 | Card Reveal Hook | `plugins/card-reveal-hook.js` |

### cwg-action.pod

**Description**: Poker button-clicking tools with broker telemetry

| # | Plugin | File |
|---|--------|------|
| 1 | CWG Action (Legacy) | `plugins/cwg-action.js` |
| 2 | Broker Dashboard | `plugins/broker-dashboard.js` |

### cwg-debug.pod

**Description**: ClubWPT Gold debug tools (room ID badge)

| # | Plugin | File |
|---|--------|------|
| 1 | Room ID Badge | *(inline code)* |

Displays a floating room/table ID badge on game windows. Extracts the room ID from game status, URL params, Cocos2d scene components, or room text labels.

### example.pod

**Description**: Example pod demonstrating broker client SDK usage

| # | Plugin | File |
|---|--------|------|
| 1 | Broker Client SDK | `lib/broker-client.js` |
| 2 | Greeting | `lib/greeting.js` |
