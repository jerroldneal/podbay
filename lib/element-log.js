// PodBay Element Log — in-memory activity ring buffer for element client lifecycle events
// CommonJS module loaded via bootstrap's require polyfill.
//
// Records the full lifecycle of every element client: discovery, inference, registration,
// tool calls, tool results, and removal. Exposed as a queryable store — tool-handler.js
// reads from it to serve element_log and element_monitor tool requests.
//
// Ring buffer: capped at MAX_ENTRIES (500). Oldest entries are dropped when full.
// Zero behavioral impact — removing this module changes nothing about element functionality.
//
// Usage:
//   var elementLog = require('element-log');
//   elementLog.record('my-app-btn-login-1', 'button', 'tool_called', { tool: 'click' });
//   var events = elementLog.query({ type: 'button', event: 'registered', limit: 20 });
//   var snap = elementLog.snapshot();
'use strict';

var TAG = '[PodBay ElementLog]';
var MAX_ENTRIES = 500;

// ── Event constants ──────────────────────────────────────────────────────
var EVENTS = {
  DISCOVERED: 'discovered',
  INFERENCE_START: 'inference_start',
  INFERENCE_COMPLETE: 'inference_complete',
  REGISTERED: 'registered',
  TOOL_CALLED: 'tool_called',
  TOOL_RESULT: 'tool_result',
  REMOVED: 'removed'
};

// ── State ────────────────────────────────────────────────────────────────
var __log = [];    // ring buffer — array of event objects, oldest first
var __seq = 0;     // monotonic sequence number per entry

// Current registered client snapshot: clientId → { type, url, parentClientId, inferredDescription, toolCallCount }
var __clients = {};

// ── Core API ─────────────────────────────────────────────────────────────

/**
 * Record an event for an element client.
 * @param {string} clientId
 * @param {string} elementType  'button' | 'input' | 'container'
 * @param {string} event        One of EVENTS.*
 * @param {object} [data]       Additional context (tool name, error, description, etc.)
 */
function record(clientId, elementType, event, data) {
  var entry = {
    seq: ++__seq,
    ts: Date.now(),
    clientId: clientId,
    type: elementType,
    url: (typeof location !== 'undefined' && location.href) || '',
    event: event,
    data: data || null
  };

  __log.push(entry);
  if (__log.length > MAX_ENTRIES) __log.shift();

  // Maintain snapshot
  if (event === EVENTS.REGISTERED) {
    __clients[clientId] = {
      type: elementType,
      url: entry.url,
      parentClientId: (data && data.parentClientId) || null,
      inferredDescription: (data && data.inferredDescription) || null,
      toolCallCount: 0
    };
  } else if (event === EVENTS.TOOL_CALLED) {
    if (__clients[clientId]) {
      __clients[clientId].toolCallCount = (__clients[clientId].toolCallCount || 0) + 1;
    }
  } else if (event === EVENTS.REMOVAL) {
    delete __clients[clientId];
  }
}

/**
 * Query the log with optional filters.
 * All filters are optional and additive (AND logic).
 * String filters use substring matching.
 *
 * @param {object} [opts]
 * @param {string} [opts.clientId]   Substring match on clientId
 * @param {string} [opts.type]       Exact match: 'button' | 'input' | 'container'
 * @param {string} [opts.event]      Exact match on event name (e.g. 'registered')
 * @param {string} [opts.url]        Substring match on url
 * @param {number} [opts.limit]      Max entries to return (default 50, max 200)
 * @returns {Array}
 */
function query(opts) {
  opts = opts || {};
  var limit = Math.min(opts.limit || 50, 200);
  var results = [];

  // Walk backwards (most recent first) and collect up to limit matches
  for (var i = __log.length - 1; i >= 0 && results.length < limit; i--) {
    var e = __log[i];
    if (opts.clientId && e.clientId.indexOf(opts.clientId) === -1) continue;
    if (opts.type && e.type !== opts.type) continue;
    if (opts.event && e.event !== opts.event) continue;
    if (opts.url && e.url.indexOf(opts.url) === -1) continue;
    results.push(e);
  }

  return results.reverse();  // return chronological order
}

/**
 * Snapshot of currently registered element clients.
 * @returns {{ total: number, byType: object, clients: Array }}
 */
function snapshot() {
  var ids = Object.keys(__clients);
  var byType = { button: 0, input: 0, container: 0 };
  var list = [];

  for (var i = 0; i < ids.length; i++) {
    var c = __clients[ids[i]];
    if (byType[c.type] !== undefined) byType[c.type]++;
    list.push({
      clientId: ids[i],
      type: c.type,
      url: c.url,
      parentClientId: c.parentClientId,
      inferredDescription: c.inferredDescription,
      toolCallCount: c.toolCallCount
    });
  }

  return {
    total: ids.length,
    byType: byType,
    clients: list
  };
}

/**
 * Total number of entries currently in the log.
 */
function size() {
  return __log.length;
}

/**
 * Clear the log and snapshot. Useful for testing.
 */
function clear() {
  __log = [];
  __clients = {};
  __seq = 0;
}

module.exports = {
  events: EVENTS,
  record: record,
  query: query,
  snapshot: snapshot,
  size: size,
  clear: clear
};
