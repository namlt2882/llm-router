# Live quota collapse + re-check queue; Concurrency tab; separate Timescale DB container — design

Date: 2026-11-16 · Owner: Steve (decisions) · Author: session notes
Repo: `9router-fork` (branch `wavebot/ai-concurrency-v2`) · Infra files live in the `wavebot` repo

Follow-up to `2026-11-15-capacity-autodetect-design.md`: that feature measures
budgets on a daily scan. This design adds two things the scan cannot do —
react **during** live traffic, and **see** concurrency over time.

## Intent

Three pieces, approved by Steve on 2026-11-16:

1. **Live quota collapse + scheduled re-check.** When a request is streaming
   and an account's quota runs out, that (connection, model) concurrency
   budget must drop to 0 **immediately** — not at the next daily scan. If the
   error names a reset time within 24h, schedule a re-check for exactly that
   moment: one tiny probe; on success the budget is restored automatically
   instead of waiting for tomorrow.
2. **Concurrency tab in Usage.** Same period selector as Usage (today / 24h /
   7d / 30d / 60d / all). Bars = total concurrency at that time. Lines =
   concurrency utility rate %, cumulative tokens, cumulative USD cost.
3. **TimescaleDB, in its own container.** The time-series data above deserves
   a time-series database, and WaveBot will adopt Timescale in the future —
   so prove it here first. **Ruling (Steve): WaveBot's DB and the router's DB
   must be two separate containers.** A new dedicated Timescale container is
   created for the router; WaveBot's existing `db` container is untouched.

## Approaches considered

- **A. TimescaleDB in a dedicated `llm-db` container (CHOSEN).** Hypertables +
  retention policy for the samples table; the router database finally gets
  its own Postgres instance, isolating it from WaveBot's lifecycle. Steve
  picked A and added the container split.
- **B. Plain Postgres in a separate container.** Same isolation, no Timescale.
  At 173k rows (60 days × 30s) a plain table is fast enough — but the whole
  point is proving Timescale for the WaveBot future, and retention policies
  are exactly what we'd otherwise hand-roll.
- **C. No new infra — samples into settings/kv JSON.** Rejected: unbounded
  growth inside one JSON settings row; not queryable; not what tables are for.

## Non-goals

- No per-provider or per-model concurrency history — the sampler records
  system totals (inflight, total budget) per tick. Per-lane history is a
  later feature on the same table.
- No backfill: charts start at the moment the sampler first runs.
- No alerting/notifications on quota collapse.
- WaveBot's database does not gain Timescale in this change (its image stays
  `pgvector/pgvector:pg15`, pgvector remains dead and uninstalled).

## Anti-goals

- No reintroducing vector columns/extensions anywhere.
- No `goose down|reset|redo`, no editing an applied migration.
- The DB password never on argv, in logs, or in an `echo`.

---

## Part 1 — Live quota collapse + scheduled re-check

### Detection site — inside `markAccountUnavailable`, not per call site

`markAccountUnavailable(connectionId, status, errorText, provider, model, resetsAtMs)`
(`src/sse/services/auth.js:426`) is the funnel every failure path already goes
through — ~10 call sites today (chat, embeddings, imageGeneration, stt, tts,
search, fetch, videoGeneration, systemone, v1beta models) and whatever comes
next. The collapse hook goes **inside** `markAccountUnavailable`, at the very
top, **before** the existing keyless-lane early return — so keyless lanes
collapse too (their `connectionId` is the provider id, which is exactly the
`detectedBudgets` key the scan uses for them), and no future call site can
forget it. The function keeps its in-process semantics (model lock + cooldown)
unchanged below the hook.

New file `src/sse/services/quotaCollapse.js`:

```js
handleLiveQuotaError({ connectionId, provider, model, errorText, resetsAtMs })
```

- **Quota rule (must compose with GLM 1308):** a live error collapses the
  lane when **either** its text matches the scan's quota hints
  (`GoUsageLimitError`, "usage limit reached (monthly)") **or** the executor
  handed in a `resetsAtMs` — the executor `parseError`s only emit reset times
  for quota-window errors (GLM 1308 → UTC+8, codex, antigravity,
  codebuddy-cn/intl), so a non-null `resetsAtMs` is itself a quota signal.
  The flagship case, GLM 1308, classifies as `throttle` under the probe
  classifier's own rules, so "reuse the hints alone" would miss it — this
  two-signal rule is deliberate. Concretely: widen
  `src/lib/fork/capacity/classifyError.js` with one exported helper
  (e.g. `matchesQuotaHints(text)`; the file has zero imports, so no cycle
  from `src/sse/services/`), and `handleLiveQuotaError` collapses when
  `matchesQuotaHints(errorText) || resetsAtMs != null`. On collapse:
- Write `detectedBudgets[connectionId][model] = { budget: 0, quota: true,
  previousBudget, detectedAt: <ISO now>, source: "live" }` where
  `previousBudget` is the budget currently stored for that key (or absent).
  `budget: 0` + `quota: true` already reads as **terminal 0** in
  `detectedBudgetFor` / `effectiveFanoutBudget`, so admission squeezes the
  lane immediately — every new request routes elsewhere; in-flight requests
  finish or fail on their own.
- **Keyless lanes:** `connectionId === providerId` for keyless providers —
  write under the provider key exactly like the scan does, and exit early on
  the keyless lane id inside `markAccountUnavailable` stays as-is.
- **Reset time:** prefer the caller's `resetsAtMs` (GLM error 1308 already
  parses to UTC+8 in `open-sse/executors/default.js`); otherwise parse
  `errorText` with a new `parseResetsIn()` (handles "resets in 8d 4h",
  "resets in 5h 20m" — the opencode `GoUsageLimitError` shape). Null if
  unparseable.
- **Re-check queue:** if `resetsAtMs` is ≤ 24h ahead, upsert
  `settings.quotaRecheck` entry `{ connectionId, provider, model, at }`
  (dedupe on connectionId+model; `settings` is the existing JSON settings
  row — survives restarts like `detectedBudgets`). Beyond 24h or unparseable
  → no entry; the daily scan remains the fallback.

Manual budgets (`comboStrategies[combo].fanout.budgets[conn]`) keep winning
over detected at runtime — existing precedence, unchanged. The daily scan
re-measuring an account in quota classifies the same quota error and writes
`budget: 0` itself — consistent, last truthful writer wins.

### Re-check scheduler

New file `src/lib/fork/capacity/quotaRecheck.js`:

- `ensureQuotaRecheckScheduler()` — booted from `src/instrumentation.js`
  next to `ensureCapacityScheduler`. 60s interval, double-boot guard, same
  pattern as the scan scheduler.
- Each tick: entries with `at <= now`, oldest first, capped at 5 per tick.
  Probe = the scan's own primitive (`probeConnectionModel`, `maxLevel: 1`) —
  **one tiny real request against that connection's actual model**, so the
  verdict is the upstream's, not a guess.
- **Probe ok** → restore: `previousBudget != null` → write back
  `{ budget: previousBudget }`; else delete the `detectedBudgets` key
  entirely; call `clearAccountError(connectionId, currentConnection, model)`
  (`src/sse/services/auth.js:484` — the inverse of the lock
  `markAccountUnavailable` set; the scan itself clears nothing, so this is
  the re-check's job alone); remove the queue entry.
- **Probe says quota again** → keep `budget: 0`; if the fresh error yields a
  new `resetsAtMs` ≤ 24h, update `at` (reschedule); else drop the entry.
- **Probe transport-fails** (timeout/network) → keep the entry, retry next
  tick; drop once `now - at > 24h` (staleness guard).
- **Connection deleted meanwhile** → the probe resolves a missing connection
  → drop the entry, log once. Never an error loop.

### Visibility

`GET /api/fork/capacity-scan` gains `quotaRecheck: [{ connectionId, provider,
model, at }]` from settings. The provider detail card (which already shows
the scan's "hết hạn mức" state) gains one line when an entry exists for it:
`Hết hạn mức — tự kiểm tra lúc HH:MM`.

---

## Part 2 — Sampler, samples table, Concurrency tab

### Table `concurrencySamples`

Two samples per minute: (inflight requests, total system budget). That is
2,880 rows/day, ≈173k rows over 60 days — exactly what hypertables are for.

Columns (mirror contract: every column `text`, PKs that auto-allocate are
sequences):

| column | PG type | notes |
|---|---|---|
| `id` | `bigserial PRIMARY KEY` | same exception as `usageHistory.id`; the SQLite side declares `id: "INTEGER PRIMARY KEY AUTOINCREMENT"` (verbatim `usageHistory`'s idiom, `schema.js:115`) |
| `ts` | `text NOT NULL` | ISO instant from `Date.now()` |
| `inflight` | `text NOT NULL` | active requests at the tick |
| `totalBudget` | `text NOT NULL` | total effective system concurrency budget at the tick |

Two adapter obligations beyond the table itself: `postgresAdapter.PRIMARY_KEYS`
(`src/lib/db/adapters/postgresAdapter.js:36-48`) gains a `concurrencySamples`
entry (plain INSERTs pass without it, but any upsert path would throw), and
`resyncSequences` (:270-281) includes it alongside `usageHistory`. A crash
mid-journal can replay a sampler INSERT and duplicate one sample row — the
same known, accepted tradeoff as `usageHistory`; averages over 30s samples
are indifferent to a doubled tick.

Utility rate is **not stored** — it is `inflight / totalBudget`, computed at
read time. Store raw facts only.

Registration in **both** schema systems (the drift test enforces the pair):

- `src/lib/db/schema.js` `TABLES.concurrencySamples` + `SCHEMA_VERSION` 2→3
  (drives the pre-change backup). SQLite deployments get the table via the
  existing `syncSchemaFromTables` auto-sync.
- `db/migrations/002_concurrency_samples.sql` (goose; applied migrations are
  frozen, this is a new number):

```sql
-- +goose Up
CREATE TABLE IF NOT EXISTS concurrencySamples (
  id bigserial PRIMARY KEY,
  ts text NOT NULL,
  inflight text NOT NULL,
  totalBudget text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concurrency_ts ON concurrencySamples(ts);
-- +goose StatementBegin
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('concurrencySamples', 'ts',
      chunk_time_interval => INTERVAL '1 day',
      time_partitioning_func => 'to_timestamp',
      if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM add_retention_policy('concurrencySamples', INTERVAL '60 days',
      if_not_exists => TRUE);
  END IF;
END $$;
-- +goose StatementEnd
-- +goose Down
SELECT remove_retention_policy('concurrencySamples', if_exists => TRUE);
DROP TABLE IF EXISTS concurrencySamples;
```

The `DO $$` guard is deliberate: on **vanilla Postgres** (including the
throwaway containers `verify-migrations.sh` spins up on the stock pg15
image) the migration still succeeds and leaves a plain table — Timescale is
an optimization, never a boot dependency. The `-- +goose StatementBegin`
/ `-- +goose StatementEnd` markers are equally deliberate (added during
execution after a throwaway-pg15 reproduction): goose splits statements on
`;` and would otherwise cut the DO block at its first body semicolon. Where the extension exists
(the new `llm-db` container, after `CREATE EXTENSION` in the ensure script)
the table becomes a hypertable chunked by 1 day with a 60-day retention
policy. `to_timestamp` is required because `ts` is `text` under the mirror
contract; the plan task live-verifies that Postgres parses our ISO-8601
strings (`2026-11-16T10:00:00.000Z`) with it.

**Deliberate drift-test updates** (each watched RED first — adding the
migration breaks the strict tests, then the contract is widened in the same
change, which is exactly the pinned-deliberate-change path the test's own
comments describe):

- `expectedMirrorType`: allow `concurrencySamples.id` → `bigserial`
  (alongside `usageHistory.id`).
- Index pin test: `inMigrations` was pinned to `[]`; becomes
  `["idx_concurrency_ts"]`, with the same index declared in
  `schema.js` — the "adding one here is a deliberate change" case.

Retention constant: 60 days, in one place, shared by the PG policy and the
SQLite prune below.

### Sampler

New file `src/lib/usage/concurrencySampler.js`:

- `ensureConcurrencySampler()` — booted from `src/instrumentation.js`.
  30s `setInterval`, double-boot guard, `unref()` so it never holds the
  process open.
- Each tick:
  - `inflight` = Σ `r.count` over `getActiveRequests().activeRequests` (the
    function returns `{ activeRequests, recentRequests, errorProvider }`, not
    an array). Tracked scope is deliberate: `trackPendingRequest` fires only
    from `open-sse/handlers/chatCore.js` and `open-sse/utils/stream.js` — real
    client traffic, fanout lanes included (each lane request is one tracked
    request). Capacity-scan probes dispatch raw and never track, so
    diagnostics do not pollute the concurrency history. Document this at the
    call site.
  - `totalBudget = systemConcurrencyBudget(settings, connections)` — new
    export next to the combo summary logic: every active connection counted
    **once**, at its **max** effective budget across models (detected, else
    the global `accountInflightLimit()`), keyless providers without
    connections once at `keylessLaneLimit` — the same lane rules
    `comboSummary` applies, minus combo filtering. Small dedicated helper,
    not a forced refactor of `comboSummary` (different traversal; DRY the
    lane arithmetic only if it falls out naturally).
  - Write one row via `recordConcurrencySample(inflight, totalBudget)` in
    `usageRepo.js` — through the adapter, so SQLite and PG deployments take
    the same code path.
- **Prune (SQLite deployments):** hourly (minute === 0 check inside the
  tick), `DELETE FROM concurrencySamples WHERE ts < now − 60 days`. On PG
  the retention policy drops chunks first, so the same DELETE matches
  ~nothing and stays as the vanilla-PG safety net. One code path, both worlds.

SQLite-only deployments (no `LLM_ROUTER_DATABASE_URL`) keep working
end-to-end: table via auto-sync, sampler local, prune local. The design does
not assume Postgres anywhere in Part 2's runtime path.

### Chart data

`getConcurrencyChartData(period)` in `usageRepo.js`, alongside
`getChartData`:

- Bucket boundaries **identical to `getChartData`'s periods** (today/24h
  hourly; 7d/30d/60d daily; all daily) — "chọn các khung giờ giống usage".
- Per bucket:
  - `concurrency` — average of the bucket's `inflight` samples (uniform 30s
    ticks, so a plain mean is time-weighted) — ruling (Steve, 2026-11-16):
    the bar shows the bucket's average, not its peak.
  - `utilityRate` — `Σ inflight / Σ totalBudget × 100` over the bucket
    (budget-weighted, not a mean of ratios).
  - `cumulativeTokens`, `cumulativeCost` — running Σ over `usageHistory`
    rows inside the selected window (tokens, and USD cost already computed
    per row). **Window-cumulative** — ruling (Steve, 2026-11-16): the line
    starts at 0 at the window's left edge, not a lifetime running total.
- `totalBudget === 0` buckets produce `utilityRate: null` (no line point),
  never `Infinity`/`NaN`.

### UI

- The usage page is a **client component** (`"use client"`,
  `page.js:1`) and its chart data arrives by fetching
  `GET /api/usage/chart` — there is no server-side data path to copy. The
  Concurrency tab follows the real pattern:
  - New API route `src/app/api/usage/concurrency/route.js` — sibling of the
    chart route, same auth, `?period=` in, `getConcurrencyChartData(period)`
    out.
  - `page.js` gains the third tab id `concurrency` in its `?tab=` switch;
  - new client component `components/ConcurrencyChart.js` (recharts
    `ComposedChart`) fetches it like `UsageChart.js` fetches the chart
    route: bars = concurrency (left axis, count), line = utility %
    (left axis, percent), two lines = cumulative tokens + cumulative USD
    (right axis). Dual axis; the same period pill row as the Overview tab.

---

## Part 3 — Separate `llm-db` Timescale container

**Ruling (Steve, 2026-11-16):** WaveBot's DB and the router's DB become two
containers. WaveBot's `db` (image `pgvector/pgvector:pg15`) is untouched; the
router gets a dedicated Timescale instance.

### New files (wavebot repo)

`docker-compose.llm-db.yml` — its **own Coolify resource** (stateful, like
the storage stack):

- service `llm-db`, image `timescale/timescaledb` pinned to a concrete pg15
  tag (picked at implementation from what actually pulls; `latest-pg15`
  dev-only). The Timescale image ships `shared_preload_libraries=timescaledb`.
- `POSTGRES_PASSWORD=${LLM_DB_SUPERUSER_PASSWORD:?required}` — the new
  instance's own superuser, distinct from WaveBot's.
- External volume `${VOLUME_PREFIX:-wavebot-coolify}_llm-db-data`.
- Published port `${LLM_DB_HOST_PORT:?required}` — **required**, not
  defaulted: host-side goose needs a reachable Postgres, and leaving it
  defaulted is how two stacks end up on one port (WaveBot's db publishes
  25432; llm-db takes its own).
- Healthcheck `pg_isready`.
- `check-coolify-compose.mjs` must learn this file (new Coolify resource
  list entry).

Dev mirror: the service is added to `docker-compose.llm.dev.yml` (the llm
stack's own database — cohesive, no new layer in `COMPOSE`), publishing
`${LLM_DB_HOST_PORT:-20129}` and using the dev superuser defaults the same
way the local postgres is `postgres/postgres`. `check-local-compose.mjs`
must learn the **sixth** mirror pair (its `MIRRORS` map already holds five —
storage/app/workers/avatar/llm — plus the packages/gpu extras; a new
`llm-db` entry joins the pair loop, and
`check-coolify-compose.mjs`'s `EXPECTED_SERVICES` gains the matching
Coolify resource).

### URL + Makefile retarget

- `docker-compose.llm.yml` and `docker-compose.llm.dev.yml`:
  `LLM_ROUTER_DATABASE_URL` host `@db:5432` →
  `@${LLM_DB_HOST:-llm-db}:5432`. `LLM_DB_HOST` is the **only** new host
  override (compose-internal DNS name; there is no `LLM_ROUTER_DB_HOST`
  variable anywhere — the operator override, if ever needed, is
  `LLM_DB_HOST`). The Coolify resource for llm-db must have
  **connect_to_docker_network** enabled — compose services only join the
  destination network when that resource switch is on, and without it there
  is no name resolution between stacks.
- `Makefile` `llm-db` target: `up -d llm-db` (not `db`), `PSQL` default
  `docker exec -i wavebot-llm-db-1 psql -U postgres`, superuser env
  resolution from the new instance's vars.
- `llm-db-ensure.sh` gains one statement in its `\connect :"llm_db"` section:
  `CREATE EXTENSION IF NOT EXISTS timescaledb;` — the only superuser-only
  step, and this script is the superuser step. Everything the migration
  needs afterwards (hypertable, retention) runs as `llm_router`, the table
  owner, through goose.
- The goose half of `make migrate` (`MIGRATIONS_DIR=../9router-fork/...`)
  must point its DSN at the new instance's published port (env resolution
  like the rest of the target); exact wiring is a plan task against
  `goose-migrate.sh`/`prod-connection.ts`.
- `verify-migrations.sh` keeps the stock pg15 image — the guarded 002
  succeeds there by design (plain table). Its c22 case (clean llm database
  built by goose as `llm_router`, main database closed to it) retargets the
  throwaway **instance** it uses for the llm half only if that case pins a
  host/port — otherwise unchanged.

### Data migration (dev runbook, executed once)

1. Stop the router (`docker compose ... stop llm-router`).
2. `pg_dump` `wavebot_llm_router` out of `wavebot-db-1` **as `llm_router`** —
   password only via `PGPASSWORD` env / `.pgpass`, never argv, never echoed.
3. `make llm-db` (new container up, role + database created, extension on).
4. Restore the dump into `wavebot-llm-db-1`. `goose_db_version` rides the
   dump, so the ledger carries over and `make migrate` applies only 002.
5. Recreate the router container with the new URL (the compose default
   `llm-db` makes this a plain `up -d --force-recreate llm-router`), watch
   `/api/health` and the boot log for the Postgres adapter line.
6. The old database inside `wavebot-db-1` stays until verified, then the
   operator drops it by hand (we never run `DROP DATABASE` ourselves).

### Prod

Rides the **held release** (unpushed fork commits + the wavebot-app redeploy
hold). When released: new Coolify resource for `docker-compose.llm-db.yml`
with `connect_to_docker_network`, `LLM_DB_SUPERUSER_PASSWORD` set on that
resource, `LLM_DB_HOST`(+port) on the router resource, backup-first
(`pg_dump` prod `wavebot_llm_router` before restore), then migrate.yml's llm
half against the new host. Not automated in this change.

---

## Risks & plan-time verifications

- **The PG adapter dual-writes into the memory-SQLite mirror** (confirmed by
  builder check: `run()` writes RAM first, then journals to PG; boot reloads
  every row). Sampler rows therefore live in RAM: ≈17MB over 60 days,
  bounded by the prune, reloaded at each boot — accepted.
- **`to_timestamp(text)` on our ISO strings** — live-verify on the new
  container before trusting the hypertable (a silent full-scan hypertable
  would still work but chunk nothing).
- **In-memory mirror growth** — bounded by the 60-day prune; confirm the
  prune path exists on every adapter (SQLite file, node:sqlite, sql.js, PG).
- **Scheduler double-boot** — both new schedulers follow the existing
  `ensureCapacityScheduler` guard pattern; test the second call is a no-op.

## Test plan (TDD; regression gate = full suite + `tests/__baseline__/verify-no-regression.mjs`)

- `quotaCollapse`: live quota error → `detectedBudgets` written with
  `budget: 0, quota: true, previousBudget` stash; non-quota errors untouched;
  **the two-signal rule**: GLM 1308 text with `resetsAtMs` collapses even
  though the probe classifier calls it `throttle`, and hint-matching text
  without `resetsAtMs` collapses via `parseResetsIn`; a generic 500
  collapses neither; keyless lane writes under the provider key; reset ≤24h
  enqueues, >24h or unparseable doesn't; dedupe by conn+model; **funnel
  coverage**: calling `markAccountUnavailable` directly (as the
  embeddings/image sites do) reaches the collapse.
- `quotaRecheck`: due entry probed with `maxLevel: 1`; success restores
  previousBudget (or deletes the key), calls `clearAccountError`, drops the
  entry; quota-again reschedules within 24h / drops beyond; transport failure
  retries then drops at 24h; deleted connection drops the entry; scheduler
  double-boot no-op; queue survives restart (settings persistence).
- Sampler: tick writes (inflight, totalBudget); totalBudget lane rules
  (max-over-models per connection, global fallback, keyless ceiling); hourly
  prune removes >60d rows and nothing else; double-boot no-op.
- `getConcurrencyChartData`: bucket boundaries match `getChartData` per
  period; average concurrency; budget-weighted utility rate;
  window-cumulative tokens/cost; zero-budget bucket → `utilityRate: null`;
  empty table → empty series (no NaN).
- Drift test: RED when 002 lands (strict contract), then the two deliberate
  whitelist updates go green in the same commit series.
- `verify-migrations.sh`: full chain green on the stock pg15 image (guarded
  002 leaves a plain table there).
- **Live verification:** new `llm-db` container up; dump/restore; 002 applied
  and hypertable confirmed (chunk count grows); sampler rows appearing at
  30s; Concurrency tab renders with data; a real quota collapse (or a
  staged one) squeezes the lane immediately and the re-check probe restores
  it at the reset time.

## What's left to the builder

- Pinned Timescale image tag (concrete pg15 tag, picked from what actually
  pulls; `latest-pg15` dev-only).
- The `make migrate` llm half's DSN wiring: today it sets only
  `WAVEBOT_PG_DB/USER/PASSWORD` (Makefile:225-232) and lands on the wrapper
  defaults (`WAVEBOT_PG_HOST` 127.0.0.1, `WAVEBOT_PG_PORT` 15432 dev /
  25432 prod, `goose-migrate.sh:88-91`; mirrored in
  `packages/db/src/prod-connection.ts:46,54`). After the split it must pin
  `WAVEBOT_PG_HOST`/`WAVEBOT_PG_PORT` at the new instance's published port.
- The two compose lint scripts' new entries (exact list locations confirmed:
  `check-coolify-compose.mjs:19-26` + its file loop; the local script's
  `MIRRORS` map).

## Decisions (Steve, 2026-11-16)

1. Cumulative lines — **window-cumulative** (the line starts at 0 at the
   window's left edge), not lifetime-cumulative.
2. Bar value per bucket — **average** concurrency, matching the
   utility-rate math; not peak.
3. Sampler every **30s**, retention **60 days** — stands as designed
   (question asked alongside 1–2; no objection raised).
4. The re-check probe sends **one tiny real request** (`maxLevel: 1`) to the
   real model at the reset moment — inherent to "tự check account đó và mở
   lại quota"; a few tokens of cost per restored account, accepted.
