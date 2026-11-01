'use strict';
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const { getConfig } = require('../config/env');

function requestId(req, res, next) {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Security headers. The CSP is strict: scripts only from this origin (no inline,
// no eval), nothing can frame the app, forms can only post back here.
// The two allowances are for the Google Fonts links in index.html and GitHub avatars.
function securityHeaders() {
  const { isProd } = getConfig();
  const helmetMw = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"], // React `style={{...}}` attributes (charts)
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: isProd ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false, // would block the Google Fonts stylesheet
    xFrameOptions: { action: 'deny' },
  });
  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    helmetMw(req, res, next);
  };
}

// API responses can contain source code and personal data: never let a browser or
// proxy cache them.
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

// CORS: an explicit allow-list, never "*" and never reflecting arbitrary origins.
// In the normal setup the browser talks to the app on its own origin (Vite proxy in
// development, Express static files in production) and CORS isn't involved at all.
function corsPolicy() {
  const allowed = new Set(getConfig().allowedOrigins);
  return cors({
    origin(origin, cb) {
      if (!origin || allowed.has(origin)) return cb(null, Boolean(origin));
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    maxAge: 600,
  });
}

function forceHttps(req, res, next) {
  if (!getConfig().forceHttps || req.secure || req.path === '/healthz') return next();
  return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
}

module.exports = { requestId, securityHeaders, noStore, corsPolicy, forceHttps };
