import { describe, expect, it, vi } from "vitest";

// `buildModelsList` reads connections + combos; the predicate tests below never
// touch these, so the stubs only serve the `/v1/models` case. Same shape as
// tests/unit/v1-models-combo-context.test.js (`setCatalogSource` is deliberately
// NOT used: it would replace the capability source this test is about).
const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

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
