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
