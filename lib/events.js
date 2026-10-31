const { EventEmitter } = require('events');

// Single shared emitter used to notify SSE clients (the dashboard) whenever
// something changes in the database (new review saved, review deleted, etc).
const reviewEvents = new EventEmitter();
reviewEvents.setMaxListeners(50);

module.exports = { reviewEvents };
