# Live quota collapse + Concurrency tab + llm-db Timescale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A quota error during live traffic squeezes that (connection, model) budget to 0 immediately and schedules an automatic re-check at the upstream's reset time; a new Usage tab charts concurrency over time from a 30s sampler stored in TimescaleDB; the router database moves to its own `llm-db` Timescale container (WaveBot's db untouched).

**Architecture:** Part 1 hooks one persistent collapse call inside `markAccountUnavailable` (every failure path funnels through it) writing `detectedBudgets` + a settings-persisted re-check queue ticked by a 60s scheduler that probes with one tiny real request. Part 2 records `(ts, inflight, totalBudget)` samples every 30s into `concurrencySamples` (registered in `schema.js` TABLES AND goose migration 002 — the drift test enforces the pair), aggregated by a new repo function served through a new API route to a new client tab. Part 3 adds a dedicated Timescale container in the wavebot repo and retargets the router's DB URL, `make llm-db` and the migrate llm half at it.

**Tech Stack:** Next.js App Router plain-JS ESM (fork), vitest (tests/), goose SQL migrations, TimescaleDB (`timescale/timescaledb`, pg15), Docker Compose + Make (wavebot repo).

**Spec:** `docs/superpowers/specs/2026-11-16-live-quota-and-concurrency-tab-design.md` — read it first; every decision below (two-signal quota rule, window-cumulative lines, average bars, 30s/60d, guarded hypertable) is argued there.

## Global Constraints

- Regression gate before any "done": full `npx vitest run` from `tests/` **plus** `node tests/__baseline__/verify-no-regression.mjs` run from `tests/`. Known flaky files (fork-admin-auth, fork-limits-api, allowed-dev-origins, opencode-wreq-proxy-routing, proxy-keepalive-dead-socket) pass in isolation.
- Never `goose down|reset|redo`; an applied migration is frozen — 001_baseline.sql is never edited; this plan adds `002_concurrency_samples.sql` only.
- The DB password never appears on argv, in logs, or in an `echo` (stdin/env only).
- Explicit-path `git add` only — never `git add -A`. `docs/superpowers/**` is gitignored: `git add -f` for the plan/spec files.
- Commit messages containing backticks must go through `git commit -F <file>`.
- The drift test (`tests/unit/migrations-drift.test.js`) must pass after every task that touches schema: every TABLES table/column is created by db/migrations and nothing else, every mirrored column is `text` except whitelisted bigserial PKs, and migration indexes ⊆ schema.js indexes.
- A peer session (pricing/wallet) owns migration 003+ and SCHEMA_VERSION 4+ — this plan lands 002 + SCHEMA_VERSION 3 and must not touch `saveRequestUsage`, `chat.js`, `chatCore.js`, or `stream.js`.
- WaveBot's `db` container and its volumes are never touched by Part 3; `make clean` / `docker volume prune` / `DROP DATABASE` are forbidden.

## Review Focus

1. **Zero samples on a fresh install** — the tab must render empty buckets (concurrency 0, `utilityRate: null`), never NaN/Infinity. Pinned by `getConcurrencyChartData` empty-table test (Task 8).
2. **`totalBudget === 0` bucket** (no active connections) — `utilityRate` must be `null` (no line point), not `Infinity`. Pinned in Task 8.
3. **Re-check entry for a deleted connection** — the probe must drop the entry once, never error-loop every 60s. Pinned in Task 4.
4. **SQLite-only deployments** (no `LLM_ROUTER_DATABASE_URL`) — sampler + chart work end-to-end on the default adapter; the vitest suite itself runs that way, so Tasks 7–8 tests prove it implicitly — do not add PG-only assumptions.
5. **Scheduler double-boot** (Next.js hot reload calls `instrumentation.register` again) — both new schedulers follow `ensureCapacityScheduler`'s module-handle guard; second call returns the existing handle. Pinned in Tasks 4 and 7.

---

### Task 1: Quota hint export + reset-time parser

**Files:**
- Modify: `src/lib/fork/capacity/classifyError.js` (export a helper alongside `classifyProbeError`)
- Create: `src/sse/services/quotaCollapse.js` (parser only in this task)
- Test: `tests/unit/quota-collapse.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `matchesQuotaHints(bodyText) -> boolean` from `classifyError.js`; `parseResetsIn(errorText) -> number|null` (milliseconds until reset) from `quotaCollapse.js`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/quota-collapse.test.js
import { describe, expect, it } from "vitest";
import { matchesQuotaHints } from "../../src/lib/fork/capacity/classifyError.js";
import { parseResetsIn } from "../../src/sse/services/quotaCollapse.js";

describe("matchesQuotaHints", () => {
  it("matches the scan's quota dialects", () => {
    expect(matchesQuotaHints(`{"error":{"type":"GoUsageLimitError"}}`)).toBe(true);
    expect(matchesQuotaHints("usage limit reached (monthly)")).toBe(true);
  });
  it("does not match generic throttle or unrelated text", () => {
    expect(matchesQuotaHints("rate limit exceeded")).toBe(false);
    expect(matchesQuotaHints("")).toBe(false);
    expect(matchesQuotaHints(undefined)).toBe(false);
  });
});

describe("parseResetsIn", () => {
  it("parses days+hours and hours+minutes into milliseconds", () => {
    expect(parseResetsIn("You've hit your plan limit. Resets in 8d 4h")).toBe((8 * 24 + 4) * 3600000);
    expect(parseResetsIn("quota window resets in 5h 20m")).toBe((5 * 60 + 20) * 60000);
  });
  it("returns null without a resets-in phrase or with no numbers", () => {
    expect(parseResetsIn("GoUsageLimitError")).toBe(null);
    expect(parseResetsIn("resets in soon")).toBe(null);
    expect(parseResetsIn(undefined)).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: FAIL — `matchesQuotaHints` is not exported (import error), `parseResetsIn` module missing.

- [ ] **Step 3: Implement**

In `classifyError.js`: `export function matchesQuotaHints(bodyText) { return typeof bodyText === "string" && QUOTA_HINTS.test(bodyText); }` — reusing the private `QUOTA_HINTS` const, never copying it. Create `quotaCollapse.js` exporting `parseResetsIn`: require the text to match `/resets?\s+(?:in|at)\b/i`, then sum `/(\d+)\s*d(?:ay)?s?/i` ×24h, `/(\d+)\s*h(?:our)?s?/i` ×1h, `/(\d+)\s*m(?:in(?:ute)?)?s?/i` ×1min; return the sum or `null`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fork/capacity/classifyError.js src/sse/services/quotaCollapse.js tests/unit/quota-collapse.test.js
git commit -m "feat(capacity): export quota-hint matcher and add resets-in parser"
```

### Task 2: `handleLiveQuotaError` — collapse write + re-check enqueue

**Files:**
- Modify: `src/sse/services/quotaCollapse.js`
- Test: `tests/unit/quota-collapse.test.js` (new describe block)

**Interfaces:**
- Consumes: `matchesQuotaHints`, `parseResetsIn` (Task 1); `getSettings`/`updateSettings` from `@/lib/localDb`.
- Produces: `handleLiveQuotaError({ connectionId, provider, model, errorText, resetsAtMs }) -> Promise<boolean>` (true = collapsed). Settings shape it owns: `settings.detectedBudgets[connectionId][model] = { budget: 0, quota: true, previousBudget?, detectedAt, source: "live" }`; `settings.quotaRecheck: [{ connectionId, provider, model, at }]`.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/localDb` with a settings map, as `tests/unit/capacity-scan-api.test.js` does)

```js
// append to tests/unit/quota-collapse.test.js
import { vi, beforeEach } from "vitest";
const db = vi.hoisted(() => ({ settings: {} }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async (patch) => { db.settings = { ...db.settings, ...patch }; },
}));
// import AFTER the mock:
const { handleLiveQuotaError } = await import("../../src/sse/services/quotaCollapse.js");

describe("handleLiveQuotaError", () => {
  beforeEach(() => { db.settings = {}; });
  const DAY = 24 * 3600000;

  it("collapses a hint-matched error with a parseable reset within 24h, stashing previousBudget", async () => {
    db.settings = { detectedBudgets: { c1: { m1: { budget: 4 } } } };
    const collapsed = await handleLiveQuotaError({ connectionId: "c1", provider: "opencode-go", model: "m1", errorText: "GoUsageLimitError resets in 5h" });
    expect(collapsed).toBe(true);
    const entry = db.settings.detectedBudgets.c1.m1;
    expect(entry).toMatchObject({ budget: 0, quota: true, previousBudget: 4, source: "live" });
    expect(db.settings.quotaRecheck).toEqual([{ connectionId: "c1", provider: "opencode-go", model: "m1", at: expect.any(String) }]);
  });

  it("collapses on resetsAtMs alone (GLM 1308) and enqueues when the reset is within 24h", async () => {
    const at = Date.now() + 5 * 3600000;
    const collapsed = await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: at });
    expect(collapsed).toBe(true);
    expect(new Date(db.settings.quotaRecheck[0].at).getTime()).toBeGreaterThanOrEqual(at - 2000);
  });

  it("does not collapse a generic 500 and does not enqueue past-24h or unparseable resets", async () => {
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "internal error", resetsAtMs: null })).toBe(false);
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "GoUsageLimitError resets in 8d" })).toBe(true);
    expect(db.settings.quotaRecheck).toBeUndefined();
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "GoUsageLimitError" })).toBe(true);
    expect(db.settings.quotaRecheck).toBeUndefined();
  });

  it("writes keyless lanes under the provider id and dedupes the queue by connection+model", async () => {
    await handleLiveQuotaError({ connectionId: "opencode", provider: "opencode", model: "big-pickle", errorText: "GoUsageLimitError resets in 2h" });
    expect(db.settings.detectedBudgets.opencode["big-pickle"].budget).toBe(0);
    await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: Date.now() + 3600000 });
    await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: Date.now() + 7200000 });
    expect(db.settings.quotaRecheck).toHaveLength(2);
    expect(db.settings.quotaRecheck.filter((e) => e.connectionId === "c1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: FAIL — `handleLiveQuotaError` is not exported.

- [ ] **Step 3: Implement**

`handleLiveQuotaError`: return false unless `connectionId && model`; collapse iff `matchesQuotaHints(errorText) || (resetsAtMs > Date.now())`; preserve all other `detectedBudgets` entries and stash `previousBudget` from the existing entry's numeric budget (omit when absent); schedule into `quotaRecheck` when `resetsAt = resetsAtMs ?? parseResetsIn(errorText)` is a time within `24 * 3600000` of now — upsert (replace any existing entry for the same connectionId+model), omit the `quotaRecheck` key entirely when nothing is scheduled and none existed.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/sse/services/quotaCollapse.js tests/unit/quota-collapse.test.js
git commit -m "feat(quota): live collapse writes budget-0 and schedules a re-check"
```

### Task 3: Hook the collapse into `markAccountUnavailable`

**Files:**
- Modify: `src/sse/services/auth.js` (`markAccountUnavailable`, first lines)
- Test: `tests/unit/quota-collapse.test.js` (funnel describe block)

**Interfaces:**
- Consumes: `handleLiveQuotaError` (Task 2).
- Produces: every `markAccountUnavailable` call site (chat, embeddings, imageGeneration, stt, tts, search, fetch, videoGeneration, systemone, v1beta models) now collapses lanes — no per-site edits.

- [ ] **Step 1: Write the failing test**

```js
// append; quotaCollapse.js must already be imported via vi.mock above — auth.js reaches it through the same mock
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

describe("markAccountUnavailable funnels into the live collapse", () => {
  beforeEach(() => { db.settings = {}; });
  it("a quota error on a real connection collapses it; a plain 500 does not", async () => {
    db.settings = { providerConnections: [{ id: "c1", provider: "opencode-go", isActive: true, data: "{}" }] };
    await markAccountUnavailable("c1", 429, "GoUsageLimitError resets in 2h", "opencode-go", "m1");
    expect(db.settings.detectedBudgets.c1.m1.budget).toBe(0);
    db.settings = { providerConnections: db.settings.providerConnections };
    await markAccountUnavailable("c1", 500, "internal error", "opencode-go", "m1");
    expect(db.settings.detectedBudgets).toBeUndefined();
  });
  it("a keyless lane id still collapses under the provider key (before the early return)", async () => {
    await markAccountUnavailable("opencode", 429, "GoUsageLimitError resets in 2h", "opencode", "big-pickle");
    expect(db.settings.detectedBudgets.opencode["big-pickle"].budget).toBe(0);
  });
});
```

Note: `auth.js` imports several `@/lib/localDb` helpers — extend the file's `vi.mock("@/lib/localDb", ...)` factory with whatever else importing `auth.js` pulls (`getProviderConnections`, `updateProviderConnection`, …) so the module loads under the mock; the collapse assertions read `db.settings`.

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: FAIL — `detectedBudgets` never written (no hook yet).

- [ ] **Step 3: Implement**

In `markAccountUnavailable`, above the existing keyless early return, add a best-effort call: `try { await handleLiveQuotaError({ connectionId, provider, model, errorText, resetsAtMs }); } catch (e) { log.warn("AUTH", "quota collapse failed:", e?.message); }` — the collapse must never turn an error path into a crash. (Import at the top of auth.js.)

- [ ] **Step 4: Run to verify GREEN** — this file's own tests first

Run: `cd tests && npx vitest run unit/quota-collapse.test.js`
Expected: PASS.
Then: `cd tests && npx vitest run unit/auth-account-selection.test.js tests/unit/fanout-budget.test.js 2>/dev/null || npx vitest run unit/auth-account-selection.test.js`
Expected: existing auth tests still pass (the hook is fail-open; if an auth test asserts exact `detectedBudgets` absence after a 500, it should still pass — a 500 collapses nothing).

- [ ] **Step 5: Commit**

```bash
git add src/sse/services/auth.js tests/unit/quota-collapse.test.js
git commit -m "feat(quota): collapse lanes from markAccountUnavailable so every error path squeezes"
```

### Task 4: Re-check scheduler

**Files:**
- Create: `src/lib/fork/capacity/quotaRecheck.js`
- Modify: `src/instrumentation.js` (one guarded boot line beside `ensureCapacityScheduler`)
- Test: `tests/unit/quota-recheck.test.js`

**Interfaces:**
- Consumes: `probeConnectionModel({ provider, connection, model, maxLevel }) -> { status: "ok", budget, unbounded?, requests } | { status: "quota"|"throttle"|"auth"|"config"|"balance"|"unsupported"|"unreachable"|"unknown", reason?, requests }` from `@/lib/fork/capacity/probe.js`; `clearAccountError(connectionId, currentConnection, model)` from `@/sse/services/auth.js`; settings via `@/lib/localDb`.
- Produces: `processDueQuotaRecheck(deps) -> Promise<{ probed: number, restored: number, rescheduled: number, dropped: number }>`; `ensureQuotaRecheckScheduler(deps) -> { stop }`; `resetQuotaRecheckScheduler()` (test-only, same shape as `resetCapacityScheduler`). Deps all optional with real defaults: `{ now, probeFn, getSettingsFn, updateSettingsFn, clearAccountErrorFn, getConnectionsFn, maxPerTick = 5, horizonMs = 24 * 3600000 }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/quota-recheck.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ settings: {} }));
const probe = vi.hoisted(() => ({ results: [] }));
const cleared = vi.hoisted(() => ({ calls: [] }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async (patch) => { db.settings = { ...db.settings, ...patch }; },
  getProviderConnections: async () => db.settings.providerConnections || [],
}));
vi.mock("../../../src/lib/fork/capacity/probe.js", () => ({
  probeConnectionModel: async (input) => ({ ...probe.results.shift(), input }),
}));
vi.mock("../../../src/sse/services/auth.js", () => ({
  clearAccountError: async (...args) => { cleared.calls.push(args); },
}));

const { processDueQuotaRecheck, ensureQuotaRecheckScheduler, resetQuotaRecheckScheduler } =
  await import("../../../src/lib/fork/capacity/quotaRecheck.js");

const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const entry = (over = {}) => ({ connectionId: "c1", provider: "glm", model: "m1", at: new Date(NOW - 60000).toISOString(), ...over });
const run = (over = {}) => processDueQuotaRecheck({ now: NOW, probeFn: async () => probe.results.shift(), ...over });
const conn = () => [{ id: "c1", provider: "glm", isActive: true, data: "{}" }];

describe("processDueQuotaRecheck", () => {
  beforeEach(() => { db.settings = {}; probe.results = []; cleared.calls = []; });

  it("restores previousBudget, clears the account error and drops the entry on probe ok", async () => {
    db.settings = { quotaRecheck: [entry()], detectedBudgets: { c1: { m1: { budget: 0, quota: true, previousBudget: 4 } } }, providerConnections: conn() };
    probe.results = [{ status: "ok", budget: 1, requests: 1 }];
    const out = await run();
    expect(out).toEqual({ probed: 1, restored: 1, rescheduled: 0, dropped: 0 });
    expect(db.settings.detectedBudgets.c1.m1.budget).toBe(4);
    expect(db.settings.quotaRecheck).toEqual([]);
    expect(cleared.calls[0][0]).toBe("c1");
  });

  it("deletes the detectedBudgets key on success when there is no previousBudget", async () => {
    db.settings = { quotaRecheck: [entry()], detectedBudgets: { c1: { m1: { budget: 0, quota: true } } }, providerConnections: conn() };
    probe.results = [{ status: "ok", budget: 1, requests: 1 }];
    await run();
    expect(db.settings.detectedBudgets.c1.m1).toBeUndefined();
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("reschedules on quota-again within 24h and drops beyond it or unparseable", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 3h", requests: 1 }];
    let out = await run();
    expect(out.rescheduled).toBe(1);
    expect(new Date(db.settings.quotaRecheck[0].at).getTime()).toBe(NOW + 3 * 3600000);
    db.settings.quotaRecheck = [entry()];
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 8d", requests: 1 }];
    out = await run();
    expect(out.dropped).toBe(1);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("keeps the entry on transient probe outcomes and retries later", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "unreachable", reason: "timeout", requests: 1 }];
    const out = await run();
    expect(out.probed).toBe(1);
    expect(db.settings.quotaRecheck).toHaveLength(1);
  });

  it("drops terminal non-quota verdicts (auth/config/balance/unsupported)", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "auth", reason: "401", requests: 1 }];
    expect((await run()).dropped).toBe(1);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("drops a stale entry (>24h past its time) and an entry whose connection vanished", async () => {
    db.settings = { quotaRecheck: [entry({ at: new Date(NOW - 25 * 3600000).toISOString() }), entry({ connectionId: "gone" })], providerConnections: conn() };
    const out = await run({ probeFn: async () => { throw new Error("must not probe stale/missing"); } });
    expect(out.dropped).toBe(2);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("probes at most maxPerTick entries per run and only due ones", async () => {
    db.settings = {
      quotaRecheck: [
        entry({ connectionId: "c1" }), entry({ connectionId: "c2" }), entry({ connectionId: "c3" }),
        entry({ connectionId: "c4" }), entry({ connectionId: "c5" }), entry({ connectionId: "c6" }),
        entry({ connectionId: "later", at: new Date(NOW + 3600000).toISOString() }),
      ],
      providerConnections: conn(),
    };
    const out = await run({ probeFn: async () => ({ status: "ok", budget: 1, requests: 1 }) });
    expect(out.probed).toBe(5);
    expect(db.settings.quotaRecheck.map((e) => e.connectionId)).toEqual(["c6", "later"]);
  });
});

describe("ensureQuotaRecheckScheduler", () => {
  it("is idempotent — the second call returns the same handle", () => {
    const a = ensureQuotaRecheckScheduler({ getSettingsFn: async () => ({}) });
    const b = ensureQuotaRecheckScheduler();
    expect(b).toBe(a);
    resetQuotaRecheckScheduler();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/quota-recheck.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`processDueQuotaRecheck(deps)`: read `settings.quotaRecheck`; select entries with `at <= now`, oldest first, capped at `maxPerTick`; drop stale ones (`now - at > horizonMs`) and entries whose connection is missing (fetch once via `getConnectionsFn`); for the rest call `probeFn({ provider, connection, model, maxLevel: 1 })` — the real default `probeFn` is `probeConnectionModel` with the connection found from the list (keyless entries pass the virtual `{ id: providerId }` connection, as `scan.js` does). Outcome mapping: `ok` → restore `previousBudget` (else delete the `detectedBudgets[connectionId][model]` key), call `clearAccountErrorFn(connectionId, conn, model)`, remove entry, `restored += 1`; `quota` → `parseResetsIn(reason)` within horizon → update `at` (`rescheduled += 1`) else drop; `unreachable|unknown|throttle` → keep; `auth|config|balance|unsupported` → drop. Write settings once per mutation. `ensureQuotaRecheckScheduler`: 60s `setInterval` wrapping `processDueQuotaRecheck().catch(() => {})`, module-handle guard + `unref()` + `resetQuotaRecheckScheduler()` — copy `ensureCapacityScheduler`'s shape verbatim. `instrumentation.js`: same try/catch boot block, warn-prefixed `[QUOTA-RECHECK]`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd tests && npx vitest run unit/quota-recheck.test.js`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fork/capacity/quotaRecheck.js src/instrumentation.js tests/unit/quota-recheck.test.js
git commit -m "feat(quota): 60s re-check scheduler probes due accounts and restores budgets"
```

### Task 5: Expose the queue + provider-card line

**Files:**
- Modify: `src/app/api/fork/capacity-scan/route.js` (GET body)
- Modify: the provider detail page component that renders scan state (grep `capacityScan` under `src/app/(dashboard)/dashboard/providers/` for the card that shows the scan status)
- Test: `tests/unit/capacity-scan-api.test.js` (extend GET shape test)

**Interfaces:**
- Consumes: `settings.quotaRecheck` (Task 2).
- Produces: GET body field `quotaRecheck: [{ connectionId, provider, model, at }]` (absent when none).

- [ ] **Step 1: Write the failing test** — extend the existing GET-shape test:

```js
// inside the existing "GET returns the scan state shape" test settings:
db.settings = { capacityScan: { enabled: true }, quotaRecheck: [{ connectionId: "conn-1", provider: "glm", model: "m2", at: "2026-11-16T21:10:38.000Z" }] };
// new assertion:
expect(body.quotaRecheck).toEqual([{ connectionId: "conn-1", provider: "glm", model: "m2", at: "2026-11-16T21:10:38.000Z" }]);
```

- [ ] **Step 2: RED** — `cd tests && npx vitest run unit/capacity-scan-api.test.js` → FAIL (`quotaRecheck` undefined).

- [ ] **Step 3: Implement** — in the GET handler: `body.quotaRecheck = Array.isArray(settings.quotaRecheck) ? settings.quotaRecheck : undefined;` (and `delete body.quotaRecheck` when empty, so the key is absent when none). Provider card: one line under the scan-status text when a `quotaRecheck` entry matches the card's connection/provider — render `Hết hạn mức — tự kiểm tra lúc {HH:mm}` (format `at` in `Asia/Ho_Chi_Minh`); when no entry matches, render nothing.

- [ ] **Step 4: GREEN** — `cd tests && npx vitest run unit/capacity-scan-api.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/fork/capacity-scan/route.js "src/app/(dashboard)/dashboard/providers" tests/unit/capacity-scan-api.test.js
git commit -m "feat(quota): capacity-scan GET exposes the re-check queue; provider card shows the next check"
```

### Task 6: `concurrencySamples` — TABLES + goose 002 + adapter + schema guards

**Files:**
- Modify: `src/lib/db/schema.js` (`TABLES.concurrencySamples`, `SCHEMA_VERSION` 2→3 at line 6)
- Modify: `src/lib/db/adapters/postgresAdapter.js` (`PRIMARY_KEYS` map ~line 36-48; `resyncSequences` ~line 270-281)
- Create: `db/migrations/002_concurrency_samples.sql`
- Modify: `tests/unit/migrations-drift.test.js` (`expectedMirrorType` whitelist; index pin)
- Modify (wavebot repo): `apps/dashboard/db/scripts/verify-migrations.sh` — the c22 table count `11` → `12` (~line 897; grep `expect_eq "router tables owned by llm_router"`)

**Interfaces:**
- Produces: table `concurrencySamples(id bigserial PRIMARY KEY, ts text NOT NULL, inflight text NOT NULL, totalBudget text NOT NULL)` + `idx_concurrency_ts` on `(ts)` in BOTH schema systems; SQLite id `INTEGER PRIMARY KEY AUTOINCREMENT` (verbatim `usageHistory`'s idiom, `schema.js:115`).

- [ ] **Step 1: Write the migration and the schema entry, watch the strict tests fail**

Create `db/migrations/002_concurrency_samples.sql` exactly as the spec's SQL block (guarded `DO $$` hypertable + retention; Down removes policy then drops the table). Add to `schema.js`:

```js
concurrencySamples: {
  columns: {
    id: "INTEGER PRIMARY KEY AUTOINCREMENT",
    ts: "TEXT NOT NULL",
    inflight: "TEXT NOT NULL",
    totalBudget: "TEXT NOT NULL",
  },
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_concurrency_ts ON concurrencySamples(ts)",
  ],
},
```

Bump `SCHEMA_VERSION` to `3`.

Run: `cd tests && npx vitest run unit/migrations-drift.test.js`
Expected: FAIL with exactly two findings — `concurrencysamples.id is bigserial, the mirror contract says text` and the pinned index test (`["idx_concurrency_ts"]` vs `[]`).

- [ ] **Step 2: Widen the two deliberate whitelists (same change, test goes GREEN)**

`expectedMirrorType`: return `"bigserial"` for the `id` column of `usagehistory` **or** `concurrencysamples`, else `"text"`. Index pin: `expect(inMigrations).toEqual(["idx_concurrency_ts"])`.

Run: `cd tests && npx vitest run unit/migrations-drift.test.js`
Expected: PASS (all 11).

- [ ] **Step 3: Adapter obligations**

Add `concurrencySamples: "id"` to `PRIMARY_KEYS`; add `concurrencySamples` wherever `resyncSequences` lists `usageHistory`.

Run: `cd tests && ls unit | grep -i "postgres\|adapter"` — run the drift test plus whatever PG-adapter test file that lists (if none exists, the drift test alone covers this step).
Expected: PASS.

- [ ] **Step 4: Migration chain proof (wavebot repo)**

Run (from `/home/admin/code/sample-projects/wavebot`): `bash apps/dashboard/db/scripts/verify-migrations.sh 2>&1 | tail -5`
Expected: all cases pass; first run c22 FAILs on `11` → update the expected count to `12` and re-run until green. The guarded `DO $$` leaves a plain table on the stock pg15 image — that is the proof the guard works.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/002_concurrency_samples.sql src/lib/db/schema.js src/lib/db/adapters/postgresAdapter.js tests/unit/migrations-drift.test.js
git commit -m "feat(db): concurrencySamples table in schema + goose 002 with guarded hypertable"
cd /home/admin/code/sample-projects/wavebot && git add apps/dashboard/db/scripts/verify-migrations.sh && git commit -m "test(verify-migrations): c22 counts the new concurrencySamples table"
```

### Task 7: Sampler + system budget + retention prune

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js` (`recordConcurrencySample`, `pruneConcurrencySamples`, `countConcurrencySamples` helpers at the end of the file)
- Create: `src/lib/usage/concurrencySampler.js`
- Modify: `src/instrumentation.js` (one more guarded boot line)
- Test: `tests/unit/concurrency-sampler.test.js`

**Interfaces:**
- Consumes: `getActiveRequests() -> { activeRequests: [{ count, ... }], recentRequests, errorProvider }` from `@/lib/db/repos/usageRepo.js` (inflight = Σ `count`; tracked scope = chatCore traffic only — probes don't track, by design); `getAdapter().run(sql, params)`; `accountInflightLimit()` from `@/sse/services/accountInflight.js`; `keylessLaneLimit`/`effectiveFanoutBudget` from `@/sse/services/fanoutBudget.js`; `FREE_PROVIDERS` from `@/shared/constants/providers.js`.
- Produces: `recordConcurrencySample(inflight, totalBudget, { now }?)` (adapter insert, both SQLite and PG); `pruneConcurrencySamples(db, cutoffIso)`; `systemConcurrencyBudget({ settings, connections, globalLimit }) -> number`; `sampleOnce(deps)` where deps = `{ now, globalLimit? }` (default `accountInflightLimit()`); `ensureConcurrencyScheduler(deps) -> { stop }`; `resetConcurrencyScheduler()`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/concurrency-sampler.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ settings: {}, connections: [], rows: [], active: 0, deleted: [] }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => state.settings,
  getProviderConnections: async () => state.connections,
}));
vi.mock("../../../src/lib/db/repos/usageRepo.js", () => ({
  getActiveRequests: async () => ({ activeRequests: [{ count: state.active }], recentRequests: [], errorProvider: "" }),
  recordConcurrencySample: async (inflight, totalBudget) => { state.rows.push({ inflight, totalBudget }); },
  pruneConcurrencySamples: async (_db, cutoffIso) => { state.deleted.push(cutoffIso); },
}));

const { systemConcurrencyBudget, sampleOnce, ensureConcurrencyScheduler, resetConcurrencyScheduler } =
  await import("../../../src/lib/usage/concurrencySampler.js");

describe("systemConcurrencyBudget", () => {
  beforeEach(() => { state.settings = {}; state.connections = []; });
  const global = 4;

  it("counts each connection once at its max detected budget, else the global", async () => {
    state.settings = { detectedBudgets: { c1: { a: { budget: 10 }, b: { budget: 6 } }, c2: {} } };
    state.connections = [
      { id: "c1", provider: "glm", isActive: true },
      { id: "c2", provider: "glm", isActive: true },
      { id: "c3", provider: "glm", isActive: false }, // inactive: not counted
    ];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(10 + global);
  });

  it("counts one keyless lane per unconnected noAuth provider at the keyless ceiling", async () => {
    state.settings = { detectedBudgets: { opencode: { "big-pickle": { budget: 32, unbounded: true } } } };
    state.connections = [];
    const { FREE_PROVIDERS } = await import("../../../src/shared/constants/providers.js");
    expect(FREE_PROVIDERS.opencode?.noAuth).toBe(true); // registry premise — fails loudly if it drifts
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: [], globalLimit: global })).toBe(6); // keyless ceiling
  });
});

describe("sampleOnce", () => {
  beforeEach(() => { state.rows = []; state.active = 0; state.deleted = []; state.settings = {}; state.connections = []; });
  it("writes one row with Σ counts and the system budget", async () => {
    state.active = 3;
    state.settings = { detectedBudgets: {} };
    state.connections = [{ id: "c1", provider: "glm", isActive: true }];
    await sampleOnce({ now: new Date("2026-11-16T10:00:30.000Z"), globalLimit: 4 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].inflight).toBe(3);
    expect(state.rows[0].totalBudget).toBe("4");
  });
  it("prunes hourly (minute 0) and not otherwise", async () => {
    await sampleOnce({ now: new Date("2026-11-16T10:00:00.000Z") });
    expect(state.deleted).toHaveLength(1);
    await sampleOnce({ now: new Date("2026-11-16T10:00:30.000Z") });
    expect(state.deleted).toHaveLength(1);
  });
});

describe("ensureConcurrencyScheduler", () => {
  it("is idempotent", () => {
    const a = ensureConcurrencyScheduler({});
    expect(ensureConcurrencyScheduler()).toBe(a);
    resetConcurrencyScheduler();
  });
});
```

Also add the repo-level integration test (real adapter, no mocks) proving the insert + prune round-trip on SQLite:

```js
// tests/unit/concurrency-samples-repo.test.js
import { describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { recordConcurrencySample, pruneConcurrencySamples } from "../../src/lib/db/repos/usageRepo.js";

describe("concurrencySamples round-trip", () => {
  it("inserts rows, selects them back and prunes only old ones", async () => {
    const db = await getAdapter();
    await recordConcurrencySample(2, 10);
    const rows = db.all("SELECT ts, inflight, totalBudget FROM concurrencySamples ORDER BY id DESC LIMIT 1");
    expect(Number(rows[0].inflight)).toBe(2);
    expect(Number(rows[0].totalBudget)).toBe(10);
    await pruneConcurrencySamples(db, new Date(Date.now() + 86400000).toISOString()); // cutoff in the future
    expect(db.all("SELECT id FROM concurrencySamples WHERE inflight = '2' AND totalBudget = '10'")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/concurrency-sampler.test.js unit/concurrency-samples-repo.test.js`
Expected: FAIL — modules/functions missing (the repo test errors on the missing table only if Task 6's TABLES entry hasn't synced — it has, so the failure is the missing exports).

- [ ] **Step 3: Implement**

`usageRepo.js`: `recordConcurrencySample` — `db.run("INSERT INTO concurrencySamples (ts, inflight, totalBudget) VALUES (?, ?, ?)", [new Date().toISOString(), String(inflight), String(totalBudget)])` (accept an optional `{ now }` for tests); `pruneConcurrencySamples(db, cutoffIso)` — `DELETE FROM concurrencySamples WHERE ts < ?`; export both (and add them to the `@/lib/db/index.js` re-export chain if `usageRepo` functions are re-exported through it — follow how `getChartData` is exported). `concurrencySampler.js`: `systemConcurrencyBudget` walks active connections (max over that connection's `detectedBudgets[id]` numeric budgets, else `globalLimit`), plus one keyless lane per noAuth provider with no connections (`keylessLaneLimit(max detected under the provider id, else globalLimit, settings)`) — mirror `comboSummary`'s lane arithmetic, minus combos; `sampleOnce` computes inflight, calls `systemConcurrencyBudget`, records, and prunes when `new Date(now).getMinutes() === 0` with cutoff `now - 60 days`; `ensureConcurrencyScheduler` — 30s interval, module-handle guard + `unref()` + `resetConcurrencyScheduler()`. Instrumentation: third guarded boot block, warn prefix `[CONCURRENCY]`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd tests && npx vitest run unit/concurrency-sampler.test.js unit/concurrency-samples-repo.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/repos/usageRepo.js src/lib/db/index.js src/lib/usage/concurrencySampler.js src/instrumentation.js tests/unit/concurrency-sampler.test.js tests/unit/concurrency-samples-repo.test.js
git commit -m "feat(usage): 30s concurrency sampler with system budget and 60-day prune"
```

### Task 8: `getConcurrencyChartData` + API route

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js` (after `getChartData`)
- Modify: `src/lib/usageDb.js` (add `getConcurrencyChartData` to the re-export list)
- Create: `src/app/api/usage/concurrency/route.js`
- Test: `tests/unit/concurrency-chart-data.test.js` + `tests/unit/usage-concurrency-api.test.js`

**Interfaces:**
- Consumes: `concurrencySamples` rows (`ts`, `inflight`, `totalBudget`), `usageHistory` rows (`timestamp`, `promptTokens`, `completionTokens`, `cost`), `PERIOD_MS`/`loadDaysInRange` already in `usageRepo.js`.
- Produces: `getConcurrencyChartData(period) -> [{ label, concurrency, utilityRate, cumulativeTokens, cumulativeCost }]` (period `today|24h|7d|30d|60d|all`; `utilityRate` is a percentage number or `null` when the bucket's Σ totalBudget is 0); route `GET /api/usage/concurrency?period=` → JSON array.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/concurrency-chart-data.test.js — real adapter, seeded rows
import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { recordConcurrencySample } from "../../src/lib/db/repos/usageRepo.js";
import { getConcurrencyChartData } from "../../src/lib/db/repos/usageRepo.js";

const iso = (s) => new Date(s).toISOString();
const seedUsage = async (db, ts, prompt, completion, cost) => {
  await db.run(
    "INSERT INTO usageHistory (timestamp, provider, model, promptTokens, completionTokens, cost, status) VALUES (?, 'glm', 'm', ?, ?, ?, 'ok')",
    [ts, prompt, completion, cost],
  );
};

describe("getConcurrencyChartData", () => {
  beforeEach(async () => {
    const db = await getAdapter();
    await db.run("DELETE FROM concurrencySamples");
    await db.run("DELETE FROM usageHistory");
  });

  it("24h: average concurrency, budget-weighted rate, window-cumulative token/cost lines", async () => {
    const db = await getAdapter();
    const base = Date.now() - 2 * 3600000;
    // bucket A: two samples → avg (2+4)/2 = 3; next bucket: zero-budget sample → rate null
    await recordConcurrencySample(2, 10, { now: new Date(base) });
    await recordConcurrencySample(4, 10, { now: new Date(base + 60000) });
    await recordConcurrencySample(0, 0, { now: new Date(base + 3600000) });
    await seedUsage(db, iso(base), 100, 50, 0.01);
    await seedUsage(db, iso(base + 3600000), 10, 5, 0.02);

    const out = await getConcurrencyChartData("24h");
    expect(out).toHaveLength(24);
    expect(out.map((b) => b.utilityRate).filter((r) => r === null).length).toBeGreaterThan(0); // zero-budget bucket → null, not Infinity
    expect(out[out.length - 1].cumulativeTokens).toBe(165); // (150 + 15) window-cumulative
    expect(out[out.length - 1].cumulativeCost).toBeCloseTo(0.03, 6);
    const concurrencySum = out.reduce((s, b) => s + (b.concurrency || 0), 0);
    expect(concurrencySum).toBeCloseTo(3, 6); // bucket averages: (2+4)/2 + 0
    expect(out.every((b) => Number.isFinite(b.concurrency))).toBe(true);
  });

  it("empty table → zeroed buckets with null rates, never NaN; period 'all' with no data → []", async () => {
    const out = await getConcurrencyChartData("7d");
    expect(out).toHaveLength(7);
    expect(out.every((b) => b.concurrency === 0 && b.utilityRate === null && b.cumulativeTokens === 0)).toBe(true);
    expect(await getConcurrencyChartData("all")).toEqual([]);
  });
});
```

Adjustment note for the implementer: the first test locates buckets by position, not label — with `base` two hours ago and hourly buckets ending at "now", the two seeded samples share one bucket (avg `(2+4)/2 = 3`) and the zero-budget sample sits in the next bucket (`rate null`). Assert via the running sums (cumulative 165 / cost 0.03) and `concurrencySum === 3` — do not depend on wall-clock bucket labels. `recordConcurrencySample`'s optional `{ now }` must drive the stored `ts` for this to hold.

```js
// tests/unit/usage-concurrency-api.test.js
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb", () => ({ getConcurrencyChartData: async (period) => [{ label: "x", period }], getChartData: async () => [] }));
const { GET } = await import("@/app/api/usage/concurrency/route.js");

describe("GET /api/usage/concurrency", () => {
  it("serves the period through the repo and rejects unknown periods", async () => {
    const ok = await GET(new Request("http://router/api/usage/concurrency?period=7d"));
    expect(ok.status).toBe(200);
    expect((await ok.json())[0].period).toBe("7d");
    const bad = await GET(new Request("http://router/api/usage/concurrency?period=90d"));
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `cd tests && npx vitest run unit/concurrency-chart-data.test.js unit/usage-concurrency-api.test.js`
Expected: FAIL — `getConcurrencyChartData` missing; route module missing.

- [ ] **Step 3: Implement**

`getConcurrencyChartData(period)`: copy `getChartData`'s window scaffolding per period verbatim (today/24h → 24 hourly buckets with the same label fns; 7d/30d/60d → N daily buckets; all → daily from earliest `usageDaily` row, `[]` when none). Load samples with `db.all("SELECT ts, inflight, totalBudget FROM concurrencySamples WHERE ts >= ?", [windowStartIso])` and bucket them by `ts` like the chart does; per bucket `concurrency = Σ inflight / n` (`n = 0` → 0) and `utilityRate = Σ totalBudget > 0 ? (Σ inflight / Σ totalBudget) × 100 : null`. Then load `usageHistory` rows in the window (same query shape as `getChartData`) and walk buckets chronologically accumulating `cumulativeTokens` (prompt+completion) and `cumulativeCost`. Route: copy `src/app/api/usage/chart/route.js` verbatim, swapping the import and the `VALID_PERIODS` check target.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd tests && npx vitest run unit/concurrency-chart-data.test.js unit/usage-concurrency-api.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/repos/usageRepo.js src/lib/usageDb.js src/app/api/usage/concurrency/route.js tests/unit/concurrency-chart-data.test.js tests/unit/usage-concurrency-api.test.js
git commit -m "feat(usage): concurrency chart data (avg bars, weighted rate, cumulative lines) + API route"
```

### Task 9: Concurrency tab UI

**Files:**
- Modify: `src/app/(dashboard)/dashboard/usage/page.js` (tab whitelist line ~33, SegmentedControl options ~52, period-pill condition ~57, content switch ~68)
- Create: `src/app/(dashboard)/dashboard/usage/components/ConcurrencyChart.js`

**Interfaces:**
- Consumes: `GET /api/usage/concurrency?period=` (Task 8); `period`/`setPeriod` state already in `UsageContent`.
- Produces: tab id `concurrency`; component fetches and renders the chart.

- [ ] **Step 1: Implement the page changes**

Whitelist: `["overview", "logs", "details", "concurrency"]`. Options array: `{ value: "overview", label: "Overview" }, { value: "concurrency", label: "Concurrency" }, { value: "details", label: "Details" }`. Period pill condition: `(activeTab === "overview" || activeTab === "concurrency")`. Content: `{activeTab === "concurrency" && (<Suspense fallback={<CardSkeleton />}><ConcurrencyChart period={period} /></Suspense>)}`.

- [ ] **Step 2: Implement `ConcurrencyChart.js`**

`"use client"`; props `{ period }`; `useEffect` fetch `?period=${period}` on period change, abort on unmount; render `Card` + recharts `ComposedChart` with: `Bar dataKey="concurrency"` (left axis, count), `Line dataKey="utilityRate" unit="%"` (left axis, `connectNulls={false}` so null buckets gap the line), `Line dataKey="cumulativeTokens"` + `Line dataKey="cumulativeCost"` (right axis, `yAxisId="right"`). When the payload has no non-zero series, render a plain "Chưa có dữ liệu concurrency" message instead of an empty chart. Mirror `UsageChart.js`'s card/tooltip/responsive-container conventions.

- [ ] **Step 3: Verify the build**

Run: `npx next build 2>&1 | tail -5` (with the dev router container stopped, per the `.next` single-instance rule)
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/usage/page.js" "src/app/(dashboard)/dashboard/usage/components/ConcurrencyChart.js"
git commit -m "feat(usage): Concurrency tab with dual-axis bars, rate and cumulative lines"
```

### Task 10: llm-db Timescale container + retarget (wavebot repo)

**Files (all in `/home/admin/code/sample-projects/wavebot`):**
- Create: `docker-compose.llm-db.yml` (new Coolify resource)
- Modify: `docker-compose.llm.dev.yml` (add the `llm-db` service; URL host `@db:5432` → `@${LLM_DB_HOST:-llm-db}:5432`)
- Modify: `docker-compose.llm.yml` (same URL host change)
- Modify: `Makefile` (`llm-db` target lines 82-99: `up -d llm-db`, `PSQL` default `docker exec -i wavebot-llm-db-1 psql -U postgres`; the migrate llm half ~lines 225-233: pin `WAVEBOT_PG_PORT` at `$(val LLM_DB_HOST_PORT 20129)`)
- Modify: `apps/dashboard/db/scripts/llm-db-ensure.sh` (CREATE EXTENSION in the `\connect :"llm_db"` section; make the main-db protection block conditional on the main database existing)
- Modify: `scripts/check-coolify-compose.mjs` (`EXPECTED_SERVICES` + file loop) and `scripts/check-local-compose.mjs` (`MIRRORS` map)

**Interfaces:**
- Produces: container `wavebot-llm-db-1` (dev) publishing `${LLM_DB_HOST_PORT:-20129}:5432`, superuser `postgres` with `${LLM_DB_SUPERUSER_PASSWORD:-postgres}` (dev default) / `${LLM_DB_SUPERUSER_PASSWORD:?required}` (Coolify file); external volume `${VOLUME_PREFIX:-wavebot-coolify}_llm-db-data`; the router reaches it at `llm-db:5432` inside compose.

- [ ] **Step 1: Pin the image tag**

Run: `curl -s "https://hub.docker.com/v2/repositories/timescale/timescaledb/tags?page_size=100" | grep -o '"name":"[^"]*pg15"' | head`
Expected: a list of pg15 tags. Pin the newest non-rc, non-latest tag (e.g. `2.x.y-pg15`) in both compose files.

- [ ] **Step 2: Write the Coolify file + dev service**

`docker-compose.llm-db.yml` follows `docker-compose.storage.yml`'s shape (read it first): service `llm-db`, `image: timescale/timescaledb:<pinned>-pg15`, `restart: unless-stopped`, `TZ=${WAVEBOT_TZ:-Asia/Ho_Chi_Minh}`, `POSTGRES_PASSWORD=${LLM_DB_SUPERUSER_PASSWORD:?required}`, external volume `${VOLUME_PREFIX:-wavebot-coolify}_llm-db-data` at `/var/lib/postgresql/data`, `ports: - "${LLM_DB_HOST_PORT:?required}:5432"` (host-side goose needs it), healthcheck `pg_isready -U postgres`. Dev mirror (inside `docker-compose.llm.dev.yml`, new `llm-db` service + volumes block): same image, `POSTGRES_PASSWORD=${LLM_DB_SUPERUSER_PASSWORD:-postgres}`, port `${LLM_DB_HOST_PORT:-20129}:5432`, named volume `${VOLUME_PREFIX:-wavebot-remote}_llm-db-data`, `init: true`. Both llm stack files: `LLM_ROUTER_DATABASE_URL` host token `db` → `${LLM_DB_HOST:-llm-db}` (header comment updated; the local-only-differences comment in `llm.dev.yml` gains the new port).

- [ ] **Step 3: Ensure script + Makefile**

`llm-db-ensure.sh`: inside the `\connect :"llm_db"` section add `\echo llm-db-ensure: timescaledb` + `CREATE EXTENSION IF NOT EXISTS timescaledb;`; wrap the "shut out of the main database" block (both `REVOKE`/`GRANT` `\gexec` lines) in an existence guard so a dedicated instance without the main db doesn't abort — e.g. `SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'main_db') WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'main_db') \gexec` (same for the GRANT). Makefile: `llm-db` target swaps `up -d db` → `up -d llm-db`, `DB_CONTAINER` wait loop → `wavebot-llm-db-1`, `PSQL` default → `docker exec -i wavebot-llm-db-1 psql -U postgres`; migrate llm half gains `WAVEBOT_PG_PORT="$$(val LLM_DB_HOST_PORT 20129)"` (host stays 127.0.0.1). Comment lines updated to name the dedicated instance.

- [ ] **Step 4: Lint scripts**

`check-coolify-compose.mjs`: `EXPECTED_SERVICES` gains the `llm-db` resource entry; `check-local-compose.mjs`: `MIRRORS` gains `llm-db: docker-compose.llm-db.yml`-style pair wiring per its existing shape (read both scripts' entry shapes before editing).

- [ ] **Step 5: Verify**

Run (from `wavebot/`): `node scripts/check-coolify-compose.mjs && node scripts/check-local-compose.mjs`
Expected: both exit 0. Then: `cd /home/admin/code/sample-projects/wavebot && docker compose -f docker-compose.storage.dev.yml -f docker-compose.app.dev.yml -f docker-compose.workers.dev.yml -f docker-compose.llm.dev.yml -f docker-compose.packages.dev.yml -f docker-compose.gpu.dev.yml --env-file .env.omni config --format json | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['services']['llm-db']['image'], [p['published'] for p in c['services']['llm-db']['ports'].values()] if isinstance(c['services']['llm-db']['ports'], dict) else 'list-ok')"`
Expected: the pinned image and the published port render.

- [ ] **Step 6: Commit (wavebot repo)**

```bash
git add docker-compose.llm-db.yml docker-compose.llm.dev.yml docker-compose.llm.yml Makefile apps/dashboard/db/scripts/llm-db-ensure.sh scripts/check-coolify-compose.mjs scripts/check-local-compose.mjs
git commit -m "feat(llm): dedicated llm-db Timescale container; router DB host retargeted"
```

### Task 11: Dev cutover + live verification + regression gate

**Files:**
- Create: `docs/runbooks/llm-db-timescale-cutover.md` (wavebot repo; `git add -f` — docs/ is gitignored)
- No code; verification only.

- [ ] **Step 1: Cutover dev data (from `wavebot/`)**

```bash
cd /home/admin/code/sample-projects/wavebot
# <the six -f files> = exactly the layering in the Makefile's COMPOSE variable
docker compose -f docker-compose.storage.dev.yml -f docker-compose.app.dev.yml \
  -f docker-compose.workers.dev.yml -f docker-compose.llm.dev.yml \
  -f docker-compose.packages.dev.yml -f docker-compose.gpu.dev.yml \
  --env-file .env.omni stop llm-router
PW=$(sed -n 's/^LLM_ROUTER_DB_PASSWORD=//p' .env.omni | head -1)  # env only, never echoed
PGPASSWORD="$PW" docker exec wavebot-db-1 pg_dump -U llm_router -d wavebot_llm_router > /tmp/llm-router-dump.sql
make llm-db   # new container up, role + db created, extension on
PGPASSWORD="$PW" docker exec -i wavebot-llm-db-1 psql -U llm_router -d wavebot_llm_router < /tmp/llm-router-dump.sql
rm /tmp/llm-router-dump.sql
make migrate  # applies 002 on the restored ledger
docker compose -f docker-compose.storage.dev.yml -f docker-compose.app.dev.yml \
  -f docker-compose.workers.dev.yml -f docker-compose.llm.dev.yml \
  -f docker-compose.packages.dev.yml -f docker-compose.gpu.dev.yml \
  --env-file .env.omni up -d --force-recreate llm-router
```

Password rule: resolve into an env var in the same shell command (process env → `.env.omni`, like the Makefile's `val()`); never on pg_dump/psql argv beyond `-U`, never echoed.

- [ ] **Step 2: Verify the chain**

Run: `docker exec wavebot-llm-db-1 psql -U llm_router -d wavebot_llm_router -c "SELECT extname FROM pg_extension WHERE extname='timescaledb'" -c "SELECT count(*) FROM goose_db_version" -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"`
Expected: `timescaledb` present; versions include 1 and 2; `concurrencySamples` listed.
Then the hypertable proof: `... -c "SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables"` — after Step 3's samples exist, `num_chunks >= 1` proves `to_timestamp` chunking on our ISO strings. If 002 had failed on `to_timestamp` the migrate in Step 1 would already have errored loudly — in that case STOP and debug, never guess a workaround.

- [ ] **Step 3: Verify the sampler**

Run: `sleep 70 && docker exec wavebot-llm-db-1 psql -U llm_router -d wavebot_llm_router -c "SELECT count(*), min(ts), max(ts) FROM concurrencySamples"`
Expected: count ≈ 2-3 rows (30s interval), timestamps within the last minute.

- [ ] **Step 4: Verify the tab**

Open `http://localhost:20128/dashboard/usage?tab=concurrency` in a browser (Playwright script from the fork with `/usr/bin/google-chrome --no-sandbox`, cookie-authenticated; screenshots only under `/home/admin/code/sample-projects/`). Expected: the Concurrency pill renders, the chart draws bars from the fresh samples, no console errors.

- [ ] **Step 5: Verify the collapse path end-to-end (staged)**

With the dashboard logged in, pick a dev connection and POST one request through `/v1/chat/completions` with a deliberately quota-refused stub (or wait for a real GLM quota). Verify in the DB: `SELECT data FROM settings WHERE id = 1` (or the SQLite equivalent via the dashboard) contains `detectedBudgets.<conn>.<model>.budget === 0` with `source: "live"`, and `quotaRecheck` carries the entry when a reset ≤24h was stated. The provider card shows `Hết hạn mức — tự kiểm tra lúc HH:MM`.

- [ ] **Step 6: Regression gate (fork)**

Run: `cd /home/admin/code/sample-projects/9router-fork/tests && npx vitest run 2>&1 | tail -20 && node tests/__baseline__/verify-no-regression.mjs`
Expected: no new failures vs the committed baseline; `✅ No regression.` — known flakes re-run in isolation.

- [ ] **Step 7: Runbook + commit (wavebot repo)**

Write `docs/runbooks/llm-db-timescale-cutover.md`: the Step 1 sequence as the durable runbook (backup-first for prod: `pg_dump` prod `wavebot_llm_router` before restore; prod Coolify checklist — new `llm-db` resource with `connect_to_docker_network` ON, `LLM_DB_SUPERUSER_PASSWORD` on the llm-db resource, `LLM_DB_HOST` unset (compose default `llm-db`), migrate.yml llm half against `${LLM_DB_HOST_PORT}`; note the release is HELD until Steve says otherwise).

```bash
cd /home/admin/code/sample-projects/wavebot && git add -f docs/runbooks/llm-db-timescale-cutover.md && git commit -m "docs: llm-db Timescale cutover runbook (dev executed, prod rides the held release)"
```

---

## Completion contract

All of: every task's tests ran RED then GREEN in this session's executor; the regression gate output is green (`✅ No regression.`); the drift test passes; `verify-migrations.sh` is green with c22 = 12; the dev stack runs on `llm-db` with sampler rows landing and the tab rendering; the collapse path verified staged-live. Anything less is not done.
