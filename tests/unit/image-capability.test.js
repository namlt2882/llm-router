import { beforeEach, describe, expect, it, vi } from "vitest";

// `buildModelsList` reads connections + combos; the predicate tests below never
// touch these, so the stubs only serve the `/v1/models` case. Same shape as
// tests/unit/v1-models-combo-context.test.js (`setCatalogSource` is deliberately
// NOT used: it would replace the capability source this test is about).
// The probe describe (Task 4) shares THIS registration: vitest keeps only the
// last vi.mock per module path, so a second `vi.mock("@/lib/localDb", …)`
// would silently strip these stubs out from under the /v1/models case.
const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  // Task 4: settings + connection reads for the probe route. `fx` below is an
  // alias so the probe tests read like their brief.
  settings: {},
  updated: [],
  conn: { id: "conn-1", provider: "openai", isActive: true },
  getSettings: async () => db.settings,
  updateSettings: async (u) => { db.updated.push(u); },
  getProviderConnectionById: async (id) => (id === db.conn?.id ? db.conn : null),
}));
const fx = db;
const mocks = vi.hoisted(() => ({ ping: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
// `pingModelByKind` is the probe. Mock it: the real one issues an HTTP call to
// this same server. Its honest result shape is `{ ok, latencyMs, error, status }`
// (src/app/api/models/test/ping.js:90-96).
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: mocks.ping }));

import { isImageCapable } from "../../open-sse/providers/imageCapability.js";
import { buildModelGroups } from "../../src/shared/utils/selectableModels.js";
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("isImageCapable", () => {
  it("accepts a declared image model on an adapter provider", () => {
    expect(isImageCapable("openai", "gpt-image-1")).toBe(true);
    expect(isImageCapable("fal-ai", "fal-ai/flux/dev")).toBe(true);
    expect(isImageCapable("gemini", "gemini-2.5-flash-image")).toBe(true);
  });
  it("accepts any model on the one adapter provider that publishes no rows (live catalogue)", () => {
    // Measured 2026-11-24: `vercel-ai-gateway` is the ONLY adapter provider with
    // no PROVIDER_MODELS key. If a second one appears, add it here deliberately.
    expect(isImageCapable("vercel-ai-gateway", "openai/gpt-image-1")).toBe(true);
    expect(isImageCapable("vercel-ai-gateway", "anything-at-all")).toBe(true);
  });
  it("reads a provider through its alias, not its id", () => {
    // Measured 2026-11-24: PROVIDER_MODELS is keyed `entry.alias || entry.id`, so
    // every one of these ids has NO rows under its own name. Without the alias
    // lookup each would fall into the "no published list -> YES" arm and every
    // chat model on it would become an image member.
    expect(isImageCapable("codex", "gpt-image-2.5")).toBe(true);          // -> cx
    expect(isImageCapable("veoaifree-web", "nano-banana")).toBe(true);    // -> veo-free (3 rows)
    expect(isImageCapable("uc-web", "nano-banana")).toBe(true);           // -> uc (53 rows)
    expect(isImageCapable("uc-web", "some-live-id")).toBe(false);         // published list, absent id
    expect(isImageCapable("veoaifree-web", "veo")).toBe(false);           // a video row, not image
  });
  it("rejects a provider that declares image rows but ships no adapter", () => {
    expect(isImageCapable("venice", "venice-sd35")).toBe(false);
    expect(isImageCapable("topaz", "any")).toBe(false);
  });
  it("rejects an undeclared model on a provider that DOES publish a model list", () => {
    // absence from a published list is "not a model here", not "not declared"
    expect(isImageCapable("openai", "some-model-that-does-not-exist")).toBe(false);
    expect(isImageCapable("gemini", "gpt-image-1")).toBe(false);
  });
  it("leaves the image picker with nothing for a provider that cannot generate images", () => {
    // Measured 2026-11-24 against the real buildModelGroups: with kindFilter
    // "image" the picker fell back to a provider-as-model entry for BOTH of
    // these, because its filtered list was empty and ALLOW_PROVIDER_FALLBACK_KINDS
    // contains "image". Gating only filterByKind cannot remove that entry.
    // Static import like model-select-noauth-search.test.js — this module touches no `@/lib`.
    const groups = buildModelGroups({
      kindFilter: "image",
      connections: [
        { id: "c1", provider: "tokenrouter", isActive: true },
        { id: "c2", provider: "venice", isActive: true },
        { id: "c3", provider: "openai", isActive: true },
      ],
      allConnections: [],
    });
    expect(groups.tokenrouter).toBeUndefined();
    expect(groups.venice).toBeUndefined();
    expect(groups.openai.models.map((m) => m.id)).toEqual([
      "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
      "gpt-image-1", "dall-e-3", "dall-e-2",
    ]);
  });
  it("/v1/models publishes imageOutput:true for image rows and for an image combo (measured bug: 55/68 rows false)", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: 1, provider: "openai", isActive: true, providerSpecificData: { enabledModels: ["gpt-image-1", "gpt-5.4"] } },
    ]);
    db.getCombos.mockResolvedValue([
      { name: "one-openai", kind: "image", models: ["openai/gpt-image-1"] },
      { name: "one-ucweb", kind: "image", models: ["uc-web/nano-banana"] },
      { name: "one-tokenrouter", kind: "image", models: ["tokenrouter/openai/gpt-5.4"] },
    ]);
    const rows = await buildModelsList(["image"]);
    const byId = (id) => rows.find((r) => r.id === id);

    expect(byId("openai/gpt-image-1").capabilities.imageOutput).toBe(true);
    // The overlay spreads, never replaces: whatever caps produced (service-kind
    // image rows carry { imageOutput: true } already) keeps every other key.
    expect(byId("openai/gpt-image-1").capabilities).toEqual(
      expect.objectContaining({ imageOutput: true })
    );
    expect(byId("one-openai").capabilities.imageOutput).toBe(true);
    // `some`, not `every`: a combo whose only member cannot generate images is false...
    expect(byId("one-tokenrouter").capabilities.imageOutput).toBe(false);
    // ...and a uc-web member (real catalogue, image rows, imageOutput false before this fix) is now true.
    expect(byId("one-ucweb").capabilities.imageOutput).toBe(true);
  });
  it("rejects a declared model whose row is not image, including the kind-less chat rows", () => {
    // every chat row omits `kind`; a "no kind -> capable" rule would admit all of these
    expect(isImageCapable("openai", "gpt-5.4")).toBe(false);
    expect(isImageCapable("gemini", "gemini-2.5-flash")).toBe(false);
    expect(isImageCapable("xai", "grok-4")).toBe(false);
    expect(isImageCapable("openai", "gpt-4o-mini-tts")).toBe(false);
    expect(isImageCapable("tokenrouter", "openai/gpt-5.4")).toBe(false);
  });
});

const { POST } = await import("../../src/app/api/providers/[id]/image-check/route.js");
const call = () => POST(new Request("http://localhost/api/providers/conn-1/image-check", { method: "POST" }), { params: Promise.resolve({ id: "conn-1" }) });

beforeEach(() => {
  fx.updated = [];
  fx.conn = { id: "conn-1", provider: "openai", isActive: true };
  fx.settings = { imageCapability: { otherConn: { "m-1": { ok: true, at: "2026-01-01T00:00:00.000Z" } } } };
  mocks.ping.mockReset();
});

describe("POST /api/providers/[id]/image-check", () => {
  // Measured 2026-11-24: `openai` publishes 36 rows, 6 of them `kind:"image"` —
  // gpt-image-2.5, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-1,
  // dall-e-3, dall-e-2 — and `gpt-5.4` has NO `kind`. Six probes is the whole
  // set; a probe list that is longer or shorter means the filter is wrong.
  it("probes only the image-capable models and merges the verdict into the map", async () => {
    mocks.ping.mockImplementation(async (model) =>
      model === "openai/gpt-image-1"
        ? { ok: true, latencyMs: 42, error: null, status: 200 }
        : { ok: false, latencyMs: 17, error: "HTTP 400: model refused", status: 400 });
    // openai publishes 6 image rows (2b); gpt-5.4 is a chat row and must never be probed.
    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.provider).toBe("openai");
    expect(body.connectionId).toBe("conn-1");
    const probed = mocks.ping.mock.calls.map((c) => c[0]);
    expect(probed).not.toContain("openai/gpt-5.4");
    expect(probed.every((m) => m.startsWith("openai/"))).toBe(true);
    expect(probed).toHaveLength(6);
    expect(probed[0]).toBe("openai/gpt-image-2.5");   // warm-up runs FIRST, serialised
    // Minor #1: every probe must pin the connection it stores a verdict for —
    // a sibling connection's key must never answer a probe attributed here.
    expect(mocks.ping.mock.calls.every((c) => c[3] === "conn-1")).toBe(true);

    expect(fx.updated).toHaveLength(1);
    const map = fx.updated[0].imageCapability;
    expect(map.otherConn).toEqual({ "m-1": { ok: true, at: "2026-01-01T00:00:00.000Z" } });  // untouched
    expect(map["conn-1"]["gpt-image-1"]).toMatchObject({ ok: true, error: null });
    expect(map["conn-1"]["gpt-image-1"].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(map["conn-1"]["dall-e-3"]).toMatchObject({ ok: false, error: "HTTP 400: model refused" });
  });

  it("refuses a connection with no image-capable model, before probing anything", async () => {
    fx.conn = { id: "conn-1", provider: "tokenrouter", isActive: true };
    const res = await call();
    expect(res.status).toBe(400);
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(fx.updated).toHaveLength(0);
  });

  it("404s an unknown connection", async () => {
    const res = await POST(new Request("http://localhost/api/providers/nope/image-check", { method: "POST" }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("imageCapability packaging", () => {
  // The client imports the CORE predicate, which must know the adapter set
  // without importing the adapters (their executor graph is node-only and
  // breaks the browser bundle — measured: `npm run build` fails through
  // executors/index.js). adapterIds.js is the client's copy of the adapter id
  // set; this parity test is what keeps it from drifting from the real map.
  it("adapterIds matches the real adapter map", async () => {
    const { IMAGE_ADAPTER_IDS } = await import("../../open-sse/handlers/imageProviders/adapterIds.js");
    const { default: ADAPTERS } = await import("../../open-sse/handlers/imageProviders/index.js");
    expect([...IMAGE_ADAPTER_IDS].sort()).toEqual(Object.keys(ADAPTERS).sort());
  });
  it("the core predicate gates on the adapter set and the registry; the server wrapper adds the grammar", async () => {
    const core = await import("../../open-sse/providers/imageCapability.js");
    const server = await import("../../open-sse/providers/imageCapability.server.js");
    // rows + set: both layers agree
    expect(core.isImageCapable("openai", "gpt-image-1")).toBe(true);
    expect(core.isImageCapable("venice", "venice-sd35")).toBe(false);
    expect(server.isImageCapable("openai", "gpt-image-1")).toBe(true);
    // codex grammar: core (no adapter graph) refuses, server wrapper admits
    expect(core.isImageCapable("codex", "gpt-5.6-sol-image")).toBe(false);
    expect(server.isImageCapable("codex", "gpt-5.6-sol-image")).toBe(true);
    // huggingface is the other open-ended id space: registry rows are only the
    // inference-API catalogue, a self-hosted TGI endpoint takes ANY repo id.
    // Found by the Task-10 regression gate (huggingface-image-end-to-end).
    expect(server.isImageCapable("huggingface", "my-org/my-tgi-model")).toBe(true);
    expect(server.isImageCapable("huggingface", "some-org/unmapped-model")).toBe(true);
  });
});
