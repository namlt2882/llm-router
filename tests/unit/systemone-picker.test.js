import { describe, expect, it } from "vitest";
import { connectionServesSystemone, modelServesSystemone } from "../../src/shared/utils/systemonePicker.js";

// Browser test 2026-11-24: the systemone combo picker showed "No models found"
// for glm-5.3-flash. Both filters excluded plain text models — the connection
// filter required serviceKinds to include "systemone" (glm declares ["llm"]),
// and the model filter required kind === "systemone". But the whole point of
// the systemone level-up is that a TEXT model seats into a systemone combo and
// answers through the validated JSON shim — so the shim was UI-unreachable.

describe("systemone picker admission", () => {
  it("admits llm-capable providers' connections as shim members", () => {
    expect(connectionServesSystemone(["llm"])).toBe(true);            // glm pool
    expect(connectionServesSystemone(["llm", "image"])).toBe(true);   // multi-kind
    expect(connectionServesSystemone(undefined)).toBe(true);          // defaults to ["llm"]
  });
  it("admits natively systemone-capable providers", () => {
    expect(connectionServesSystemone(["systemone"])).toBe(true);
    expect(connectionServesSystemone(["systemone", "llm"])).toBe(true);
  });
  it("refuses connections that can neither serve systemone natively nor as text", () => {
    expect(connectionServesSystemone(["image"])).toBe(false);
    expect(connectionServesSystemone(["tts"])).toBe(false);
    expect(connectionServesSystemone(["embedding", "stt"])).toBe(false);
  });
  it("admits native systemone rows and kind-less/llm rows (shim candidates)", () => {
    expect(modelServesSystemone("systemone")).toBe(true);
    expect(modelServesSystemone(null)).toBe(true);
    expect(modelServesSystemone(undefined)).toBe(true);
    expect(modelServesSystemone("llm")).toBe(true);
  });
  it("refuses other media kinds as systemone members", () => {
    expect(modelServesSystemone("image")).toBe(false);
    expect(modelServesSystemone("tts")).toBe(false);
    expect(modelServesSystemone("embedding")).toBe(false);
    expect(modelServesSystemone("imageToText")).toBe(false);
  });
});
