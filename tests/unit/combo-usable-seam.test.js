import { describe, expect, it } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("handleComboChat isUsable", () => {
  it("refuses a 2xx body the predicate rejects, even as the only seat", async () => {
    const res = await handleComboChat({
      body: {}, models: ["a/1"], handleSingleModel: () => Promise.resolve(json({ answers: {} })), log,
      comboName: "c", comboStrategy: "fallback",
      isUsable: (b) => Object.keys(b?.answers || {}).length > 0,
    });
    expect(res.status).toBe(502);
  });
  it("falls through to the next member", async () => {
    const calls = [];
    const res = await handleComboChat({
      body: {}, models: ["a/1", "b/2"],
      handleSingleModel: (b, m) => { calls.push(m); return Promise.resolve(json(m === "a/1" ? { answers: {} } : { answers: { q: { noul: 1 } } })); },
      log, comboName: "c", comboStrategy: "fallback", isUsable: (x) => Object.keys(x?.answers || {}).length > 0,
    });
    expect(calls).toEqual(["a/1", "b/2"]);   // fails today: the first seat is committed
    expect(res.status).toBe(200);
    expect((await res.json()).answers).toEqual({ q: { noul: 1 } });
  });
  it("keeps today's behaviour when the predicate is absent", async () => {
    const res = await handleComboChat({
      body: {}, models: ["a/1"], handleSingleModel: () => Promise.resolve(json({ answers: {} })), log,
      comboName: "c", comboStrategy: "fallback",
    });
    expect(res.status).toBe(200);
  });
  it("keeps the zero-content last-seat exemption when no predicate is supplied", async () => {
    // Measured today: a single seat answering {"choices":[]} returns 200 as-is.
    // The spec says the last-seat exemption is untouched; a fix that makes this
    // 502 has widened a rule it was told not to touch.
    const res = await handleComboChat({
      body: {}, models: ["a/1"], handleSingleModel: () => Promise.resolve(json({ choices: [] })), log,
      comboName: "c", comboStrategy: "fallback",
    });
    expect(res.status).toBe(200);
  });
  it("never returns a 200 tail after any member was rejected — mixed zero-content + rejected history", async () => {
    // Seat 1 hits the zero-content arm (lastStatus := 200); seat 2 is rejected by
    // the predicate, and that arm deliberately keeps an existing 200 untouched so
    // it never DOWNGRADES an upstream status. The tail then reported lastStatus
    // 200 with lastError set — a 200 carrying an error body, unreadable for a
    // client that only checks the status. The tail is only ever reached when
    // nothing was returned, so a tail 200 is always an abandonment.
    const calls = [];
    const res = await handleComboChat({
      body: {}, models: ["a/1", "b/2"],
      handleSingleModel: (_b, m) => { calls.push(m); return Promise.resolve(json(m === "a/1" ? { choices: [] } : { answers: {} })); },
      log, comboName: "c", comboStrategy: "fallback",
      isUsable: (x) => Object.keys(x?.answers || {}).length > 0,
    });
    expect(calls).toEqual(["a/1", "b/2"]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
  });
  it("still applies the zero-content rule when a predicate is present (cumulative, not either/or)", async () => {
    // The predicate accepts everything; only isZeroContentResponse can reject
    // {"choices":[]}. An `if (isUsable) … else if (!isLastModel) …` shape would
    // commit this seat — that is the regression this case exists to catch.
    const calls = [];
    const res = await handleComboChat({
      body: {}, models: ["a/1", "b/2"],
      handleSingleModel: (_b, m) => { calls.push(m); return Promise.resolve(json(m === "a/1" ? { choices: [] } : { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] })); },
      log, comboName: "c", comboStrategy: "fallback", isUsable: () => true,
    });
    expect(calls).toEqual(["a/1", "b/2"]);
    expect(res.status).toBe(200);
  });
});
