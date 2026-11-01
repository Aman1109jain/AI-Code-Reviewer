# AI Code Reviewer

Automated pull-request review for GitHub. When a PR is opened or updated, the service fetches the diff, runs static analysis (Semgrep), asks Google Gemini for additional code-quality feedback, scores the result, saves it, and posts the findings back to the PR as a comment. A React dashboard shows every review in real time, and a secured admin console provides account and database management.

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Connecting GitHub](#connecting-github)
- [Using the app](#using-the-app)
- [Admin console and CLI](#admin-console-and-cli)
- [Scripts](#scripts)
- [API overview](#api-overview)
- [Database](#database)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Features

**Reviews**
- Automatic review of every pull request (`opened` and `synchronize` events) with a comment posted back to the PR.
- **Two-layer analysis:** Semgrep finds known security and correctness issues; Gemini adds readability, structure, performance and error-handling feedback, without repeating what Semgrep already reported.
- Findings are classified by **severity** (`blocking`, `warning`, `nitpick`) and **category** (`security`, `performance`, `maintainability`, `readability`), and every review gets a 0-100 quality score.
- **Quick Check:** paste code, or upload files and whole folders, and get the same review without opening a PR. Optionally push the reviewed code to a new branch and open a PR from the dashboard.

**Dashboard**
- Review list with search and per-repository filtering, a detail view with the diff and findings, severity charts, and live updates (server-sent events).
- Each visitor connects their own GitHub account and sees only their own reviews.
- Light/dark theme and a responsive layout for phones and tablets.

**Admin console** (`/admin`)
- Separate admin accounts created from the terminal, with mandatory two-step verification (authenticator app) and single-use recovery codes.
- Role-based access (`admin`, `superadmin`), admin-account management, and an audit trail.
- A database console to view and edit Reviews, Findings and GitHub logins using atomic, all-or-nothing transactions.

**Security and operations**
- HMAC-verified webhooks, CSRF protection, strict security headers, rate limiting, input validation, encrypted secrets at rest, and a tracked migration system. See [Security](#security).

## How it works

```mermaid
flowchart LR
    PR[Pull request opened or updated] -->|signed webhook| API[Express server]
    API --> DIFF[Fetch diff from the GitHub API]
    DIFF --> SG[Semgrep static analysis]
    SG --> LLM[Gemini review]
    LLM --> MERGE[Merge, validate and score]
    MERGE --> DB[(PostgreSQL)]
    MERGE --> COMMENT[Comment on the PR]
    DB --> UI[React dashboard]
    UI -. live updates .-> API
```

1. GitHub sends a signed `pull_request` webhook. The server verifies the HMAC signature before doing anything else.
2. The server looks up a connected user whose GitHub token can access the repository, and fetches the PR diff with it.
3. Semgrep analyses the changed code; its findings are passed to Gemini as context.
4. Findings from both sources are merged, validated against a strict schema, scored (100 minus penalties of 15 per blocking, 7 per warning, 2 per nitpick), and saved in one database transaction.
5. The review is posted as a PR comment and pushed to the owner's open dashboards.

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js 20+, Express 5 |
| Database | PostgreSQL (developed against Neon), `pg` |
| AI review | Google Gemini via `@google/genai` |
| Static analysis | Semgrep (Python CLI) |
| Dashboard | React 18, Vite 6, Recharts, lucide-react |
| Validation and security | zod, helmet, express-rate-limit, Node `crypto` (scrypt, AES-256-GCM, TOTP) |
| Tests | Node's built-in test runner |

## Project structure

```
.
├── app.js                     Builds the Express app (no port opened; used by tests)
├── server.js                  Starts the server, background jobs, dev webhook forwarding
├── config/env.js              Validated configuration (fails fast on bad settings)
├── admin/                     Admin console backend: routes, store, table registry, DB console
├── dashboard/
│   ├── api/                   Visitor-facing API routes
│   └── client/                React app (Vite)
│       └── src/components/    UI, including components/admin/
├── database/
│   ├── connection.js          Shared connection pool
│   ├── tx.js                  Transaction helper
│   └── migrations/            Numbered SQL migrations
├── delivery/                  Posting comments to GitHub
├── fetch-prepare/             Fetching PR diffs
├── findings/                  Review persistence and validation of AI/Semgrep output
├── lib/                       Crypto, passwords, TOTP, cookies, CSRF, sessions, events
├── middleware/                Security headers, rate limits, auth, validation, errors
├── review-engine/             Semgrep and Gemini analysis, merging and scoring
├── scripts/                   migrate.js and admin-cli.js
├── tests/                     Unit and integration tests
├── trigger/                   Webhook handler
└── utils/                     Quick Check file handling, retry helper
```

## Getting started

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 20 or newer | `node -v` |
| PostgreSQL | A free [Neon](https://neon.tech) project works well; a local database also works |
| Python and Semgrep | `pip install semgrep`. Without it, reviews still run but skip static analysis |
| Gemini API key | Create one in [Google AI Studio](https://aistudio.google.com/) |
| GitHub account | Used to create a token and a webhook |

### 1. Install

```bash
npm run install:all
```

This installs the server dependencies and the dashboard's (`dashboard/client`).

### 2. Configure

Copy the example file and fill it in:

```bash
# macOS / Linux
cp .env.example .env
# Windows (Command Prompt / PowerShell)
copy .env.example .env
```

Generate the webhook secret (and, for production, the session secret) with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_SSL` | No | `verify` (default), `no-verify`, or `off` (local database only) |
| `GEMINI_API_KEY` | Yes | Key for the AI review step |
| `GEMINI_MODEL` | No | Model name (default set in `config/env.js`) |
| `GITHUB_WEBHOOK_SECRET` | Yes, for PR reviews | Shared secret for verifying webhooks (16+ characters). Webhooks are rejected without it |
| `WEBHOOK_PATH` | No | Webhook route (default `/webhook/github`) |
| `SMEE_URL` | No | Development only: smee.io channel forwarded to your machine. Ignored in production |
| `SESSION_SECRET` | Production | 32+ random characters; encrypts stored tokens and authenticator secrets. In development, one is generated in `.data/` if unset |
| `SESSION_DAYS` | No | Visitor session lifetime (default 30) |
| `ADMIN_IDLE_MINUTES` / `ADMIN_MAX_HOURS` | No | Admin session idle timeout (default 30) and absolute lifetime (default 8) |
| `PORT` | No | API port (default 3000) |
| `DASHBOARD_URL` | No | Dashboard address (default `http://localhost:5173`) |
| `ALLOWED_ORIGINS` | No | Extra browser origins allowed to call the API |
| `TRUST_PROXY` | Production | Number of reverse proxies in front of the app, for example `1` |
| `SERVE_CLIENT` | No | Serve the built dashboard from Express (default on in production) |
| `FORCE_HTTPS` | No | Redirect HTTP to HTTPS when the proxy sets `X-Forwarded-Proto` |

> Never commit `.env`. It is listed in `.gitignore`.

### 3. Create the database tables

```bash
npm run migrate
```

Migrations are tracked in a `schema_migrations` table, each runs in a transaction, and re-running is safe. A database created by an earlier version is detected and upgraded automatically.

### 4. Create the first admin

```bash
npm run create-admin
```

You will be asked for a username, an email address and a password (typed hidden). The first sign-in then walks you through setting up an authenticator app and saving your recovery codes.

### 5. Run

```bash
npm run dev
```

| Service | URL |
|---|---|
| Dashboard (Vite) | http://localhost:5173 |
| API (Express) | http://localhost:3000 |

The dashboard proxies `/api` to the server, so the browser only talks to one address.

## Connecting GitHub

### Each user: connect an account

Open the dashboard and click **Connect GitHub**. Paste a personal access token (GitHub → Settings → Developer settings → Personal access tokens). A classic token needs the `repo` scope; a fine-grained token limited to your repositories also works. The token is verified with GitHub, then stored encrypted. Reviews are linked to the connected account used to access the repository, and are visible only to that account.

### Each repository: add the webhook

In the repository: **Settings → Webhooks → Add webhook**.

| Field | Value |
|---|---|
| Payload URL | Development: your `SMEE_URL`. Production: `https://your-domain/webhook/github` |
| Content type | `application/json` |
| Secret | The same value as `GITHUB_WEBHOOK_SECRET` |
| Events | "Let me select individual events" → **Pull requests** |

Open or push to a pull request and the review usually appears in the dashboard within a minute.

Development with smee.io: create a channel at [smee.io](https://smee.io), put its URL in `SMEE_URL`, and the dev server forwards deliveries to your machine automatically. In production, point GitHub directly at your server and leave `SMEE_URL` unset.

## Using the app

**Dashboard.** Shows your reviews with repository, PR number, score and finding counts. Select a repository in the sidebar to filter. Open a review to see the diff and each finding with its severity, category, explanation and suggested fix.

**Quick Check.** Paste code or upload files and folders. Limits: 50 files, 150 KB per file, 300 KB in total; binary files and credential-looking files (`.env`, keys) are skipped. After a review you can create a branch and open a PR containing the code.

**Sharing your local dashboard.** With VS Code, forward port `5173` from the Ports panel and send the link. Only that one port is needed.

## Admin console and CLI

Open **Admin** (top right) and sign in with password, then an authenticator code.

| Role | Permissions |
|---|---|
| `admin` | Use the database console, add other admins, edit their own profile and password |
| `superadmin` | All of the above, plus edit, disable, delete and unlock other admins, change roles, reset passwords and MFA |

The database console stages edits in the browser and applies them as **one transaction**: all changes are saved together, or none are. Rows carry version numbers, so concurrent edits are detected instead of silently overwritten. Secret columns (encrypted tokens, session hashes) are never shown.

Terminal commands for account recovery and maintenance:

| Command | Purpose |
|---|---|
| `npm run create-admin` | Create a superadmin |
| `npm run admin -- list` | List admins, roles, MFA status |
| `npm run admin -- reset-password <user>` | Set a new password and sign the user out everywhere |
| `npm run admin -- reset-mfa <user>` | Remove the authenticator (re-enrolled at next sign-in) |
| `npm run admin -- unlock <user>` | Clear a lockout after failed sign-ins |
| `npm run admin -- claim-reviews <github-user>` | Give ownerless older reviews to a connected GitHub account |

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Server and dashboard together, with live reload |
| `npm run server` / `npm run client` | Run either one alone |
| `npm run build` | Production build of the dashboard |
| `npm start` | Start the server (set `NODE_ENV=production` for production) |
| `npm run migrate` | Apply database migrations |
| `npm test` | Unit and integration tests |
| `npm run audit:deps` | Fail on high or critical dependency vulnerabilities |
| `npm run install:all` | Install server and dashboard dependencies |

## API overview

All routes are under `/api` and return JSON. State-changing requests require a CSRF token (`GET /api/csrf`, sent as `X-CSRF-Token`).

| Area | Routes |
|---|---|
| Session | `GET /github/status`, `POST /auth/github/token`, `POST /auth/logout` |
| Reviews (own) | `GET /reviews`, `GET /reviews/:id/findings`, `GET /analytics/severity`, `GET /events` (live updates), `GET /github/repos` |
| Quick Check | `POST /quick-review`, `POST /quick-review/:id/create-pr` |
| Admin sign-in | `POST /admin/auth/login`, `.../mfa/setup`, `.../mfa/enable`, `.../mfa/verify`, `.../password/initial`, `.../logout`, `GET /admin/auth/session` |
| Admin account | `GET /admin/me`, `PATCH /admin/me`, `POST /admin/me/password`, `POST /admin/me/recovery-codes` |
| Admin users | `GET /admin/users`, `POST /admin/users`, `PATCH /admin/users/:id`, `DELETE /admin/users/:id`, `POST /admin/users/:id/{reset-password,reset-mfa,unlock}` |
| Database console | `GET /admin/db/tables`, `GET /admin/db/tables/:table/rows`, `GET /admin/db/tables/:table/rows/:id`, `POST /admin/db/transactions` |
| Webhook | `POST /webhook/github` (HMAC-authenticated, outside `/api`) |

## Database

| Table | Purpose |
|---|---|
| `reviews` | One row per PR review or Quick Check; owned by a GitHub user |
| `findings` | Individual issues belonging to a review |
| `github_users` | Connected GitHub accounts (token stored encrypted) |
| `user_sessions` | Visitor sessions (only a hash of the cookie is stored) |
| `admin_users`, `admin_sessions`, `admin_recovery_codes` | Admin accounts, sessions and MFA recovery codes |
| `admin_audit_log` | Append-only record of admin activity |
| `schema_migrations` | Applied migration versions |

Migrations live in `database/migrations/` as numbered `.sql` files. Never edit one that has already been applied; add a new file instead.

## Security

Highlights: signed webhooks, per-user data isolation, scrypt password hashing, mandatory TOTP for admins, CSRF protection, strict CSP and security headers, rate limiting, parameterised SQL with allow-listed identifiers, validated AI output, encrypted secrets, an append-only audit log, and automated dependency and secret scanning in CI.

See [SECURITY.md](SECURITY.md) for the full control-by-control description, known limitations and the production checklist, and [AUDIT.md](AUDIT.md) for the clean-up audit.

To report a vulnerability, contact the maintainers privately instead of opening a public issue.

## Testing

```bash
npm test
```

- **Unit tests** run anywhere and need no database.
- **Integration tests** run the real app against PostgreSQL and are skipped unless `TEST_DATABASE_URL` is set:

```bash
# Use a throwaway database: the tests delete data from its tables.
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/acr_test npm test
```

Tests refuse hosted database URLs and never read your `.env`.

GitHub Actions (`.github/workflows`) runs the tests, `npm audit`, secret scanning and CodeQL on every push and weekly; Dependabot opens update pull requests.

## Deployment

1. Set `NODE_ENV=production`, `DATABASE_URL`, `SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GEMINI_API_KEY` and `TRUST_PROXY` in the host's environment (not in a committed file).
2. Build and migrate: `npm run install:all && npm run build && npm run migrate`.
3. Create the first admin on the server: `npm run create-admin`.
4. Start with `npm start`. Express serves the dashboard and API from one address.
5. Put the app behind HTTPS (a reverse proxy or your platform's TLS), install Semgrep on the host, and point each repository's webhook at `https://your-domain/webhook/github`.
6. Keep `SESSION_SECRET` backed up. Changing it makes stored GitHub tokens unreadable (users reconnect once) and requires resetting admins' MFA.

Rate limits are held in memory, which is correct for a single server process; use a shared store if you run several instances.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'zod'` (or another package) | Run `npm run install:all` |
| `Port 3000 is already in use` | Close the other program or change `PORT`. On Windows: `netstat -ano \| findstr :3000` |
| Webhook deliveries return 401 or 503 | `GITHUB_WEBHOOK_SECRET` is missing, or differs from the secret in GitHub's webhook settings; content type must be `application/json` |
| "Semgrep is not installed" in the log | `pip install semgrep` and restart; reviews still work without it |
| Reviews say the AI service didn't respond | Gemini was busy or the key is wrong; try again, and check `GEMINI_API_KEY` |
| Dashboard shows no reviews after upgrading | Run `npm run migrate`; for older ownerless reviews run `npm run admin -- claim-reviews <github-user>` |
| Locked out of the admin console | `npm run admin -- unlock <user>`; lost authenticator: `npm run admin -- reset-mfa <user>`; forgot password: `npm run admin -- reset-password <user>` |
| Friends can't open your shared dev link | Make the forwarded port (5173) public and keep `npm run dev` running |

## License


Copyright (c) 2026 Aman Jain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
