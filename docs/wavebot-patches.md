# WaveBot patches

This branch (`wavebot/main`) is `decolua/9router` plus the patches WaveBot needs
to run it as the System AI Pool router. The branch is a **rebase target**, not a
divergent product: keep every patch small, self-contained and commented, so
`git rebase upstream/master` stays cheap.

- Upstream: <https://github.com/decolua/9router> (`upstream/master`)
- Written against: `1855aa44` — upstream master, package version 0.5.116
  (package.json), commit subject "# v0.5.119 (2026-11-11)"
- Image: none — the deploy host builds this checkout from the compose
  `build:` context (`wavebot/docker-compose.llm.yml`); ruling 2026-11-14
  removed `.github/workflows/docker.yml` and with it the GHCR publishing.

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

Rebase checklist: if upstream changed `src/lib/db/schema.js` (a table or column), add a
numbered `db/migrations/NNN_*.sql` for it — `tests/unit/migrations-drift.test.js` fails
until you do. Never edit an applied migration.

## Patches

| # | Patch | Files | Why |
|---|---|---|---|
| 1 | Baseline verifier works outside `/app/` | `tests/__baseline__/verify-no-regression.mjs` | Its path split assumed a container path; every known failure read as a regression in any other checkout. |
| 2 | WaveBot ticket login | `src/lib/auth/wavebotTicket.js`, `src/app/dashboard/auth/ticket/route.js`, `src/dashboardGuard.js` | The router dashboard is opened through a one-time ticket minted by WaveBot; there is no second password to manage. The verify POST waits `VERIFY_TIMEOUT_MS` (15 s): 5 s lost a race against `next dev`'s lazy compile of the verify route (WaveBot answered 200 at 5.4 s and the first click after a dashboard restart died `error=wavebot_ticket`). |
| 3 | Password login off in WaveBot mode | `src/app/api/auth/login/route.js`, `src/app/login/page.js`, `src/app/api/auth/mode/route.js` | With `WAVEBOT_AUTH_URL` set, the only door is the ticket. |
| 4 | Session → account pinning | `src/sse/services/sessionPin.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js` | Conversation affinity keeps a session's prompt cache on one upstream account. Availability still wins over affinity. |
| 5 | Per-account in-flight cap | `src/sse/services/accountInflight.js`, `src/sse/services/auth.js`, `open-sse/handlers/chatCore.js`, `open-sse/utils/stream.js` | A leaked slot is bounded by TTL; a full account is skipped, and all-full answers a retryable 503 instead of "no credentials". An account that fills between being chosen and taking its slot also answers `account_busy` rather than being served anyway (`tests/unit/auth-slot-race.test.js`). |
| 6 | `spread` strategy | `src/sse/services/auth.js`, `src/lib/db/repos/settingsRepo.js`, dashboard profile page | Scores accounts by in-flight count, then backoff, then recency before priority. |
| 7 | Postgres-backed persistence | `src/lib/db/postgresSql.js`, `src/lib/db/postgresJournal.js`, `src/lib/db/adapters/postgresAdapter.js`, `src/lib/db/driver.js`, `src/lib/db/migrate.js` | WaveBot operates one Postgres; the router's state lives there, behind the existing synchronous repo API, with an fsync'd journal so an acked write survives a kill. The router never creates or alters Postgres tables: the schema is `db/migrations/*.sql`, applied by goose (WaveBot's `migrate` job / `make migrate`) before the router boots. An unmigrated database fails with `relation "settings" does not exist`. `tests/unit/migrations-drift.test.js` fails when `schema.js` and the migrations disagree. |
| 8 | Container image on `node:24-alpine` | `Dockerfile` | `node:sqlite` needs Node ≥22.5; the runner must carry `pg`, so it copies the built `node_modules` instead of an upstream file list. Built by the deploy host from the compose `build:` context — the GHCR workflow was removed on 2026-11-14 (the registry is no longer used). `Dockerfile.dev` (hot-reload dev image) predates this patch. |
| 9 | Ticket redirects on the client's origin | `src/lib/auth/ticketOrigin.js`, `src/app/dashboard/auth/ticket/route.js` | `request.url` carries the bind address (`0.0.0.0`), so a successful login redirected to `http://0.0.0.0:20128/dashboard`. Builds the target from `Host` (+`x-forwarded-proto`). |
| 10 | _(retired)_ | — | Mirror column reconciliation was removed with the boot DDL; goose owns the schema (patch 7). |
| 11 | Every slot acquirer releases it | `src/sse/handlers/{tts,stt,embeddings,search,fetch,systemone,videoGeneration,imageGeneration}.js`, `src/sse/services/systemoneRouter.js`, `src/app/api/v1beta/models/[...path]/route.js`, `open-sse/handlers/chatCore.js`, `src/sse/services/accountInflight.js` | Patch #5 takes the slot inside `getProviderCredentials` for EVERY caller, but only the chat path released it: four image/TTS/search calls wedged an account into `account_busy` for the whole 10-minute TTL. Pinned by `tests/unit/nonchat-slot-release.test.js` (a module that acquires must release) and `tests/unit/nonchat-slot-behaviour.test.js`. When the RESPONSE IS A LIVE STREAM (codex image generation, the Gemini-native proxy) the release must follow the body, not the return: `releaseSlotWithBody` wraps it and frees the account on end/error/cancel — a `finally` released before the client read a byte, so four parallel streams looked like one in flight. Pinned by `tests/unit/slot-release-with-body.test.js` and `tests/unit/image-slot-streaming.test.js`. |
| 12 | Journal truncates only what was confirmed | `src/lib/db/adapters/postgresAdapter.js`, `src/lib/db/postgresJournal.js` | `flushOnce` truncated the WHOLE journal after awaiting Postgres, deleting the durable copy of any write that arrived mid-flush — one already acknowledged to its caller. Rewrite with the still-unconfirmed groups instead. A group also now runs BEGIN/COMMIT on ONE pooled connection: `pool.query` checks out per call, so a group could commit statement-by-statement and be dropped from the journal as if it were atomic. |
| 13 | Plain INSERT is replay-safe | `src/lib/db/postgresSql.js` | The journal replays any group that "may or may not have reached Postgres". A plain `INSERT INTO kv(scope, key, value)` raised `23505` on the second run, and boot replay rethrows, so the mirror refused to start. A plain INSERT whose whole primary key is bound now gets `ON CONFLICT DO NOTHING`. Pinned by `tests/unit/postgres-sql.test.js`; the statement was also probed on the real database (duplicate raises `kv_pkey`, DO NOTHING leaves one row). **Known limitation:** `usageHistory` has a serial id that is not in the column list, so a replayed row gets a NEW id and is double-counted. The window is a crash between Postgres COMMIT and the journal rewrite. It is not closed here. |
| 14 | `requireLogin=false` cannot open a ticket-gated router | `src/dashboardGuard.js` | Stock 9router has a "require login" toggle that makes `/dashboard` and the protected `/api/*` paths public. With `WAVEBOT_AUTH_URL` set the ticket is the only door, so the toggle is ignored (`loginOptional`). Outside WaveBot mode behaviour is unchanged. Pinned by `tests/unit/dashboard-guard-wavebot.test.js`. |
| 15 | Dev server accepts a configured Origin | `next.config.mjs` | The local stack runs `next dev`, and Next blocks its own `/_next` dev resources (chunks, the HMR socket) when the browser's `Origin` is not loopback. Reaching the dev router on a LAN/Tailscale name therefore painted the app shell and then stuck on "Loading..." while every `/login` HTML response still answered 200. `ALLOWED_DEV_ORIGINS` (comma-separated) feeds `allowedDevOrigins`; empty by default, so loopback is unchanged and an unlisted Origin still gets 403. Deployment never met this: it serves a production build, where the check does not exist. |
| 16 | No API key beside the WaveBot boundary | `src/lib/db/repos/settingsRepo.js` (default `requireApiKey: false`), `src/dashboardGuard.js` (`canAccessPublicLlmApi`), `src/lib/fork/exposureUi.js` | Owner decision 2026-11-14: plan admission (quota, concurrency, model unlock) lives entirely in WaveBot; the single `/v1` client is the WaveBot dashboard on the same compose network. A shared API key would be a second, weaker credential beside that boundary, so the fork defaults the setting off — and the proxy gate must honour that too, because stock `canAccessPublicLlmApi` demanded loopback/CLI-token/API-key even from the trusted container peer regardless of the setting. A settings read failure keeps stock behaviour (never open by accident). Pinned by `tests/unit/wavebot-fork-policy.test.js` and `tests/unit/dashboard-guard-apikey-policy.test.js`; keyless `GET /v1/models` verified 200 on the live dev router. |
| 17 | Exposure UI hidden | `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/lib/fork/exposureUi.js` | With patch 16 the keyless `/v1` is only safe while nothing publishes it beyond the compose network, so the Endpoint page's Cloudflare Tunnel and Tailscale rows, their warning banners, the tunnel-dashboard-access toggle and the whole API Keys card are gated behind `SHOW_EXPOSURE_UI = false`. Flip the constant only when deploying 9Router standalone. |
| 18 | Priority-ordered upstream wait + limits/load admin API | `src/sse/services/accountInflight.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js`, `src/lib/forkAdminAuth.js`, `src/app/api/fork/limits/route.js`, `src/app/api/fork/load/route.js`, `src/lib/db/repos/settingsRepo.js`, `src/dashboardGuard.js` | Patch #5 answered `account_busy` the instant every account sat at its in-flight cap, so a burst of WaveBot turns failed instead of queueing for the seconds a slot takes to free. WaveBot now tags each call with `x-wavebot-priority: interactive\|background` (missing = background); a capped chat request waits up to `upstream_wait_ms` in a queue ordered interactive first, then FIFO, then falls back to today's `account_busy`. A release wakes every waiter in that order and each re-contends through the selection mutex; the queue is process memory (a restart drops it, waits last seconds). Only `chat.js` opts in (`wait: true`); every other handler keeps the immediate `account_busy`. `account_max_inflight` (1-64) and `upstream_wait_ms` (0-120000) are runtime-editable via `GET/PUT /api/fork/limits`, stored in the settings repo (`accountMaxInflight`, `upstreamWaitMs`; `ACCOUNT_MAX_INFLIGHT` stays the default), out-of-range = 400 not clamped. `GET /api/fork/load` returns per-account `{id, inflight, limit}`, queued counts by priority, `oldestWaitMs` and `busy5m`. Auth for both: bearer `WAVEBOT_FORK_ADMIN_TOKEN` (constant-time compare; unset/empty never matches) or an admin ticket session; `/api/fork` is listed as a public path in `dashboardGuard.js` because the routes authenticate themselves. Pinned by `tests/unit/account-inflight-priority.test.js`, `tests/unit/auth-inflight-cap.test.js`, `tests/unit/fork-limits-api.test.js`, `tests/unit/fork-load-api.test.js`. |
| 19 | Fanout combo mode | `src/sse/services/fanoutBudget.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js`, `src/app/(dashboard)/dashboard/combos/page.js`, `src/app/(dashboard)/dashboard/combos/strategy-config.js` | A combo can opt into fanout account selection with `settings.comboStrategies[name].fanout = { enabled: true, budgets: { <connectionId>: <int>=1 } }` — NOT a new `fallbackStrategy` value (member choice and account choice are orthogonal). Each account then runs at its OWN in-flight budget (missing/invalid entry = the global limit), so the combo's usable pool is the SUM of budgets instead of one global cap; selection ranks by free headroom ratio `1 − inflight/budget` (ties: backoff → oldest use → priority, nullish so priority 0 stays highest) and overrides the provider strategy for that leg; the slot is acquired with the chosen account's budget. Session pin (patch #4) is untouched: a pin with headroom is honoured (cache hit), a pin at its budget falls out of the filtered set and the ranking migrates once, re-pinned on success. The raw config rides chat.js → `handleSingleModelChat` → `getProviderCredentials` unparsed; auth.js parses it exactly once. Nested combos are innermost-wins: a member that is itself a combo uses its own fanout config, and an outer combo's fanout never leaks into an inner combo that did not opt in. Non-chat handlers ignore `.fanout`. The combos-page merge (`mergeStrategyPatch`) keeps a fanout-enabled entry alive even when `fallbackStrategy` stays at the default — the old merge deleted the whole entry in that case, silently eating the fanout config. Invalid budgets never error: they fall back to the global limit. Pinned by `tests/unit/fanout-budget.test.js`, `tests/unit/auth-fanout-strategy.test.js`, `tests/unit/chat-fanout-threading.test.js`, `tests/unit/combos-strategy-config.test.js`. |

## Runtime environment (fork-specific)

| Variable | Meaning |
|---|---|
| `LLM_ROUTER_DATABASE_URL` | Postgres DSN for the mirror. **Set ⇒ Postgres, with no SQLite fallback**: an unreachable database fails the request (and the boot) rather than silently serving from a local file. Unset ⇒ upstream's SQLite chain. |
| `LLM_ROUTER_JOURNAL_DIR` | Directory for the write journal (default `DATA_DIR/db`). Must be on a volume, or a restart loses unflushed groups. |
| `WAVEBOT_AUTH_URL` | WaveBot base URL the ticket is verified against. Set ⇒ password login is off and the dashboard is reached only through a ticket. |
| `ACCOUNT_MAX_INFLIGHT` | Per-account in-flight cap (default 4); the runtime setting from `PUT /api/fork/limits` overrides it. |
| `WAVEBOT_FORK_ADMIN_TOKEN` | Bearer secret for `/api/fork/limits` and `/api/fork/load` (patch 18). Unset = bearer never matches. |
| `JWT_SECRET` | Dashboard session cookie signing key. Required. |
| `ALLOWED_DEV_ORIGINS` | Comma-separated hostnames the **dev** server accepts as a cross-origin source for `/_next` resources (`allowedDevOrigins`). Empty by default; loopback always works. Production builds ignore it. |

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
- Durability (2026-11-13): `postgres-adapter` covers a write arriving DURING
  a flush (its journal line survives) and a group's BEGIN/COMMIT/RELEASE on one
  connection.
- Slot release (2026-11-13): `nonchat-slot-release` (11 acquirers, each also
  releases) and `nonchat-slot-behaviour` (the real TTS handler leaves the
  semaphore at zero on success, on a terminal failure and on a throw).
  Streaming results: `slot-release-with-body` (held until read, freed on
  cancel, immediate when bodiless) and `image-slot-streaming` (the real image
  handler holds an SSE body and frees it once consumed).
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
