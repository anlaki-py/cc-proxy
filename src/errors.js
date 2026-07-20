'use strict';

const { reqId } = require('./ids.js');

function anthropicError(status, message) {
  let type = 'api_error';
  if (status === 400) type = 'invalid_request_error';
  else if (status === 401) type = 'authentication_error';
  else if (status === 403) type = 'permission_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 429) type = 'rate_limit_error';
  else if (status === 503 || status === 529) type = 'overloaded_error';
  return { type: 'error', error: { type, message } };
}

function writeJsonError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(anthropicError(status, message)));
}

module.exports = { anthropicError, writeJsonError, reqId };
