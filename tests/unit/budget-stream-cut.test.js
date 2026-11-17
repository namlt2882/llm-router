import { describe, expect, it } from "vitest";
import { createBudgetCut, createBudgetStream, attachCostHeaders } from "../../open-sse/utils/budget.js";

const SALE = { input: 1000, output: 4000, cached: 100, reasoning: 4000, cacheCreation: 1250, perImage: 0 };
const enc = new TextEncoder();

function sseResponse(lines) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return body;
}
async function readAll(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}
const chunk = (text) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const dataLines = (s) => s.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));

describe("createBudgetCut", () => {
  it("continues below the budget and cuts at it", () => {
    // budget 4 credits = 1,000 output tokens at 4000/1M
    const cut = createBudgetCut({ budgetCredits: 4, sale: SALE, inputTokens: 0 });
    expect(cut.onChunk({ completion_tokens: 999 })).toBe("continue");
    expect(cut.onChunk({ completion_tokens: 1000 })).toBe("cut");
  });
  it("counts the input pass against the budget", () => {
    const cut = createBudgetCut({ budgetCredits: 4, sale: SALE, inputTokens: 1_000_000 });
    expect(cut.onChunk({ completion_tokens: 0 })).toBe("cut");
  });
  it("counts reasoning tokens at the reasoning rate", () => {
    // reasoning dearer than output: 1,000 reasoning tokens at 8000/1M = 8 credits = the whole budget
    const sale = { ...SALE, reasoning: 8000 };
    const at = (completion, reasoning) => createBudgetCut({ budgetCredits: 8, sale, inputTokens: 0 }).onChunk({ completion_tokens: completion, reasoning_tokens: reasoning });
    expect(at(999, 999)).toBe("continue");
    expect(at(1000, 1000)).toBe("cut");
    // the same count as plain output costs 4 credits, half the budget
    expect(at(1000, 0)).toBe("continue");
  });
  it("exposes the running cost", () => {
    const cut = createBudgetCut({ budgetCredits: 100, sale: SALE, inputTokens: 250_000 });
    cut.onChunk({ completion_tokens: 0 });
    expect(cut.cost()).toBe(250);
  });
});

describe("createBudgetStream (openai)", () => {
  it("cuts a stream that would produce 5,000 tokens at a 1,000-token budget, ending with finish_reason length", async () => {
    const ctx = { credits: 4, holdId: "h9", sale: SALE, inputTokens: 0, spent: 0, format: "openai" };
    // ~3 chars per estimated token; 5,000 tokens ≈ 15,000 chars in 50 chunks
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push(chunk("x".repeat(300)));
    lines.push(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 5000 } })}\n\n`);
    lines.push("data: [DONE]\n\n");

    const out = await readAll(sseResponse(lines).pipeThrough(createBudgetStream(ctx)));
    const parsed = dataLines(out);
    const last = parsed[parsed.length - 1];
    expect(last.choices[0].finish_reason).toBe("length");
    expect(last.wavebot_hold_id).toBe("h9");
    expect(last.wavebot_cost_credits).toBeLessThanOrEqual(4);
    expect(last.wavebot_cost_credits).toBeGreaterThan(0);
    // far fewer than 50 content chunks reached the client
    expect(parsed.filter((p) => p.choices?.[0]?.delta?.content).length).toBeLessThan(20);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(ctx.spent).toBe(last.wavebot_cost_credits);
  });

  it("a stream under budget passes untouched and its final chunk carries the cost and hold id", async () => {
    const ctx = { credits: 100, holdId: "h1", sale: SALE, inputTokens: 0, spent: 0, format: "openai" };
    const lines = [
      chunk("hello"),
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 502_000, completion_tokens: 250_000 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const out = await readAll(sseResponse(lines).pipeThrough(createBudgetStream(ctx)));
    const parsed = dataLines(out);
    const last = parsed[parsed.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    // (502k incl. the router's 2k buffer) 500k*1000/1M + 250k*4000/1M = 500 + 1000, exceeds the 100 budget but upstream
    // already finished: the real cost is reported, capped never below what was consumed
    expect(last.wavebot_cost_credits).toBe(1500);
    expect(last.wavebot_hold_id).toBe("h1");
    expect(out).toContain("hello");
  });

  it("an error-only or empty stream reports zero cost", async () => {
    const ctx = { credits: 10, holdId: "h2", sale: SALE, inputTokens: 0, spent: 0, format: "openai" };
    const out = await readAll(sseResponse(["data: [DONE]\n\n"]).pipeThrough(createBudgetStream(ctx)));
    expect(ctx.spent).toBe(0);
    expect(out).toContain("[DONE]");
  });
});

describe("createBudgetStream (claude)", () => {
  it("cuts with stop_reason max_tokens and ends with message_stop", async () => {
    const ctx = { credits: 4, holdId: "hc", sale: SALE, inputTokens: 0, spent: 0, format: "claude" };
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const lines = [ev("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } })];
    for (let i = 0; i < 50; i++) lines.push(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x".repeat(300) } }));
    lines.push(ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5000 } }));
    lines.push(ev("message_stop", {}));
    const out = await readAll(sseResponse(lines).pipeThrough(createBudgetStream(ctx)));
    expect(out).toContain('"stop_reason":"max_tokens"');
    expect(out.trimEnd().endsWith("}")).toBe(true);
    expect(out).toContain('"type":"message_stop"');
    expect(out).toContain("wavebot_cost_credits");
    expect(ctx.spent).toBeLessThanOrEqual(4);
  });
});

describe("attachCostHeaders (non-stream)", () => {
  it("adds x-wavebot-cost-credits and the hold id, and records the spend", async () => {
    const ctx = { credits: 100, holdId: "hn", sale: SALE, inputTokens: 0, spent: 0, format: "openai" };
    const res = new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 102_000, completion_tokens: 10_000 } }), {
      headers: { "content-type": "application/json" },
    });
    const out = await attachCostHeaders(res, ctx);
    // (102k incl. the 2k router buffer) 100k*1000/1M + 10k*4000/1M = 100 + 40
    expect(out.headers.get("x-wavebot-cost-credits")).toBe("140");
    expect(out.headers.get("x-wavebot-hold-id")).toBe("hn");
    expect(await out.json()).toMatchObject({ usage: { prompt_tokens: 102_000 } });
    expect(ctx.spent).toBe(140);
  });
  it("leaves a non-JSON or error response alone", async () => {
    const ctx = { credits: 1, holdId: "hn", sale: SALE, inputTokens: 0, spent: 0, format: "openai" };
    const res = new Response("nope", { status: 500 });
    const out = await attachCostHeaders(res, ctx);
    expect(out.headers.get("x-wavebot-cost-credits")).toBe("0");
    expect(await out.text()).toBe("nope");
  });
});
