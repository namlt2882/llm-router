import { describe, expect, it } from "vitest";
import {
  parseBudget,
  maxTokensForBudget,
  clampOutputTokens,
  BudgetClampUnsupported,
  actualCostCredits,
  estimateInputTokens,
  reasoningAllowanceFor,
  gateBudget,
  openAttempt,
  fitBodyToAttempt,
} from "../../open-sse/utils/budget.js";

// Sale prices are credits per 1M tokens.
const SALE = { input: 1000, output: 4000, cached: 100, reasoning: 4000, cacheCreation: 1250, perImage: 0 };

describe("parseBudget", () => {
  it("reads both headers from a Headers object", () => {
    const h = new Headers({ "x-wavebot-budget-credits": "1500", "x-wavebot-hold-id": "hold-1" });
    expect(parseBudget(h)).toEqual({ credits: 1500, holdId: "hold-1" });
  });
  it("reads a plain lower-case object", () => {
    expect(parseBudget({ "x-wavebot-budget-credits": "7", "x-wavebot-hold-id": "h" })).toEqual({ credits: 7, holdId: "h" });
  });
  it("returns null when either header is missing or the number is junk", () => {
    expect(parseBudget(new Headers({ "x-wavebot-budget-credits": "10" }))).toBeNull();
    expect(parseBudget(new Headers({ "x-wavebot-hold-id": "h" }))).toBeNull();
    expect(parseBudget(new Headers({ "x-wavebot-budget-credits": "abc", "x-wavebot-hold-id": "h" }))).toBeNull();
    expect(parseBudget(new Headers({ "x-wavebot-budget-credits": "-5", "x-wavebot-hold-id": "h" }))).toBeNull();
  });
  it("rejects a hold id that is oversized or carries header-unsafe characters, and absurd budgets", () => {
    expect(parseBudget(new Headers({ "x-wavebot-budget-credits": "5", "x-wavebot-hold-id": "a".repeat(129) }))).toBeNull();
    expect(parseBudget({ "x-wavebot-budget-credits": "5", "x-wavebot-hold-id": "h\r\nX-Evil: 1" })).toBeNull();
    expect(parseBudget({ "x-wavebot-budget-credits": "1e99", "x-wavebot-hold-id": "h" })).toBeNull();
  });
});

describe("maxTokensForBudget", () => {
  it("a budget worth 1,000 output tokens clamps to at most 1,000", () => {
    // 1000 output tokens at 4000/1M = 4 credits; input 0
    expect(maxTokensForBudget(4, SALE, 0, 0)).toBeLessThanOrEqual(1000);
    expect(maxTokensForBudget(4, SALE, 0, 0)).toBe(1000);
  });
  it("subtracts the input pass", () => {
    // 1,000,000 input tokens cost 1000 credits; 1004 leaves 4 credits of output
    expect(maxTokensForBudget(1004, SALE, 1_000_000, 0)).toBe(1000);
  });
  it("subtracts the reasoning allowance", () => {
    // 1000 reasoning tokens at 4000/1M = 4 credits taken off a 8-credit budget
    expect(maxTokensForBudget(8, SALE, 0, 1000)).toBe(1000);
  });
  it("is 0 when the budget cannot pay for the input", () => {
    expect(maxTokensForBudget(1, SALE, 1_000_000, 0)).toBe(0);
    expect(maxTokensForBudget(0, SALE, 0, 0)).toBe(0);
  });
  it("never lets ceil(cost) exceed an integer budget", () => {
    const n = maxTokensForBudget(3, SALE, 333, 0);
    expect(actualCostCredits({ prompt_tokens: 333, completion_tokens: n }, SALE)).toBeLessThanOrEqual(3);
  });
});

describe("clampOutputTokens", () => {
  it("openai: lowers max_tokens", () => {
    const out = clampOutputTokens({ model: "m", max_tokens: 9000, messages: [] }, "openai", 1000);
    expect(out.max_tokens).toBe(1000);
  });
  it("openai: sets max_tokens when the client sent no cap", () => {
    expect(clampOutputTokens({ messages: [] }, "openai", 1000).max_tokens).toBe(1000);
  });
  it("openai: lowers max_completion_tokens and does not add the other field", () => {
    const out = clampOutputTokens({ max_completion_tokens: 9000 }, "openai", 1000);
    expect(out.max_completion_tokens).toBe(1000);
    expect(out.max_tokens).toBeUndefined();
  });
  it("never raises a cap the client already set lower", () => {
    expect(clampOutputTokens({ max_tokens: 200 }, "openai", 1000).max_tokens).toBe(200);
  });
  it("claude: max_tokens", () => {
    expect(clampOutputTokens({ max_tokens: 64000 }, "claude", 1000).max_tokens).toBe(1000);
  });
  it("responses: max_output_tokens", () => {
    expect(clampOutputTokens({ input: [] }, "openai-responses", 1000).max_output_tokens).toBe(1000);
  });
  it("gemini: generationConfig.maxOutputTokens, also under request", () => {
    expect(clampOutputTokens({ contents: [] }, "gemini", 1000).generationConfig.maxOutputTokens).toBe(1000);
    expect(clampOutputTokens({ request: { contents: [] } }, "antigravity", 1000).request.generationConfig.maxOutputTokens).toBe(1000);
  });
  it("refuses a format it cannot clamp (fail closed)", () => {
    expect(() => clampOutputTokens({}, "kiro", 1000)).toThrow(BudgetClampUnsupported);
    expect(() => clampOutputTokens({}, "cursor", 1000)).toThrow(BudgetClampUnsupported);
  });
});

describe("cost and estimates", () => {
  it("rounds the cost of a call UP to whole credits", () => {
    expect(actualCostCredits({ prompt_tokens: 1, completion_tokens: 0 }, SALE)).toBe(1);
    expect(actualCostCredits({ prompt_tokens: 0, completion_tokens: 0 }, SALE)).toBe(0);
  });
  it("prices cached input at the cached rate and reasoning at the reasoning rate", () => {
    const usage = { prompt_tokens: 1_000_000, cached_tokens: 500_000, completion_tokens: 1_000_000, reasoning_tokens: 250_000 };
    // 500k input*1000 + 500k cached*100 + 750k output*4000 + 250k reasoning*4000 (credits per 1M)
    expect(actualCostCredits(usage, SALE)).toBe(500 + 50 + 3000 + 1000);
  });
  it("estimateInputTokens is conservative (chars/3 * 1.2, rounded up)", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(3000) }] };
    expect(estimateInputTokens(body)).toBeGreaterThanOrEqual(1200);
  });
  it("an image data URL counts as a flat placeholder, not as text", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(500_000) } }] }] };
    expect(estimateInputTokens(body)).toBeLessThan(3000);
  });
  it("a long run of plain letters is text, never a free image (cannot dodge the input estimate)", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(300_000) }] };
    expect(estimateInputTokens(body)).toBeGreaterThanOrEqual(120_000);
  });
  it("reasoningAllowanceFor reads thinking budget and effort", () => {
    expect(reasoningAllowanceFor({ thinking: { type: "enabled", budget_tokens: 5000 } })).toBe(5000);
    expect(reasoningAllowanceFor({ reasoning_effort: "high" })).toBeGreaterThan(reasoningAllowanceFor({ reasoning_effort: "low" }));
    expect(reasoningAllowanceFor({})).toBe(0);
  });
});

describe("gateBudget", () => {
  const withBudget = new Headers({ "x-wavebot-budget-credits": "100", "x-wavebot-hold-id": "h1" });
  const sale = async (name) => (name === "priced" ? SALE : null);

  it("system call without budget headers → 402 budget_required", async () => {
    const r = await gateBudget({ headers: new Headers(), model: "priced", enforce: true, getSale: sale });
    expect(r).toMatchObject({ ok: false, status: 402, code: "budget_required" });
  });
  it("unpriced model → 402 not_sellable", async () => {
    const r = await gateBudget({ headers: withBudget, model: "unpriced", enforce: true, getSale: sale });
    expect(r).toMatchObject({ ok: false, status: 402, code: "not_sellable" });
  });
  it("budget of 0 refuses with ai_credit_exhausted (same 402 shape)", async () => {
    const h = new Headers({ "x-wavebot-budget-credits": "0", "x-wavebot-hold-id": "h" });
    const r = await gateBudget({ headers: h, model: "priced", enforce: true, getSale: sale });
    expect(r).toMatchObject({ ok: false, status: 402, code: "ai_credit_exhausted" });
  });
  it("valid budget yields a context carrying the sale price and a spend counter", async () => {
    const r = await gateBudget({ headers: withBudget, model: "priced", enforce: true, getSale: sale });
    expect(r.ok).toBe(true);
    expect(r.ctx).toMatchObject({ credits: 100, holdId: "h1", sale: SALE, spent: 0 });
  });
  it("enforcement off and no headers → pass through with no context", async () => {
    const r = await gateBudget({ headers: new Headers(), model: "unpriced", enforce: false, getSale: sale });
    expect(r).toEqual({ ok: true, ctx: null });
  });
  it("a budget present is honored even when enforcement is off", async () => {
    const r = await gateBudget({ headers: withBudget, model: "priced", enforce: false, getSale: sale });
    expect(r.ok).toBe(true);
    expect(r.ctx.credits).toBe(100);
  });
});

describe("attempts against one hold", () => {
  const parent = () => ({ credits: 100, holdId: "h", sale: SALE, spent: 0 });
  it("parallel legs cannot reserve more than the hold: the second finds nothing left", () => {
    const p = parent();
    const a = openAttempt(p, { format: "openai", inputTokens: 0 });
    expect(a.credits).toBe(100);
    expect(openAttempt(p, { format: "openai", inputTokens: 0 })).toBeNull();
    a.spent = 40;
    a.release();
    expect(p.spent).toBe(40);
    const b = openAttempt(p, { format: "openai", inputTokens: 0 });
    expect(b.credits - b.spent).toBe(60);
  });
  it("release is idempotent", () => {
    const p = parent();
    const a = openAttempt(p, { format: "openai", inputTokens: 0 });
    a.spent = 10;
    a.release();
    a.release();
    expect(p.spent).toBe(10);
    expect(p.reserved).toBe(0);
  });
  it("fitBodyToAttempt clamps, and refuses when the input alone exhausts the budget or the format cannot be clamped", () => {
    const a = { credits: 4, spent: 0, sale: SALE, inputTokens: 0 };
    expect(fitBodyToAttempt({ max_tokens: 9000 }, "openai", a).body.max_tokens).toBe(1000);
    expect(fitBodyToAttempt({}, "openai", { ...a, inputTokens: 1_000_000 }).refusal).toMatchObject({ status: 402, code: "ai_credit_exhausted" });
    expect(fitBodyToAttempt({}, "kiro", a).refusal).toMatchObject({ status: 400, code: "budget_unsupported_format" });
  });
});
