# Capacity Auto-Detect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure each provider connection's real max concurrency **per (connection, model)** with cheap operator-chosen diagnostic models on a daily system-wide scan, and let those detected budgets govern account in-flight caps everywhere (fanout adds manual overrides and a % margin).

**Architecture:** A pure budget layer in `fanoutBudget.js` (manual > percent×detected > global) consumed by `auth.js`'s `limitFor`; an app-side scan subsystem under `src/lib/fork/capacity/` (classifier → probe → orchestrator/scheduler → admin route) that probes upstreams directly (never through the router's own inflight gate); dashboard UI = a multi-select diagnostic-model picker on the provider screen and percent + scan-now + summary in the combos-page fanout popover.

**Tech Stack:** Plain JS ESM (Node 24), Next.js App Router routes, vitest (`tests/`, baseline-gated), settings repo (no schema change).

**Spec:** `docs/superpowers/specs/2026-11-15-capacity-autodetect-design.md` (travels with this plan; rulings 2026-11-15/16 are inside).

## Global Constraints

- Tests run from `tests/` ONLY (`cd tests && npx vitest run unit/<file>`); the full gate is `npx vitest run --reporter=json --outputFile=__baseline__/current.json` then, from the fork root, `node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json` — judge by the verifier, never a raw pass count.
- Plain JavaScript ESM; `@/*` → `src/*`; commits are Conventional Commits; explicit paths only in `git add` (never `-A`).
- No schema/migration changes: everything persists through the settings repo (`getSettings()` / `updateSettings()` from `@/lib/localDb`).
- Probe requests must NOT acquire router inflight slots (`tryAcquireAccountSlot` is forbidden in scan code), must not create session pins, and must never run for a provider/connection without configured diagnostic models.
- v1 probe coverage: providers whose registry config has an OpenAI-format transport (default-executor family). Everything else is skipped with a surfaced reason.
- `docs/*` is gitignored by rule — new doc files need `git add -f` (repo precedent: existing specs/plans are force-added).

## Review Focus

(Each line is pinned by the test named in its owning task.)

1. A connection serving live traffic mid-scan must not be probed (mixed traffic reads low) — skip with reason, retry next scan. → Task 5 `skips a connection with inflight > 0`.
2. A crash mid-scan must not wedge the scheduler: `running: true` older than 30 min is treated as dead and a due scan proceeds. → Task 5 `treats stale running state as dead`.
3. A misconfigured diagnostic model (e.g. z.ai 1211 unknown model) must surface as a per-provider config error in scan results, not a silent unknown. → Task 3 `classifies unknown-model as config` + Task 5 `records config errors in lastResult`.
4. `percent` outside 1–100 or non-integer (0, 150, "80", NaN) must parse as 100, never 0 or unroutable. → Task 1 `invalid percent parses as 100`.
5. A manual combo-entry budget must never be scaled by percent, and a detected budget for an untested model must never apply (→ global). → Task 1 `manual budget wins unscaled` + `untested model falls back to global` / Task 2 `base cap ignores other models`.

---

### Task 1: Budget helpers — percent + per-(connection, model) detected layer

**Files:**
- Modify: `src/sse/services/fanoutBudget.js`
- Test: `tests/unit/fanout-budget.test.js` (extend)

**Interfaces:**
- Consumes: existing `parseFanoutCtx`, `effectiveFanoutBudget` (signature below changes compatibly), `isFanoutEntry`, `fanoutCtxForEntry`.
- Produces:
  - `parseFanoutCtx(cfg)` → `{ budgets: Record<string, number>, percent: number } | null` (percent = integer 1–100 from `cfg.percent`, anything else → 100).
  - `fanoutCtxForEntry(entry)` → `{ enabled: true, budgets, percent } | null` (same shapes as today plus `percent`).
  - `detectedBudgetFor(detected, connectionId, model)` → `number | null` — `detected` is `settings.detectedBudgets` shaped `{ [connectionId]: { [model]: { budget: number } } }`; non-integer/`< 1` budgets read as null.
  - `effectiveBaseCap(detected, connectionId, model, globalLimit)` → `number` — `detectedBudgetFor(...) ?? globalLimit`.
  - `effectiveFanoutBudget(fanoutCtx, connectionId, globalLimit, detected = null, model = null)` → chain: manual `budgets[connectionId]` (integer ≥ 1, **unscaled**) → `floor(detected[conn][model] × percent / 100)`, min 1 → `globalLimit`. When `detected` or `model` is null the chain is manual → global (today's behavior, so existing 3-arg callers are unchanged).

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/fanout-budget.test.js`, new describe blocks):
  - `parseFanoutCtx percent`: `{enabled:true, budgets:{a:6}, percent:80}` → `{budgets:{a:6}, percent:80}`; `percent: 0`, `percent: 150`, `percent: "80"`, `percent: NaN`, absent → `percent: 100` in every case; `budgets` still sanitized as today.
  - `fanoutCtxForEntry percent`: entry `{fallbackStrategy:"fanout", fanout:{enabled:true, percent:80}}` → `{enabled:true, budgets:{}, percent:80}`; entry without fanout object → `{enabled:true, budgets:{}, percent:100}`; fusion entry → null.
  - `detectedBudgetFor`: `{c1:{m1:{budget:16}}}` → (`c1`,`m1`) = 16; (`c1`,`m2`) = null; (`c2`,*) = null; `budget: 0` / `"3"` / missing → null; `detected` null/undefined → null.
  - `effectiveBaseCap`: detected pair present → 16; untested model → globalLimit (e.g. 4); null detected → globalLimit.
  - `effectiveFanoutBudget chain`: with ctx `{budgets:{c1:2}, percent:80}`, detected `{c1:{m:{budget:5}}}`, model `m`, global 4 → **2** (manual wins unscaled); manual absent, detected 5, percent 80 → **4** (floor(5×0.8)=4); manual absent, detected 3, percent 80 → **2** (floor(2.4), min 1); detected pair for a different model only → **4** (global); percent 100, detected 9 → 9; no detected, no manual → global.
- [ ] **Step 2: Run** `cd tests && npx vitest run unit/fanout-budget.test.js` — Expected: FAIL (percent undefined / detectedBudgetFor not exported).
- [ ] **Step 3: Implement** the five changes in `fanoutBudget.js` per the signatures above; update the module docstring: budgets are per (connection, model) from the scan, manual entries stay per connection and unscaled, untested model → global.
- [ ] **Step 4: Run** the file — Expected: PASS; then run the other fanout suites `unit/chat-fanout-threading.test.js unit/auth-fanout-strategy.test.js` — Expected: PASS unchanged (they use 3-arg calls / ctx equality: `chat-fanout-threading` asserts `ctx.budgets` — update any assertion that compares the whole ctx object to include `percent: 100`).
- [ ] **Step 5: Commit** `git add src/sse/services/fanoutBudget.js tests/unit/fanout-budget.test.js tests/unit/chat-fanout-threading.test.js && git commit -m "feat(capacity): budget helpers gain percent + per-(connection, model) detected layer"`

### Task 2: auth.js wiring — detected cap governs every strategy

**Files:**
- Modify: `src/sse/services/auth.js` (the `limitFor` block, ~line 141, and the settings read near it)
- Test: `tests/unit/auth-detected-cap.test.js` (new); `tests/unit/auth-fanout-strategy.test.js` (extend if its mock shape needs `percent`)

**Interfaces:**
- Consumes: Task 1 helpers; `getSettings()` from `@/lib/localDb` (already imported); `model` param of `getProviderCredentials(provider, excludeConnectionIds, model, options)` (in scope at `limitFor`).
- Produces: `limitFor = (c) => effectiveFanoutBudget(fanoutCtx, c.id, inflightLimit, detectedBudgets, model)` — one line replacing today's 3-arg call; `detectedBudgets` read once per `getProviderCredentials` call from `getSettings().detectedBudgets` (the same `getSettings` the function already awaits — no extra repo surface).

- [ ] **Step 1: Write the failing test** `tests/unit/auth-detected-cap.test.js`, mocking `@/lib/localDb` exactly like `auth-fanout-strategy.test.js` does (copy its setup for `getProviderConnections`/`updateProviderConnection`), with `getSettings` returning `{ detectedBudgets: { "conn-1": { "glm-4.5-flash": { budget: 2 } } } }`:
  - non-fanout request for model `glm-4.5-flash` on a connection with 2 slots already in flight (`getInflightCount` mocked → 2): the connection is filtered as busy (`limitFor`=2) — assert `getProviderCredentials` returns null (no available account) and the module-logged busy path runs.
  - same but model `glm-5.3` (untested): NOT busy at inflight 2 — assert a connection is returned.
  - fanout ctx `{budgets:{}, percent:80}` + detected 5 → selection log/rank shows budget 4; with manual `{budgets:{"conn-1":2}}` → budget 2 regardless of percent.
  - settings without `detectedBudgets` → behavior identical to today (global 4).
  Follow the existing fanout test's recipe for driving `getProviderCredentials` (same `options` shape: `{ fanout: ... }`).
- [ ] **Step 2: Run** `cd tests && npx vitest run unit/auth-detected-cap.test.js` — Expected: FAIL (detectedBudgets never read).
- [ ] **Step 3: Implement**: in `getProviderCredentials`, after `inflightLimit` is computed, read `const detectedBudgets = (await getSettings()).detectedBudgets || null;` and change `limitFor` to the 5-arg call above. No other selection logic changes — `rankFanout` rows already take `limitFor(c)`.
- [ ] **Step 4: Run** `unit/auth-detected-cap.test.js unit/auth-fanout-strategy.test.js unit/auth-inflight-cap.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/sse/services/auth.js tests/unit/auth-detected-cap.test.js tests/unit/auth-fanout-strategy.test.js && git commit -m "feat(capacity): detected budgets govern the per-account cap for every strategy"`

### Task 3: Probe error classifier

**Files:**
- Create: `src/lib/fork/capacity/classifyError.js`
- Test: `tests/unit/capacity-classify-error.test.js` (new)

**Interfaces:**
- Produces: `classifyProbeError({ provider, status, bodyText })` → `"throttle" | "auth" | "balance" | "config" | "network"`. Order: (1) network-ish inputs (null/undefined status with fetch failure text: `timeout`, `ECONN`, `ENOTFOUND`, `abort`) → `network`; (2) per-provider code map (substring match on bodyText): z.ai/`glm`/`glm-cn` — `1305` → throttle, `1113` → balance, `1211` → config, `1002`/`1003`/401/403 → auth; (3) generic: status 429 or body matches `rate limit|too many requests|overloaded|resource exhausted` (case-insensitive) → throttle; status 401/403 → auth; status 404 with body matching `model` → config; anything else → **throttle** (conservative: reads low, never over-runs).

- [ ] **Step 1: Write the failing tests**: z.ai seeds `{provider:"glm", status:429, bodyText:'{"error":{"code":"1305","message":"The service may be temporarily overloaded"}}'}` → throttle; `1113 Insufficient balance` → balance; `1211` (any status) → config; `{provider:"glm", status:401, bodyText:"token expired"}` → auth; status 429 generic → throttle; status 503 no match → throttle; status 500 no match → throttle; `null` status + `AbortError` body → network; `ECONNREFUSED` → network; unknown provider + unmatched 400 → throttle.
- [ ] **Step 2: Run** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per the order above; export the provider-code map as `PROVIDER_THROTTLE_CODES` so the scan UI/docs can enumerate coverage.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/fork/capacity/classifyError.js tests/unit/capacity-classify-error.test.js && git commit -m "feat(capacity): probe error classifier with per-provider throttle codes"`

### Task 4: Probe engine — ramp + injected dispatch

**Files:**
- Create: `src/lib/fork/capacity/probe.js`
- Test: `tests/unit/capacity-probe.test.js` (new)

**Interfaces:**
- Consumes: Task 3 `classifyProbeError`.
- Produces:
  - `rampLevels(maxLevel = 32)` → `[1, 2, 4, 8, 16, 32]` truncated at maxLevel.
  - `probeConnectionModel({ provider, connection, model, maxLevel = 32, probeTimeoutMs = 15000, dispatch })` → `{ status: "ok", budget: number } | { status: "unknown" | "unreachable" | "auth" | "config", reason: string }`. Algorithm: for each level fire `dispatch({ provider, connection, model })` that many times via `Promise.allSettled`; level passes iff every result is ok; first failing level ends the ramp; two binary-search steps between last-pass and first-fail; budget = last all-success level. Level 1 failing → classify (throttle/balance/config → that status with the classified reason; auth → status `"auth"`; network → `"unreachable"`).
  - `makeDefaultDispatch({ fetchImpl = fetch, dispatcher = null })` → the real `dispatch`: resolves the provider entry from `open-sse/providers/registry/index.js` (default export is the provider array; find by id), picks its transport with `format === "openai"`, uses `connection.providerSpecificData.baseUrl || transport.baseUrl` as the URL, `Authorization: Bearer <connection data apiKey or accessToken>` (api-key family), body `{ model, messages: [{ role: "user", content: "hi" }], max_tokens: 8, stream: false }`, `AbortSignal.timeout(probeTimeoutMs)`, `dispatcher` passed through to fetch when set (undici ProxyAgent hook; the v1 orchestrator passes none and skips proxied connections instead — see Task 5); returns `{ ok: true }` when HTTP 200 and the parsed body has `choices`, else `{ ok: false, status, bodyText }`. Providers with no OpenAI transport → dispatch returns `{ ok: false, unsupported: true }` and `probeConnectionModel` maps that to `{ status: "unsupported", reason: "provider type not supported for probing" }`.

- [ ] **Step 1: Write the failing tests** with a counting fake dispatch — e.g. `fake` that records concurrent in-flight count and returns `{ ok: true }` if concurrent ≤ N else `{ ok: false, status: 429, bodyText: "rate limit" }`:
  - true limit 5: ramp reaches level 8 (fails), binary steps confirm 5 → `{status:"ok", budget:5}`; assert the dispatch was never called with concurrent > 8 (ramp respects maxLevel).
  - limit 1: first level fails → classified.
  - dispatch always network-errors (`{ok:false, status:null, bodyText:"AbortError"}`) → `{status:"unreachable"}`.
  - dispatch `{ok:false, unsupported:true}` → `{status:"unsupported", reason:"provider type not supported for probing"}`.
  - limit 40 > maxLevel 32: result budget 32 (cap respected).
  - dispatch ok but body without `choices` counts as failure (fake returns `{ok:false, status:200, bodyText:'{"error":"no choices"}'}` at levels > 2) → budget 2.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `probeConnectionModel` (pure, `dispatch` injected) and `makeDefaultDispatch` (thin, registry lookup + fetch; no slot acquisition, no session pin).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/fork/capacity/probe.js tests/unit/capacity-probe.test.js && git commit -m "feat(capacity): concurrency probe engine with ramp + binary refine"`

### Task 5: Scan orchestrator + scheduler

**Files:**
- Create: `src/lib/fork/capacity/scan.js`
- Test: `tests/unit/capacity-scan.test.js` (new)

**Interfaces:**
- Consumes: Task 4 probe, `getProviderConnections(filter)` from `@/lib/localDb` (`{}` = all), `getInflightCount` from `@/sse/services/accountInflight.js`, `getSettings`/`updateSettings`, `checkAndRefreshToken(provider, connection)` from `@/sse/services/tokenRefresh.js` (the exact function the live chat path runs — spec's credential-prep step).
- Produces (all exported):
  - `resolveDiagnosticModels(connection, diagnosticModels)` → `string[] | []` — key `connection.id` first, then `connection.provider` (covers compatible nodes vs registry providers); values are arrays; dedupe, keep order.
  - `isDue(state, now, staleRunningMs = 30 * 60 * 1000)` → boolean — due when `enabled` and `now ≥ (nextRunAt || 0)` and (`!running` or `now - Date.parse(runningSince) > staleRunningMs`) — the stale-running rule is Review Focus item 2.
  - `runCapacityScan({ getSettings, updateSettings, getProviderConnections, getInflightCount, checkAndRefreshToken, probeFn, now = () => new Date(), parallelism = 4 })` → `{ scanned, detected, skipped, unknown, probeRequests, perProvider: [{ provider, reason, count }] }`:
    1. Set `capacityScan.running = true, runningSince` (only if not already running — re-entry returns the last result unchanged with `alreadyRunning: true`).
    2. Active connections only (`isActive === true` or `isactive === "1"` — read both, the mirror stores text).
    3. Skip reasons recorded per connection: `no diagnostic models` / `unsupported provider` (probe returns unsupported) / `busy (inflight > 0)` / `proxied (not probed in v1)` (connection with `providerSpecificData.connectionProxyEnabled === true` — honest surfaced limitation, not a silent miss).
    4. Per connection: `await checkAndRefreshToken(provider, connection)` first — refresh failure marks the whole connection `unknown (auth)` and skips its models (spec's credential-prep step).
    5. Probe each (connection × model) with `parallelism` workers; on `ok` write `detectedBudgets[connId][model] = { budget, detectedAt: ISO }` and tally every dispatch into `probeRequests`; on unknown/unreachable/auth/config **keep the previous value** and tally into `unknown` (config reasons also land in `perProvider` for the coverage surface).
    6. Persist: `detectedBudgets` (merged), `capacityScan = { ...state, running: false, lastRunAt, lastResult: { ...tallies, probeRequests }, nextRunAt: now + intervalHours×3600×1000 (intervalHours default 24) }` — one `updateSettings` call.
  - `ensureCapacityScheduler({ getSettings, updateSettings, ...scanDeps })` → starts ONE `setInterval` (15 min, `unref()`d) that calls `isDue` then `runCapacityScan`; idempotent across calls (module-level handle); the scheduler itself does not run at boot — the first tick staggers via `nextRunAt = now + random(0..6h)` when `nextRunAt` is unset.
  - **Recorded call (deviates from the spec's wording):** probe traffic is audited via `probeRequests` in `lastResult` instead of fake usage-repo rows — direct-to-upstream probes bypass the router's usage path, and injecting synthetic usage rows would pollute per-model usage stats. Flagged to Steve at handoff.
- [ ] **Step 1: Write the failing tests** (fake `probeFn` + in-memory settings map):
  - `resolveDiagnosticModels`: connection-id key wins over provider key; empty array → `[]`.
  - `isDue`: enabled+past nextRunAt+not running → true; running with `runningSince` 5 min ago → false; running since 31 min ago → true (stale-dead rule); disabled → false.
  - scan merges budgets, keeps previous value on unknown, tallies skipped reasons (incl. the proxied skip), counts `probeRequests`, sets `nextRunAt`, clears `running`.
  - re-entrant call while running → `{ alreadyRunning: true }`, no probes fired.
  - idle guard: `getInflightCount` > 0 → skipped with `busy` reason, no probe call.
  - `checkAndRefreshToken` rejects → connection recorded `unknown (auth)`, its models not probed.
  - a failing `updateSettings` mid-scan leaves `running` true (documented: the stale rule clears it next tick).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the shapes above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/fork/capacity/scan.js tests/unit/capacity-scan.test.js && git commit -m "feat(capacity): system-wide scan orchestrator with scheduler + stale-running recovery"`

### Task 6: Admin API — /api/fork/capacity-scan (+ combo summary)

**Files:**
- Create: `src/app/api/fork/capacity-scan/route.js`
- Modify: the boot call site where `setRuntimeLimits` is restored at server start (discover with `grep -rn "setRuntimeLimits" src/ --include="*.js" | grep -v "route.js\|accountInflight"` — add `ensureCapacityScheduler()` beside it, inside try/catch so a scan failure never blocks boot)
- Test: `tests/unit/capacity-scan-api.test.js` (new)

**Interfaces:**
- Consumes: Task 5; `assertForkAdmin` from `@/lib/forkAdminAuth` (pattern: `src/app/api/fork/limits/route.js`); Task 1 helpers for the summary.
- Produces:
  - `GET /api/fork/capacity-scan` → `{ running, enabled, intervalHours, lastRunAt, nextRunAt, lastResult, coverage: { providersConfigured, connectionsConfigured }, summary?: { combo, sum, members } }`; with `?combo=<name>` the summary is Σ over the combo's leaf members: parse each member `provider/model` (skip members that are themselves combos — note in the response as `nested: n`), for each active connection of that provider `Σ effectiveFanoutBudget(fanoutCtxForEntry(entry), c.id, accountInflightLimit(), detectedBudgets, model)`. Auth 401 otherwise.
  - `POST /api/fork/capacity-scan` → triggers `runCapacityScan` (fire-and-forget the scan body, respond `{ started: true }` immediately; if already running → `{ started: false, running: true }` with 409).
  - Boot wiring per the Files block.
- [ ] **Step 1: Write the failing route tests** following `tests/unit/fork-limits-api.test.js`'s setup (mock `@/lib/localDb` + `@/lib/forkAdminAuth`): 401 unauthenticated; GET returns state shape; `?combo=` with a settings fixture (combos + comboStrategies + detectedBudgets) returns the exact Σ (hand-computed: e.g. member glm/glm-4.5-flash × connection detected 5, percent 80 → 4; second member untested → global 4 → sum 8, members 2); POST starts and GET then shows `running` (fake slow probeFn injected via module mock); POST while running → 409.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the route + boot wiring.
- [ ] **Step 4: Run** `unit/capacity-scan-api.test.js unit/fork-limits-api.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/app/api/fork/capacity-scan/route.js <boot-file-from-grep> tests/unit/capacity-scan-api.test.js` (explicit boot file path) — commit message `feat(capacity): fork admin capacity-scan API with combo capacity summary + boot scheduler`

### Task 7: Providers UI — diagnostic model multi-select

**Files:**
- Create: `src/app/(dashboard)/dashboard/providers/[id]/DiagnosticModelsPicker.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (render the picker for the provider; for compatible-node providers render it per connection via `ConnectionRow.js` — read the row's props first and pass `diagnosticModels` + `onSave` down)
- Test: none (fork convention: dashboard UI is build+lint gated; pure logic was extracted in Tasks 1/5)

**Interfaces:**
- Consumes: `GET /api/settings` / `PATCH /api/settings` (existing dashboard endpoints, pattern: AutoPing save at `providers/[id]/page.js:459-467` — same fetch + settings key shape); provider catalog models from the page's existing provider data.
- Produces: settings key `diagnosticModels` writes `{ [providerId | connectionId]: ["model-a", "model-b"] }` — written whole-map (read-modify-write like AutoPing does) to avoid clobbering other providers' entries; **when the map transitions empty → non-empty, the same write also sets `capacityScan.enabled: true`** (the spec's default-on rule — a scan without any diagnostic model is a no-op anyway).

- [ ] **Step 1: Implement `DiagnosticModelsPicker`**: props `{ providerId, connectionId (optional), models: [{id, name}], value: string[], onSave(next: string[]) }`; render label "Model chuẩn đoán" + a multi-select checkbox list of catalog models (cheap models first is NOT auto-sorted — preserve catalog order) + a "Bỏ quét" empty state text when value is empty; save button calls `onSave`.
- [ ] **Step 2: Wire into the provider page**: fetch `diagnosticModels` from the settings data the page already loads; for registry providers render one picker under the AutoPing section; for compatible-node providers render per connection row; `onSave` read-modify-writes `settings.diagnosticModels` with the right key (connectionId when per-connection).
- [ ] **Step 3: Verify**: `cd /home/admin/code/sample-projects/9router-fork && npm run build` — Expected: build succeeds; `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/" ` — no NEW problems beyond baseline (note count before/after).
- [ ] **Step 4: Commit** `git add "src/app/(dashboard)/dashboard/providers/[id]/DiagnosticModelsPicker.js" "src/app/(dashboard)/dashboard/providers/[id]/page.js" "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js" && git commit -m "feat(capacity): diagnostic-model multi-select on provider screen"`

### Task 8: Combos UI — percent + Quét ngay + capacity summary

**Files:**
- Modify: `src/app/(dashboard)/dashboard/combos/page.js` (the strategy popover where `STRATEGY_OPTIONS` renders, fanout option branch)
- Modify: `src/app/(dashboard)/dashboard/combos/strategy-config.js` — only if the merge needs a percent-aware touch (it should NOT: `patch.fanout = { percent }` merges into the stored fanout object by spread — verify with the existing tests, add one test)
- Test: `tests/unit/combos-strategy-config.test.js` (extend by one test)

**Interfaces:**
- Consumes: Task 1 chain (percent parsed from the raw entry); Task 6 `GET/POST /api/fork/capacity-scan` (dashboard session is an admin session — same auth as the rest of the dashboard).
- Produces: the card saves `comboStrategies[name].fanout.percent` through the existing combo save flow (read-modify-write of `comboStrategies`, same as today's strategy save); NO account list is rendered (ruling 2026-11-15 stands).

- [ ] **Step 1: Write the failing test** in `combos-strategy-config.test.js`: `mergeStrategyPatch({ fallbackStrategy: "fanout", fanout: { enabled: true, budgets: { a: 6 } } }, { fanout: { percent: 80 } })` → `{ fallbackStrategy: "fanout", fanout: { enabled: true, budgets: { a: 6 }, percent: 80 } }` (spread-merge keeps budgets; percent rides the fanout key; switching strategy away still prunes — existing tests already pin that).
- [ ] **Step 2: Run** — Expected: FAIL (merge is replace-not-spread today: `mergeStrategyPatch` spreads top-level patch keys only, so `patch.fanout` REPLACES the stored fanout object). Implement: in `mergeStrategyPatch`, when both `next.fanout` and `currentEntry?.fanout` are objects, merge `{ ...currentEntry.fanout, ...patch.fanout }` (with `patch.fanout === null` still deleting).
- [ ] **Step 3: Run** `unit/combos-strategy-config.test.js` — Expected: all PASS (the 9 existing merge tests + the new one).
- [ ] **Step 4: Implement the popover UI**: in the fanout branch of the strategy popover add (a) number input "Margin %" (placeholder 100, 1–100, writes `fanout.percent` through the same debounced save path the card uses for strategies — reuse `mergeStrategyPatch`), (b) button "Quét ngay" → `POST /api/fork/capacity-scan`, then poll `GET /api/fork/capacity-scan?combo=<name>` every 5 s while `running` is true and once after it flips false, (c) one summary line rendering the GET's `summary`: `Dung lượng ~<sum> · quét <lastRunAt HH:mm>` (or `chưa có dữ liệu quét` when `lastResult` is null). No account rows.
- [ ] **Step 5: Verify**: `npm run build` succeeds; eslint on `combos/page.js` shows only the pre-existing baseline problems (5, positions may shift).
- [ ] **Step 6: Commit** `git add "src/app/(dashboard)/dashboard/combos/page.js" "src/app/(dashboard)/dashboard/combos/strategy-config.js" tests/unit/combos-strategy-config.test.js && git commit -m "feat(capacity): fanout popover gains margin %, scan-now button and capacity summary"`

### Task 9: Docs + full regression gate

**Files:**
- Modify: `docs/wavebot-patches.md` (add patch #20 row)
- Test: full suite gate

**Interfaces:** none new.

- [ ] **Step 1: Add patch #20 row** to `docs/wavebot-patches.md`: files `src/sse/services/fanoutBudget.js`, `src/sse/services/auth.js`, `src/lib/fork/capacity/*`, `src/app/api/fork/capacity-scan/route.js`, providers + combos UI; why: per (connection, model) concurrency budgets measured by a daily system-wide probe with operator-chosen cheap diagnostic models; base cap everywhere = detected ?? global (ruling 2026-11-15); fanout chain manual > percent×detected > global; untested model → global (ruling 2026-11-16); the probe bypasses the router's inflight gate; runtime settings `detectedBudgets`, `diagnosticModels`, `capacityScan`.
- [ ] **Step 2: Full gate**: `cd tests && npx vitest run --reporter=json --outputFile=__baseline__/current.json`, then from the fork root `node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json` — Expected: no regressions vs baseline (known flaky full-run tests: `fork-admin-auth :: assertForkAdmin accepts the admin bearer`, `fork-limits-api :: limits GET returns env default when no setting`, `tinyfish-web-provider :: applies offset within fixed-size result pages` — rerun those in isolation before reporting a failure).
- [ ] **Step 3: `npm run build`** — Expected: succeeds.
- [ ] **Step 4: Commit** `git add -f docs/wavebot-patches.md && git commit -m "docs(capacity): patch #20 — capacity auto-detect"`

## Live verification (after Task 9, dev router — recorded, not committed)

1. Restart `wavebot-llm-router-1` (loads new code + settings).
2. `PATCH /api/settings` `diagnosticModels = { glm: ["glm-4.5-flash"] }`; `POST /api/fork/capacity-scan`; poll GET until `running` false — expect glm connection budget detected (global cap is 4; the probe must discover above it, e.g. 8+ if the key allows).
3. Burst 12 real requests at the `wavebot` combo — router log shows the detected budget in `fanout → <id> (inflight n/<detected>)` lines.
4. Set `percent: 80` on the combo entry via the card; re-burst — effective budget = floor(detected×0.8).
5. Confirm no router inflight-slot interference: `GET /api/fork/load` during the scan shows the probed connection's inflight unchanged by probe traffic.
