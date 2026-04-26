// PodBay Notify — SRP composable notification helper for plugins.
//
// Wraps broker-transport.send so any plugin gets a clean one-liner API:
//
//   var notify = require('notify');
//   notify('gameState/change', { street: 'flop', pot: '1200' });
//
// The `eventType` string appears as the event label in the broker dashboard
// and in the `event.type` field received by subscribers.
//
// Additional fields from `data` are merged into the event object.
// Silently no-ops when the broker WebSocket is not yet connected.
'use strict';

var transport = require('broker-transport');

module.exports = function notify(eventType, data) {
  transport.send({
    type: 'notification',
    event: Object.assign({ type: eventType }, data || {})
  });
};
