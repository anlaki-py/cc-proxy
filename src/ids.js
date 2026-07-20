'use strict';

// ---------- id + sse helpers ----------

function msgId() {
  return 'msg_' + Math.random().toString(36).slice(2, 26);
}

function reqId() {
  return 'req_' + Math.random().toString(36).slice(2, 18);
}

function sse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

module.exports = { msgId, reqId, sse };
