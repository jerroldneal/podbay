# ClubWPT Login Plugin — Integration Guide

## Overview
The ClubWPT Login Plugin (`plugins/clubwpt/login.js`) automates the login process on ClubWPT
via the broker architecture:
1. Discovers the login iframe client from `window.__podbayFrameClients`
2. Sends login JS to the frame via broker REST API (`/api/call-tool`)
3. Login JS uses native value setter + full pointer/mouse events for Vue reactivity
4. Publishes `clubwpt-login-svc__login` broker tool for remote invocation

## Files
- **`plugins/clubwpt/login.js`** — Main plugin with broker-based login automation
- **`pods/clubwpt-login.pod`** — POD file for loading the plugin
- **`plugins/broker-client-sdk.js`** — Broker client SDK used to publish tools

## Usage

### Option 1: Auto-Run (Default)
The plugin runs automatically 1.5s after load:
```javascript
// In plugins/clubwpt/login.js:
var AUTORUN_ON_LOAD = true;
```

### Option 2: Manual Invocation
```javascript
var login = require('clubwpt/login');
login.login();
```

### Option 3: Broker Tool (Remote)
Any broker client can trigger login:
```javascript
// Via broker REST API
fetch('http://localhost:3098/api/call-tool', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tool: 'clubwpt-login-svc__login', arguments: {} })
});
```

## How It Works

### Architecture
```
Parent Renderer (bootstrap)
  → login.js finds frame client from window.__podbayFrameClients
  → Calls broker REST API: POST /api/call-tool
    → tool: "clubwpt-frame-login-1__execute"
    → arguments: { code: loginCode }
  → Broker routes to frame client via WebSocket
  → Frame executes login code in its context
```

### Login Code (runs inside frame)
1. Uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` for native value setting
2. Dispatches `input` + `change` events for Vue reactivity
3. Full pointer/mouse event sequence: `pointerdown → mousedown → pointerup → mouseup → click`

## Configuration

Edit `plugins/clubwpt/login.js`:
```javascript
var PHONE_NUMBER = '8184450634';
var PHONE_INPUT_SELECTOR = '#input-0';
var AUTORUN_ON_LOAD = true;
```

## Loading via POD File

```json
{
  "name": "clubwpt-login-pod",
  "description": "Pod for ClubWPT login automation",
  "plugins": [
    {
      "type": "clubwpt-login",
      "file": "plugins/clubwpt/login.js"
    }
  ]
}
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "No frame client found" | Frame not yet registered | Wait for frame to load, check `window.__podbayFrameClients` |
| Input not found in frame | Selector mismatch | Inspect frame DOM, update `PHONE_INPUT_SELECTOR` |
| Button not found | Selector mismatch | Inspect frame DOM, update `PHONE_BUTTON_SELECTOR` |
| Plugin doesn't run | AUTORUN_ON_LOAD = false | Call `require('clubwpt/login').login()` manually |
| Broker tool not published | broker-client-sdk not loaded | Ensure SDK is in bootstrap modules |
- [ ] Console output shows each step
- [ ] Button click event fires (success message appears)
- [ ] No errors in browser console

## Next Steps

1. **Deploy to ClubWPT**: Load the POD file in your PodBay environment
2. **Monitor**: Check browser console for `[ClubWPT Login]` logs
3. **Customize**: Adjust phone number or selectors as needed
4. **Integrate**: Require the plugin in other PodBay modules if needed

---

**Created**: 2026-03-21
**Plugin Version**: 1.0
**Framework**: PodBay CommonJS Plugin System
