export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Patch #20: daily capacity auto-detect scheduler. A scan failure must
    // never block boot — the stale-running rule recovers a crashed scan on a
    // later tick, so the only job here is to start the interval.
    try {
      const { ensureCapacityScheduler } = await import("@/lib/fork/capacity/scan.js");
      ensureCapacityScheduler();
    } catch (e) {
      console.warn("[CAPACITY] scheduler failed to start:", e?.message || e);
    }

    // 60s re-check of quota lanes the live collapse scheduled for reopening;
    // same fail-open shape as the capacity scheduler.
    try {
      const { ensureQuotaRecheckScheduler } = await import("@/lib/fork/capacity/quotaRecheck.js");
      ensureQuotaRecheckScheduler();
    } catch (e) {
      console.warn("[QUOTA-RECHECK] scheduler failed to start:", e?.message || e);
    }

    // 30s concurrency sampler feeding the Usage tab's Concurrency chart.
    try {
      const { ensureConcurrencyScheduler } = await import("@/lib/usage/concurrencySampler.js");
      ensureConcurrencyScheduler();
    } catch (e) {
      console.warn("[CONCURRENCY] scheduler failed to start:", e?.message || e);
    }
  }
}
