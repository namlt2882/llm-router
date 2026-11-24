import { describe, expect, it, vi } from "vitest";
import { parseSystemoneJson, validateSystemoneAnswers, handleSystemoneShim } from "../../open-sse/handlers/systemoneShim.js";

const Q = {
  a: { type: "noul", instructions: "billing?" },
  b: { type: "choice", instructions: "which?", criteria: { refund: "wants money back", other: "anything else" } },
  c: { type: "score", instructions: "anger 0-10", criteria: ["calm", "furious"] },
};
const good = { a: { noul: 0.6 }, b: { choice: "refund", confidence: 0.9 }, c: { score: 7, confidence: 0.8 } };

describe("parseSystemoneJson", () => {
  it("strips a fence", () => expect(parseSystemoneJson('```json\n{"answers":{}}\n```')).toEqual({ answers: {} }));
  it("takes the outermost object from chatter", () => expect(parseSystemoneJson('sure: {"a":1} done')).toEqual({ a: 1 }));
  it("returns null on prose", () => expect(parseSystemoneJson("I cannot answer")).toBeNull());
  it("rescans past an unparseable brace pair instead of giving up", () => {
    // A leading brace pair whose interior is not JSON (e.g. prose that happens
    // to open with a curly bracket) must not abort the scan: the model's real
    // answer frequently follows it. Today the first JSON.parse failure returns
    // null even though a perfectly good object comes after.
    expect(parseSystemoneJson('Note {important}: {"answers":{}}')).toEqual({ answers: {} });
  });
  it("still gives up when no parseable object exists anywhere", () => {
    // Both pairs are balanced but neither is valid JSON (bare tokens, no quotes).
    expect(parseSystemoneJson('{broken: [} {still: not json}')).toBeNull();
    // Unbalanced: a brace opens and never closes.
    expect(parseSystemoneJson('{"answers": {"a": {"noul": 0.5}')).toBeNull();
  });
});

describe("validateSystemoneAnswers", () => {
  it("accepts a complete answer, echoes type, drops unknown keys", () => {
    const r = validateSystemoneAnswers(Q, { ...good, a: { noul: 0.6, extra: 1 } });
    expect(r.ok).toBe(true);
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.6 });
    expect(r.answers.b).toEqual({ type: "choice", choice: "refund", confidence: 0.9 });
  });
  it.each([
    ["missing question", { a: good.a, b: good.b }],
    ["noul out of range", { ...good, a: { noul: 2 } }],
    ["choice not offered", { ...good, b: { choice: "upgrade", confidence: 0.9 } }],
    ["choice without confidence", { ...good, b: { choice: "refund" } }],
    ["score not finite", { ...good, c: { score: "7", confidence: 0.8 } }],
  ])("rejects %s", (_n, answers) => {
    const r = validateSystemoneAnswers(Q, answers);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^systemone-shim:/);
  });
});

describe("handleSystemoneShim", () => {
  const chatOk = (content, usage) => vi.fn(async () => ({
    success: true,
    response: new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, headers: { "content-type": "application/json" } }),
  }));
  const call = (handleChat) => handleSystemoneShim({
    body: { model: "glm-5.3-flash", state: "s", questions: Q },
    modelInfo: { provider: "glm", model: "glm-5.3-flash" }, credentials: { apiKey: "k" },
    handleChat,
  });

  it("asks once through chatCore with a strict json_schema and returns the native answer shape", async () => {
    const handleChat = chatOk(JSON.stringify({ answers: good }), { prompt_tokens: 120, completion_tokens: 40 });
    const res = await call(handleChat);
    expect(res.success).toBe(true);
    expect(res.usageRecorded).toBe(true);
    expect(await res.response.json()).toEqual({ model: "glm-5.3-flash", answers: good, usage: { input_tokens: 120, output_tokens: 40 } });
    const [opts] = handleChat.mock.calls[0];
    expect(opts.modelInfo).toEqual({ provider: "glm", model: "glm-5.3-flash" });
    expect(opts.credentials).toEqual({ apiKey: "k" });
    expect(opts.body.stream).toBe(false);
    expect(opts.body.temperature).toBe(0);
    expect(opts.body.messages[0].role).toBe("system");
    expect(opts.body.messages[1].content).toContain('"questions"');
    expect(opts.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "systemone_answers", strict: true } });
  });
  it("omits usage rather than zeroing it, and never invents a cost", async () => {
    const body = await (await call(chatOk(JSON.stringify({ answers: good })))).response.json();
    expect(body.usage).toBeUndefined();
    expect(body.cost).toBeUndefined();
  });
  it("fails the member instead of inventing an answer", async () => {
    const res = await call(chatOk("I think it is billing."));
    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/^systemone-shim: member glm\/glm-5\.3-flash/);
  });
  it("fails the member when chatCore itself fails", async () => {
    const res = await call(vi.fn(async () => ({ success: false, status: 503, error: "upstream down" })));
    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/chatCore 503/);
  });
});
