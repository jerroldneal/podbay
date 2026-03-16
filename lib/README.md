# lib/

Shared library modules loaded by plugins and the broker host.

| File | Purpose |
|------|---------|
| `bridge.js` | Reusable broker bridge factory (`PodBayBridge`). Singleton-per-client, tool registration, JSON Schema auto-wrap. |
| `broker-client.js` | Low-level broker WebSocket client (`PodBayBrokerClient`). The raw transport layer that `bridge.js` wraps. |
| `hook.js` | Cocos2d `cc.Sprite` property setter interceptor. Used for card capture hooks. |
| `pods.js` | Pod loading and management utilities. |
| `discover.js` | Service/host discovery helpers. |
| `greeting.js` | Demo/recipe client — direct `PodBayBrokerClient` usage without the bridge factory. |
| `portal-payload.js` | Portal message payload construction and parsing. |
| `system-plugin.js` | System-level plugin bootstrap. |
| `asar.js` | ASAR archive utilities. |

---

## plugins/ — Bridge Usage Table

Which plugins use `PodBayBridge` (from `bridge.js`) and which don't, and why.

### Top-level plugins

| File | Uses Bridge | Reason if not |
|------|:-----------:|---------------|
| `broker-dashboard.js` | ✅ | Registers MCP tool to open the broker dashboard |
| `console-bridge.js` | ✅ | Registers console tools via the broker |
| `cwg-action.js` | ✅ | Registers poker action tools (fold, call, raise, etc.) |
| `card-reveal-hook.js` | ❌ | Raw Cocos2d engine interceptor — captures the ~1ms card reveal window. Pure observer; writes to `window.PodBayCardRevealLog`. No tools to expose. |
| `cwg-card-reveal-minimal.js` | ❌ | Minimal standalone reimplementation of the card reveal technique. Exposes `window.__allCards` and `window.__cardLog` directly. No broker needed. |
| `identity.js` | ❌ | Pure utility — detects window identity from URL params and exposes `window.PodBayIdentity`. It's the *input* consumed by bridge-using plugins, not a broker client itself. |
| `greeting.js` | ❌ | Intentional recipe/demo showing direct `PodBayBrokerClient` usage without the factory. Documents the underlying API. |
| `table-watcher.js` | ❌ | Cocos2d scene graph scraper — a read sensor exposing `PodBayTableWatcher.snapshot()` and `gameStatus()` for other plugins to consume. Nothing to register. |

### cwg/ sub-plugins

| File | Uses Bridge | Reason if not |
|------|:-----------:|---------------|
| `cwg-action-log.js` | ✅ | Exposes action log tools via broker |
| `cwg-action-validator.js` | ✅ | Exposes validation tools via broker |
| `cwg-allin.js` | ✅ | Registers all-in action tool |
| `cwg-bet.js` | ✅ | Registers bet action tool |
| `cwg-bet-state.js` | ✅ | Exposes bet state query tool |
| `cwg-call.js` | ✅ | Registers call action tool |
| `cwg-check.js` | ✅ | Registers check action tool |
| `cwg-flip-hook.js` | ✅ | Registers flip/card reveal hook tool |
| `cwg-fold.js` | ✅ | Registers fold action tool |
| `cwg-hand-result.js` | ✅ | Exposes hand result query tool |
| `cwg-lobby-control.js` | ✅ | Registers lobby control tools |
| `cwg-lobby-status.js` | ✅ | Exposes lobby status query tool |
| `cwg-my-cards.js` | ✅ | Exposes hole card query tool |
| `cwg-node-inspector.js` | ✅ | Registers Cocos2d node inspection tool |
| `cwg-pre-call.js` | ✅ | Registers pre-action call tool |
| `cwg-pre-check.js` | ✅ | Registers pre-action check tool |
| `cwg-pre-fold.js` | ✅ | Registers pre-action fold tool |
| `cwg-pre-raise.js` | ✅ | Registers pre-action raise tool |
| `cwg-raise.js` | ✅ | Registers raise action tool |
| `cwg-smoke-test.js` | ✅ | Registers environment smoke test tool |
| `cwg-table-state.js` | ✅ | Exposes full table state query tool |
| `cwg-tournament-status.js` | ✅ | Exposes tournament status query tool |
| `cwg-verbose-hook.js` | ✅ | Registers verbose event hook tool |
| `cwg-websocket-inspector.js` | ✅ | Registers WebSocket message inspection tool |
| `cwg-action-core.js` | ❌ | Infrastructure — shared button-click abstraction used by action plugins. No tools of its own. |
| `cwg-card-atlas.js` | ❌ | Pure data table — maps Cocos2d sprite frame IDs to card names (e.g. frame 130 → A♠). Static lookup; nothing to expose via MCP. |
| `cwg-core.js` | ❌ | Infrastructure — scene traversal utilities for table windows. Shared foundation consumed by other plugins. |
| `cwg-game-status.js` | ❌ | State manager — parses protobuf messages into structured game state on `window.CWGGameStatus`. Data provider, not a broker client. |
| `cwg-hand-lifecycle.js` | ❌ | State manager — tracks hand index and detects new-hand transitions. Exposes `CWGHandLifecycle` for other plugins to read. |
| `cwg-opponent-cards.js` | ❌ | State manager — tracks opponent card reveals via the sprite hook. Maintains a rolling log on `window.CWGOpponentCards`. |
| `cwg-proto-action.js` | ❌ | State manager — parses protobuf action messages and publishes structured events. Consumed by action plugins. |
| `cwg-proto-action-amount.js` | ❌ | State manager — derives bet/raise amounts from protobuf action stream. Data provider only. |
| `cwg-proto-tap.js` | ❌ | Infrastructure — WebSocket message interceptor and protobuf message type registry. The tap layer that all proto-* plugins build on. |
| `cwg-room-config.js` | ❌ | State manager — parses room configuration from protobuf messages. Exposes `CWGRoomConfig` for other plugins. |
| `cwg-strategy-hook.js` | ❌ | State manager — fires strategy decision callbacks when `CWGGameStatus` updates. Event bus, not a broker client. |

---

## Architecture Notes

The dividing line between bridge and non-bridge files is consistent:

- **Uses bridge** → the plugin exposes one or more MCP tools callable by the AI via the broker.
- **No bridge** → the plugin is infrastructure (shared utilities, data tables, engine interceptors) or a state manager (parses game data and publishes it to `window.*` globals for other plugins to read).

Bridge-using plugins depend on both `PodBayBridge` (this lib) and `PodBayIdentity` (`plugins/identity.js`) to get the correct per-window `clientId`.
