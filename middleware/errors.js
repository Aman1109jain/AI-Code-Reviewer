'use strict';
// Central error handling: details go to the server log (tagged with a request id the
// user can quote), the client only ever gets a generic message - no stack traces,
// SQL, table names or library errors.

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

const notFound = (req, res) => res.status(404).json({ error: 'Not found.' });

// Maps well-known Postgres error classes to safe client messages.
function pgToHttp(err) {
  switch (err.code) {
    case '23505': return new HttpError(409, 'That value is already in use.');
    case '23503': return new HttpError(409, 'This record is linked to other records (or points to one that does not exist).');
    case '23502': return new HttpError(400, 'A required value is missing.');
    case '23514': return new HttpError(400, 'A value is not allowed by the database rules.');
    case '22P02':
    case '22003':
    case '22001':
    case '22007':
    case '22008': return new HttpError(400, 'A value has the wrong format or is out of range.');
    case '40001':
    case '40P01': return new HttpError(409, 'The data changed at the same moment. Please retry.');
    case '57014': return new HttpError(503, 'The database took too long to answer. Try a smaller request.');
    default: return null;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;
  let e = err;
  if (err && err.type === 'entity.too.large') {
    const quick = String(req.originalUrl || '').startsWith('/api/quick-review');
    e = new HttpError(413, quick
      ? 'That upload is too large. Quick Check accepts up to 300 KB of code in total - try a smaller folder or fewer files.'
      : 'That request is too large.');
  }
  else if (err && err.type === 'entity.parse.failed') e = new HttpError(400, 'The request body is not valid JSON.');
  else if (err && err.code && !err.expose) e = pgToHttp(err) || err;

  if (e instanceof HttpError || (e && e.expose && e.status)) {
    return res.status(e.status).json({ error: e.message, ...(e.code && typeof e.code === 'string' ? { code: e.code } : {}), ...(e.details ? { details: e.details } : {}) });
  }
  console.error(`[error] ${req.method} ${req.originalUrl.split('?')[0]} (req ${req.id || '-'}):`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Something went wrong on our side. Please try again.', requestId: req.id });
}

// Express 5 forwards rejected promises to the error handler itself; this helper keeps
// the intent explicit and works with older versions too.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, notFound, errorHandler, wrap, pgToHttp };
