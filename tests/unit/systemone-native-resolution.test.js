import { describe, expect, it } from "vitest";
import { resolveSystemoneMode } from "../../open-sse/handlers/systemoneCore.js";

describe("resolveSystemoneMode", () => {
  it.each([
    ["ollama", "clef", "native"],                    // model kind + provider config
    ["openrouter", "typesafe/jev-1.13", "native"],   // model kind
    ["openrouter", "openai/gpt-4o-mini", "native"],  // provider declares the endpoint; chat model
    ["openai", "gpt-5.4", "shim"],                   // neither
    ["glm", "glm-5.3-flash", "shim"],
  ])("%s/%s -> %s", (provider, model, want) => expect(resolveSystemoneMode({ provider, model })).toBe(want));
});
