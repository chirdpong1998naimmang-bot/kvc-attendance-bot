# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

KVC Attendance Bot — a LINE Bot + LIFF backend (Node.js/Express + PostgreSQL) for student attendance tracking at Kanchanaburi Vocational College. The LIFF frontend is deployed separately (not in this repo).

### Services

| Service | How to run | Notes |
|---|---|---|
| PostgreSQL | `sudo pg_ctlcluster 16 main start` | Must be running before the app starts. The app calls `process.exit(1)` if DB is unavailable. |
| Node.js app | `npm start` (or `npm run dev` for nodemon) | Runs on port 3000. Auto-initializes DB schema on first boot via `autoInit.js`. |

### Environment

- The app reads `.env` via `dotenv`. A `.env` file must exist at the repo root with at least `DATABASE_URL`.
- `NODE_ENV` must **not** be `production` for local dev (it enables SSL on the DB connection).
- LINE API credentials (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`) can be placeholders for local dev; LINE-dependent features will simply not work but the server starts fine.

### Key dev commands

- **Install deps:** `npm install`
- **Start (production):** `npm start` → `node server.js`
- **Start (dev with hot reload):** `npm run dev` → `nodemon server.js`
- **Init DB schema manually:** `node db-init.js` (not needed — `server.js` auto-inits on first run)

### Testing

There is no automated test suite in this repo. Validate changes by starting the server and exercising REST API endpoints (e.g., `GET /health`, `GET /api/students`, `POST /api/attendance/manual`).

### Gotchas

- The server's `start()` function runs migrations inline before listening. If a migration fails, the server may exit. Check PostgreSQL logs (`/var/log/postgresql/`) if the server won't start.
- The cron scheduler (`node-cron`) starts automatically and checks every minute Mon-Fri 07:00-17:00 Bangkok time. It will attempt to send QR codes via LINE if schedules with `auto_send=true` and linked LINE groups exist.
- `express.json()` is **not** applied at the app level — it's applied per-router. The LINE webhook route needs raw body for signature verification.
