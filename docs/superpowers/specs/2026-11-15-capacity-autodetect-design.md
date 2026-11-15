# Per-connection, per-model concurrency auto-detect (fanout budgets) — design

Date: 2026-11-15 (model dimension added 2026-11-16) · Owner: Steve (decisions) · Author: session notes
Repo: `9router-fork` (branch `wavebot/ai-concurrency-v2`)

## Intent

Fanout combos give each connection its own in-flight budget, but today those
budgets are manual-only settings values, and a real upstream limit differs
**per key** (same provider type, e.g. ZAI GLM Coding — different subscription
tiers → different limits) **and per model** (response time / upstream per-
model allocations decide throughput: glm-5.3-flash consistently out-runs
glm-5.3 on the same key). This feature measures each connection's max
concurrency **for each of several operator-chosen diagnostic models** on a
**daily system-wide scan** (one shared scan, not per combo), and lets the
operator apply a **% margin** and trigger a scan manually from the combo
popup. Providers/connections without configured diagnostic models are
**skipped** — the scan must never burn an expensive model.

## Goals

- Per **(connection, model)** detected budget — a measured matrix, not one
  number per connection — persisted system-wide, refreshed by a daily scan
  shared by all combos.
- Multi-model diagnostic picker on the provider detail screen (several cheap
  models per provider/connection; every model actually routed should be in
  the list).
- Combo popup (fanout strategy): "Quét ngay" (scan-now) button that triggers
  the shared scan; a **% of concurrency** setting (e.g. 80% → an account whose
  detected concurrency is 5 runs at max 4); a one-line capacity summary
  computed over the combo's members' effective budgets for their own models.
- **Detected budget governs every strategy** (ruling 2026-11-15): the base
  per-account cap for a leg becomes `detected[conn][model] ?? global`;
  combo-entry manual budgets (fanout only) and the fanout % sit on top.
- **Untested model → global limit** (ruling 2026-11-16): a (connection,
  model) pair the scan never measured falls back to the global limit — no
  min-aggregate, no representative-model guessing; the operator adds the
  models they route to the diagnostic list.
- Probe requests bypass the router's own inflight gate (otherwise detection
  could never discover a limit above the global cap) and never acquire router
  slots.

## Goals

- Per-connection detected budget, persisted system-wide, refreshed by a daily
  scan shared by all combos.
- Per-provider diagnostic model picker on the provider detail screen.
- Combo popup (fanout strategy): "Quét ngay" (scan-now) button that triggers
  the shared scan; a **% of concurrency** setting (e.g. 80% → an account whose
  detected concurrency is 5 runs at max 4); a one-line capacity summary.
- **Detected budget governs every strategy** (ruling 2026-11-15): the base
  per-account cap becomes `detected ?? global`; combo-entry manual budgets
  (fanout only) and the fanout % sit on top.
- Probe requests bypass the router's own inflight gate (otherwise detection
  could never discover a limit above the global cap) and never acquire router
  slots.

## Non-goals

- No continuous AIMD during live traffic — the scheduled/manual scan is the
  only detection loop.
- No per-model **manual** budgets (a manual combo-entry budget stays one
  number per connection and overrides every model on it); per-model numbers
  come only from the scan.
- No auto-editing of manual combo-entry budgets; the scan never overwrites a
  manual entry.
- No account list rendered on the combo card (ruling 2026-11-15 stands).

## Anti-goals

- Probing with a paid model when the provider has no diagnostic model
  configured — the connection is skipped instead.
- A scan deadlocking or starving live traffic — probes acquire no router
  inflight slots, hold no session pins, and skip connections currently serving
  live traffic.

## Approaches considered

1. **Probe through the router's chat dispatch** (`handleSingleModelChat`) —
   rejected: `getProviderCredentials` acquires an inflight slot capped at the
   global limit, so the probe could never measure above the cap, and probe
   traffic would contend with real requests.
2. **Direct executor invocation with the connection's own credentials**
   (chosen) — `getExecutor(provider)` already exposes per-provider executors;
   the probe builds a minimal completion call (tiny prompt, `max_tokens ≤ 8`,
   non-stream) using the connection's stored credential and the provider's
   normal baseUrl, bypassing auth.js selection, slot accounting and session
   pinning entirely.
3. **Passive detection from live-traffic errors** — rejected as the mechanism
   (too slow, too noisy, conflates rate vs concurrency); not built in this
   iteration.

## Probe method

**v1 provider coverage (builder-check call):** only providers whose executor
accepts an OpenAI-format non-stream completion through the default/compatible
path — the api-key family (glm, glm-cn, zai, openai-compatible-*, anthropic-
compatible-*). Bespoke-transport providers (kiro EventStream, cursor protobuf,
the `*-web` session executors) are **out of probe scope in v1**: the scan
skips them and surfaces "provider type not supported for probing" in scan
results and the coverage endpoint, rather than guessing. (Steve's fleet today
is glm + compatible nodes — all covered.)

Per connection:

1. Read the provider's diagnostic models — `settings.diagnosticModels` maps
   to an **array of model ids** (multi-select), keyed by **provider id** for
   registry providers, and by **connection id** for compatible-* connections
   (each carries its own baseUrl and model namespace, so a per-provider value
   would mis-probe them; the picker for a compatible connection lives on its
   connection row). Resolution: connection-id key > provider key. Empty or
   missing → skip the connection.
2. Skip if the connection is currently serving live traffic
   (`accountInflight` inflight > 0) — mixed traffic would read low. The
   connection is retried on the next scan.
3. Credential prep mirrors the live path exactly: the probe calls the
   app-side `checkAndRefreshToken(provider, credentials)` (the same function
   `chat.js` runs before dispatch) before probing, so an expired OAuth token
   is refreshed once, per connection, inside its own scan step — no
   parallel refresh stampede. Refresh failure → **unknown (auth)**, skip.
4. For **each** configured diagnostic model, ramp concurrency levels
   `1, 2, 4, 8, 16, 32` (level cap configurable via
   `settings.capacityScan.maxLevel`, default 32). At each level fire that many
   identical probe requests simultaneously; the level **passes** when every
   request returns a complete (HTTP 200, non-stream) response within
   `probeTimeoutMs` (default 15s). First failing level ends the ramp; two
   binary-search steps refine between last-pass and first-fail (final
   precision ≈ ×1.25). A model erroring before the ramp completes does not
   abort the other models of the same connection.
5. Per model, budget = last all-success level. Level 1 failing → classify
   the error:
   - throttle-class (HTTP 429 / provider throttle codes) → level 1 failing
     means the key is throttled or misconfigured right now → record
     **unknown** with the classified reason;
   - auth/balance-class (401/403, z.ai 1113 insufficient balance) →
     **unknown (auth/balance)**;
   - network/timeout → **unreachable** this round.
   Unknown/unreachable (connection × model) entries keep their previous
   detected value (if any) and are retried next scan; an auth/balance failure
   marks the whole connection unknown for this round (no point probing its
   other models).
6. Persist per connection: `{ [model]: { budget, detectedAt } }`.

Classifier: one module, generic HTTP patterns first (status 429, "rate limit",
"too many requests"), plus a per-provider override map seeded with known codes
(z.ai: 1305 overloaded = throttle; 1113 = balance; 401 = auth; 1211 unknown
model = diagnostic model misconfigured → surfaces as a provider-config error
in scan results). Unclassified errors count as throttle (conservative: reads
low, never over-runs the upstream).

Cost per (connection × model) ≈ 2·log₂(limit) + 4 requests (~10–20 typical;
a connection with 3 diagnostic models ≈ 30–60). Connection scans run with
parallelism 4 (setting `capacityScan.parallelism`), per-connection hard abort
at ~90s per model ramp.

**Scan universe (Steve's ruling: one scan shared system-wide):** every
**active** (`isactive=1`) providerconnection whose provider/connection has a
diagnostic model configured — regardless of whether any combo currently uses
it. Inactive connections are never probed. With parallelism 4 and a ~90s
per-connection abort this bounds a 1k-connection fleet to roughly a 1–2 h
background run; the scheduler treats the scan as a background job, and a
scan still in progress when `nextRunAt` passes is skipped until it finishes
(next run starts right after).

## Storage (settings repo only — no goose migration)

```jsonc
settings.detectedBudgets  = { "<connectionId>": { "<model>": { budget, detectedAt } } }
settings.diagnosticModels = { "<providerOrConnectionId>": ["model-a", "model-b"] }
settings.capacityScan     = { enabled, intervalHours (default 24), lastRunAt,
                              nextRunAt, running,
                              lastResult: { scanned, detected, skipped, unknown, at } }
settings.comboStrategies[name].fanout.percent = 1..100 (default 100)
```

## Resolution chain

**Ruling 2026-11-15: the detected budget governs EVERY strategy, not only
fanout** — a key's real limit does not depend on which combo uses it.
**Ruling 2026-11-16: budgets are per (connection, model)**; a pair the scan
never measured falls back to the global limit. The base per-account cap in
`auth.js`'s shared `limitFor` becomes `detected[conn][model] ?? global`; the
fanout chain layers combo-local settings on top:

```
base cap (every strategy):  detected[conn][model]  ??  global limit
fanout per-account budget:  manual combo entry budgets[conn] (exact, unscaled)
                              ?? floor(detected[conn][model] × percent/100), min 1
                              ?? global limit
```

`percent` comes from the raw combo entry (absent/invalid → 100) and is a
fanout-combo setting only — non-fanout strategies use the raw detected value.
Both lookup keys are known at selection time: auth.js selects accounts for a
specific member model, so `model` is in scope everywhere the cap is read.
The detected map is read from the settings repo at selection time (cheap,
in-memory mirror). Both layers are pure, unit-tested helpers in
`fanoutBudget.js` (`effectiveFanoutBudget` gains the model key; the new base
hook is a second helper).

## Scheduler

In-process timer (precedent: oauth refresh intervals) checks every 15 min:
scan runs when `enabled` and `now ≥ nextRunAt` and not `running`. First run
after boot is staggered (random 0–6 h) to avoid boot storms. After a scan
completes, `nextRunAt = now + intervalHours`. Manual trigger (admin API or
combo popup) runs immediately unless a scan is already running; it also resets
`nextRunAt`. A scan mutex makes concurrent triggers no-ops.

## API + UI surface

- `GET /api/fork/capacity-scan` → status, lastResult, per-provider config
  coverage. `POST /api/fork/capacity-scan` → trigger. Auth = fork admin
  (bearer `WAVEBOT_FORK_ADMIN_TOKEN` or admin session), same as limits/load
  (patch 18); `/api/fork/*` already public-listed with self-auth.
- **Provider detail screen**: "Model chuẩn đoán" **multi-select** per
  provider (per connection row for compatible-* providers) — pick several
  catalog models to probe (+ empty = skip scan), saved to
  `settings.diagnosticModels`. Placement alongside the existing AutoPing
  schedule UI on the same page.
- **Combo popup (fanout)**: `%` input (placeholder 100), "Quét ngay" button
  with running state, and a one-line summary ("Dung lượng ~N · quét 12:00")
  where N = Σ effective budgets over the combo's members, each at its own
  (connection, model) pair. No account rows (ruling 2026-11-15). The %
  scales only detected budgets; manual entries stay exact.

## Constraints

- Plain JS ESM, vitest under `tests/`, gate = baseline verifier; settings
  repo only (no schema change, no goose migration).
- Probe usage is recorded through the normal usage path (honest, auditable;
  volume is small).
- Executor invocation must reuse the provider's stored credential exactly as
  production does (including refresh for OAuth-type connections where the
  executor handles it); a connection whose credential cannot be loaded is
  skipped with "unreachable".

## What's left to the builder

- Exact classifier patterns beyond the seeds; ramp timeout tuning; precise
  placement of the picker row and popup controls (visual conventions follow
  the existing pages); endpoint naming polish; whether `capacityScan.enabled`
  defaults on or off on upgrade (proposal: **off** until the operator sets at
  least one diagnostic model, then on — the scan without any diagnostic model
  configured is a no-op anyway).
