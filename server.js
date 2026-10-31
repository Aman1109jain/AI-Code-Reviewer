require('dotenv').config();

const express = require('express');
const cors = require('cors');
const app = express();

// The dashboard (Vite, port 5173) and this API (port 3000) are different
// origins in dev, hence CORS.
app.use(
  cors({
    origin: process.env.DASHBOARD_URL || 'http://localhost:5173',
    // The browser must be allowed to send its login cookie with API calls.
    credentials: true,
  })
);
// Quick Check uploads whole files/folders as JSON, so the default 100 KB limit
// is far too small. The review itself is capped at 300 KB of code (see
// utils/quick-files.js); 3 MB leaves room for JSON escaping overhead.
app.use(express.json({ limit: '3mb' }));

const webhookRouter = require('./trigger/webhook-handler');
app.use('/webhook', webhookRouter);

const repoViewRouter = require('./dashboard/api/repo-view');
const prDrilldownRouter = require('./dashboard/api/pr-drilldown');
const analyticsRouter = require('./dashboard/api/analytics');
const githubRouter = require('./dashboard/api/github');
const tablesRouter = require('./dashboard/api/tables');
const eventsRouter = require('./dashboard/api/events');
const quickReviewRouter = require('./dashboard/api/quick-review');
const authRouter = require('./dashboard/api/auth');
app.use('/api', repoViewRouter);
app.use('/api', prDrilldownRouter);
app.use('/api', analyticsRouter);
app.use('/api', authRouter);
app.use('/api', githubRouter);
app.use('/api', tablesRouter);
app.use('/api', eventsRouter);
app.use('/api', quickReviewRouter);

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Server running');
});

// Friendly error for oversized request bodies (otherwise the browser just sees
// a generic failure).
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That upload is too large. Quick Check accepts up to 300 KB of code in total — try a smaller folder or fewer files.',
    });
  }
  next(err);
});

const server = app.listen(PORT, (err) => {
  // Express 5 hands startup failures (e.g. the port is taken) to this callback
  // instead of throwing. Without this check the server would print "running"
  // even though it never started, and the dashboard would quietly end up talking
  // to whatever other program owns the port ("Network Error" in the browser).
  if (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${PORT} is already in use by another program, so the API could not start.\n` +
          `Close that program, or change PORT in .env (and set VITE_API_BASE_URL in dashboard/client/.env to match).\n` +
          `Windows: run  netstat -ano | findstr :${PORT}  to find the process.\n`
      );
    } else {
      console.error('Server failed to start:', err.message);
    }
    process.exit(1);
  }
  console.log(`Server is running on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Embedded smee.io client — forwards GitHub webhook deliveries from the smee
// channel straight into this same process, so you don't need a second
// terminal running `smee --url ... --target ...` any more.
// Set SMEE_URL in .env to enable it; leave it blank to skip (e.g. if you're
// exposing the webhook another way, like a real public URL).
// ---------------------------------------------------------------------------
let smeeClient = null;
if (process.env.SMEE_URL) {
  const SmeeClient = require('smee-client').default;
  const webhookPath = process.env.WEBHOOK_PATH || '/webhook/github';

  smeeClient = new SmeeClient({
    source: process.env.SMEE_URL,
    target: `http://localhost:${PORT}${webhookPath}`,
    logger: {
      info: (msg) => console.log(`[smee] ${msg}`),
      error: (msg) => console.error(`[smee] ${msg}`),
    },
  });

  var smeeEvents = smeeClient.start();
  console.log(`[smee] forwarding ${process.env.SMEE_URL} -> http://localhost:${PORT}${webhookPath}`);
} else {
  console.log('[smee] SMEE_URL not set in .env — skipping embedded webhook forwarding.');
}

function shutdown() {
  console.log('\nShutting down...');
  if (smeeEvents && typeof smeeEvents.close === 'function') {
    smeeEvents.close();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
