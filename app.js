'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { getConfig } = require('./config/env');
const { requestId, securityHeaders, noStore, corsPolicy, forceHttps } = require('./middleware/security');
const { csrfProtection, issueToken } = require('./lib/csrf');
const limits = require('./middleware/rateLimits');
const { notFound, errorHandler } = require('./middleware/errors');
const { handleWebhook } = require('./trigger/webhook-handler');

// Builds the Express app (no port is opened here, so tests can drive it directly).
function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(requestId);
  app.use(forceHttps);
  app.use(securityHeaders());

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // GitHub webhook: authenticated by HMAC signature, not cookies, so it sits outside
  // CORS/CSRF. It keeps the exact request bytes (req.rawBody) because the signature
  // is computed over them.
  app.post(
    config.webhookPath,
    limits.webhook(),
    express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }),
    handleWebhook
  );

  const api = express.Router();
  api.use(noStore);
  api.use(corsPolicy());
  api.use(limits.api());
  // Body size limits are per route group: only Quick Check and the admin console need big bodies.
  api.use('/quick-review', express.json({ limit: '3mb' }));
  api.use('/admin/db', express.json({ limit: '6mb' }));
  api.use(express.json({ limit: '100kb' }));

  api.get('/csrf', limits.csrfToken(), (req, res) => res.json({ token: issueToken(req, res) }));
  api.use(csrfProtection); // every POST/PUT/PATCH/DELETE below needs Origin + token

  api.use(require('./dashboard/api/auth'));
  api.use(require('./dashboard/api/github'));
  api.use(require('./dashboard/api/repo-view'));
  api.use(require('./dashboard/api/pr-drilldown'));
  api.use(require('./dashboard/api/analytics'));
  api.use(require('./dashboard/api/events'));
  api.use(require('./dashboard/api/quick-review'));
  api.use('/admin', require('./admin/routes'));
  api.use(notFound);
  app.use('/api', api);

  // Production: Express serves the built dashboard itself, so the browser talks to ONE
  // origin (no CORS, SameSite cookies, strict CSP). In development Vite serves it.
  const dist = path.join(__dirname, 'dashboard', 'client', 'dist');
  if (config.serveClient) {
    if (fs.existsSync(path.join(dist, 'index.html'))) {
      app.use(express.static(dist, {
        index: false,
        maxAge: '1y',
        setHeaders: (res, file) => { if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); },
      }));
      // Only extension-less paths (/admin, /reviews/3) get the app shell; /.env, /server.js or a
      // missing /assets/x.js are real 404s instead of an HTML page pretending to be that file.
      app.get(/^\/(?!api(?:\/|$))[^.]*$/, (req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
    } else {
      console.warn('SERVE_CLIENT is on but dashboard/client/dist is missing - run: npm run build');
    }
  } else {
    app.get('/', (req, res) => res.type('text/plain').send('Server running'));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
