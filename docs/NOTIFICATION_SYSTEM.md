# PodBay Notification System

**Date:** 2026-04-25
**Status:** Existing implementation — documented for extension

---

## Overview

The broker is already a real-time event bus. Any registered broker-client can push
notifications to the broker, which fans them out to every subscriber. The pattern is
push-only: no polling, no request/response — fire and forget with an ack.

```
Plugin / browser client                  Broker                        MCP client / Node.js SDK
─────────────────────────                ──────────────────            ──────────────────────────
notify({ type, ...payload })  ─── WS ──▶ store + broadcast ─── WS ──▶ subscribed client receives
                                                           ─── SSE ──▶ dashboard receives
```

---

## Message Protocol (WebSocket JSON)

### Send a notification (client → broker)

```json
{ "type": "notification", "event": { "type": "gameState/change", "data": { ... } } }
```

- Sender must be registered first (`{ type: "register", clientId, tools }`)
- `event` is freeform; `event.type` is used as a display label in the activity log
- Acknowledged immediately: `{ "type": "notification_ack", "timestamp": "..." }`

### Subscribe to notifications (subscriber → broker)

```json
{ "type": "subscribe", "clientIds": ["poker-table-1", "poker-table-2"] }
```

- Use `"*"` to receive notifications from **all** clients
- Confirmed: `{ "type": "subscribed", "subscriptions": [...] }`
- Unsubscribe: `{ "type": "unsubscribe" }`

### Incoming notification (broker → subscriber)

```json
{
  "type": "notification",
  "clientId": "poker-table-1",
  "event": { "type": "gameState/change", "data": { ... } },
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

---

## Broker Storage & Delivery (`workshops/mcp-broker/server.js`)

| Mechanism | Destination | Capacity |
|-----------|-------------|----------|
| Per-client ring buffer | queryable later | 100 notifications |
| Global ring buffer | queryable later | 500 notifications |
| SSE broadcast | dashboard page | real-time |
| WS broadcast | subscribed registered clients | real-time |

Delivery function: `broadcastNotification(notification)` — iterates `wsSubscriptions`
(subscriber WS → `Set<clientId|'*'>`) and SSE `sseClients`.

---

## Browser Plugin Side (`plugins/broker-client-sdk.js`)

`PodBayBrokerClient` is the SDK for browser-injected plugins. It manages the WebSocket
lifecycle and exposes:

```js
var client = new PodBayBrokerClient({ clientId: 'my-plugin' });
client.connect();

// Send a notification
client.notify({ type: 'gameState/change', street: 'flop', pot: '1200' });
```

`notify(data)` sends `{ type: 'notification', data }` only when the WebSocket is open
(`readyState === 1`). Calls are silently dropped if disconnected.

Available inside any plugin via `require('broker-client-sdk')` once the PodBay bootstrap
is installed.

---

## Bootstrap Transport Side (`lib/broker-transport.js`)

The low-level transport used by the bootstrap (not plugins) also emits notifications as
lifecycle step events:

```js
// transport.step() sends:
{ type: 'notification', data: { event: 'step', clientId, step, status, detail, ts } }
```

These are internal diagnostics; plugins should use `broker-client-sdk` instead.

---

## Node.js SDK (`workshops/mcp-broker/sdk.js`)

The `BrokerClient` class (ESM, for Node.js consumers) handles tool calls and chat
requests. It currently has **no `.notify()` method and no `.on()` event subscription
API** — adding these is the next planned extension (see idea document).

---

## Subscription Flow Example (end-to-end)

```
1. poker-table-1 (browser)     → registers with broker
2. ai-agent (Node.js)          → registers with broker
3. ai-agent                    → sends { type: "subscribe", clientIds: ["poker-table-1"] }
4. poker-table-1 gameState changes
5. poker-table-1               → sends { type: "notification", event: { type: "gameState/change", data: {...} } }
6. broker                      → stores, broadcasts
7. ai-agent                    → receives { type: "notification", clientId: "poker-table-1", event: {...} }
8. dashboard (SSE)             → receives same notification in real time
```

---

## What Is Missing / Next Steps

| Gap | Plan |
|-----|------|
| No `notify()` on Node.js `BrokerClient` | Add it (idea: `plugin-notify-module`) |
| No `.on('notification', fn)` on `BrokerClient` | Add EventEmitter-style API |
| Plugins have no standard wrapper | Create `lib/notify.js` — SRP composable helper |
| `table-watcher.js` has no change tracking | Poll `gameStatus()`, diff, call `notify` on change |

---

## Files

| File | Role |
|------|------|
| `workshops/mcp-broker/server.js` | Broker — stores, broadcasts, routes |
| `plugins/broker-client-sdk.js` | Browser plugin SDK — `.notify()` method |
| `lib/broker-transport.js` | Bootstrap transport — internal step notifications |
| `workshops/mcp-broker/sdk.js` | Node.js SDK — subscribe side (`.on()` missing) |
