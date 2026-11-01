'use strict';
const { EventEmitter } = require('events');

// Single shared emitter used to notify SSE clients (the dashboard) whenever something
// changes in the database. Events may carry `ownerUserId`; the SSE route only forwards
// an event to the user it belongs to (events without an owner are harmless "refresh"
// pings for everyone). Connection limits are enforced in the SSE route, not here.
const reviewEvents = new EventEmitter();
reviewEvents.setMaxListeners(0);

module.exports = { reviewEvents };
