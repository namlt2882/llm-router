# WaveBot patches

This branch (`wavebot/main`) is `decolua/9router` plus the patches WaveBot needs
to run it as the System AI Pool router. The branch is a **rebase target**, not a
divergent product: keep every patch small, self-contained and commented, so
`git rebase upstream/master` stays cheap.

- Upstream: <https://github.com/decolua/9router> (`upstream/master`)
- Written against: `1855aa44` — upstream master, package version 0.5.116
  (package.json), commit subject "# v0.5.119 (2026-11-11)"
- Image: `ghcr.io/namlt2882/llm-router:wavebot-main` (published by
  `.github/workflows/docker.yml`)

## Update procedure

```bash
git fetch upstream master
git rebase upstream/master          # resolve patch conflicts here, not in WaveBot
cd tests && npm install && npx vitest run --reporter=json --outputFile=__baseline__/current.json
node __baseline__/verify-no-regression.mjs __baseline__/current.json
npm run build && docker build -t 9router-fork:check .
```

The gate is `tests/__baseline__/verify-no-regression.mjs` against
`tests/__baseline__/known-fails.txt` — never a raw "all tests pass" expectation;
upstream master is not green on a plain checkout.

## Patches

| # | Patch | Files | Why |
|---|---|---|---|
| 1 | Baseline verifier works outside `/app/` | `tests/__baseline__/verify-no-regression.mjs` | Its path split assumed a container path; every known failure read as a regression in any other checkout. |
| 2 | WaveBot ticket login | `src/lib/auth/wavebotTicket.js`, `src/app/dashboard/auth/ticket/route.js`, `src/dashboardGuard.js` | The router dashboard is opened through a one-time ticket minted by WaveBot; there is no second password to manage. |
| 3 | Password login off in WaveBot mode | `src/app/api/auth/login/route.js`, `src/app/login/page.js`, `src/app/api/auth/mode/route.js` | With `WAVEBOT_AUTH_URL` set, the only door is the ticket. |
| 4 | Session → account pinning | `src/sse/services/sessionPin.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js` | Conversation affinity keeps a session's prompt cache on one upstream account. Availability still wins over affinity. |
| 5 | Per-account in-flight cap | `src/sse/services/accountInflight.js`, `src/sse/services/auth.js`, `open-sse/handlers/chatCore.js`, `open-sse/utils/stream.js` | A leaked slot is bounded by TTL; a full account is skipped, and all-full answers a retryable 503 instead of "no credentials". |
| 6 | `spread` strategy | `src/sse/services/auth.js`, `src/lib/db/repos/settingsRepo.js`, dashboard profile page | Scores accounts by in-flight count, then backoff, then recency before priority. |
| 7 | Postgres-backed persistence | `src/lib/db/postgresSql.js`, `src/lib/db/postgresJournal.js`, `src/lib/db/adapters/postgresAdapter.js`, `src/lib/db/driver.js`, `src/lib/db/migrate.js` | WaveBot operates one Postgres; the router's state lives there, behind the existing synchronous repo API, with an fsync'd journal so an acked write survives a kill. |
| 8 | Container image on `node:24-alpine` | `Dockerfile`, `.github/workflows/docker.yml` | `node:sqlite` needs Node ≥22.5; the runner must carry `pg`, so it copies the built `node_modules` instead of an upstream file list. |
| 9 | Ticket redirects on the client's origin | `src/lib/auth/ticketOrigin.js`, `src/app/dashboard/auth/ticket/route.js` | `request.url` carries the bind address (`0.0.0.0`), so a successful login redirected to `http://0.0.0.0:20128/dashboard`. Builds the target from `Host` (+`x-forwarded-proto`). |
| 10 | Mirror column reconciliation is case-folded | `src/lib/db/adapters/postgresAdapter.js` | Postgres lowercases unquoted columns, so the second boot re-added every camelCase column and the whole DB layer failed with `42701`. |

## Runtime environment (fork-specific)

| Variable | Meaning |
|---|---|
| `LLM_ROUTER_DATABASE_URL` | Postgres DSN for the mirror. **Set ⇒ Postgres, with no SQLite fallback**: an unreachable database fails the request (and the boot) rather than silently serving from a local file. Unset ⇒ upstream's SQLite chain. |
| `LLM_ROUTER_JOURNAL_DIR` | Directory for the write journal (default `DATA_DIR/db`). Must be on a volume, or a restart loses unflushed groups. |
| `WAVEBOT_AUTH_URL` | WaveBot base URL the ticket is verified against. Set ⇒ password login is off and the dashboard is reached only through a ticket. |
| `ACCOUNT_MAX_INFLIGHT` | Per-account in-flight cap (default 4). |
| `JWT_SECRET` | Dashboard session cookie signing key. Required. |

## Verification performed on this fork (2026-11-13)

- Unit: `postgres-sql` (11), `postgres-journal` (5), `postgres-adapter` (6),
  `postgres-driver-selection` (2), `auth-spread-strategy` (2),
  `account-inflight` (5), `auth-inflight-cap` (3), `auth-session-pinning` (4).
- Live: `tests/live/postgres-adapter.live.test.js` (2) against the dev Postgres —
  a write lands in the real table (read back through a second, plain `pg`
  client), and a **second adapter instance boots its state from Postgres**, which
  is the property the mirror exists for.
- Live, dev stack (2026-11-13), through the real WaveBot dashboard and a real
  upstream: forged ticket → `401 malformed`; one ticket twice → `200` then `401
  ticket_used`; exchange → `307 /dashboard` + `auth_token` + dashboard `200`;
  non-streaming chat on `/v1` → `200` with usage; the same `x-session-id` twice
  logs `session pin <conn> (…) for conv:…`; `/v1` without a key → `401`; an
  injected journal group reached Postgres after `docker kill` + start and the
  journal truncated to 0 bytes.
- Image: built locally from this Dockerfile; `/api/health` returns `{"ok":true}`,
  `/login` is 200, the log shows `[DB] Driver: postgres (mirror) | sqlite: memory`
  and `[DB][migrate] applied #1 initial`, and `_meta.schemaVersion=1` lands in the
  real database. With a deliberately unreachable DSN the container starts but
  every DB-backed route answers `connect ECONNREFUSED` and **no `data.sqlite` is
  created** — the no-fallback rule, verified rather than assumed.

### Docker gotcha on this machine

`--add-host=host.docker.internal:host-gateway` does **not** work on this daemon
(native `docker.io`, not Docker Desktop): `/etc/hosts` gets `invalid IP
host.docker.internal` and the container silently cannot resolve the database.
Use the bridge gateway explicitly — `--add-host=host.docker.internal:10.0.0.1`
(confirm with `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'`).
