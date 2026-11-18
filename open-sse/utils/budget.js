// Fork patch #26: spend ceiling for WaveBot hold-and-cap (spec §4).
// quote -> reserve -> call with x-wavebot-budget-credits + x-wavebot-hold-id ->
// clamp max tokens, cut the stream at the budget, report the cost.
// Sale prices are credits per 1M tokens; a call's cost is rounded UP to whole credits.
import { canonicalizeUsage, BUFFER_TOKENS } from "./usageTracking.js";
import { priceForPrompt, priceForReserve } from "./priceTiers.js";

export const BUDGET_HEADER = "x-wavebot-budget-credits";
export const HOLD_HEADER = "x-wavebot-hold-id";
export const COST_HEADER = "x-wavebot-cost-credits";

const PER_MILLION = 1_000_000;
const ASCII_TOKENS_PER_CHAR = 1 / 3;
const NON_ASCII_TOKENS_PER_CHAR = 1;
const INPUT_SAFETY = 1.2;
const BASE64_MIN_RUN = 2000;
const BASE64_MARKERS = ["base64,", '"data":"'];
const IMAGE_PLACEHOLDER_TOKENS = 1500;
const EFFORT_ALLOWANCE = { minimal: 512, low: 1024, medium: 4096, high: 16384 };

// The hold id is client-supplied: it lands in a response header and a DB column, so keep it small and plain.
const HOLD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BUDGET_CREDITS = 1e12;

export class BudgetClampUnsupported extends Error {
  constructor(format) {
    super(`Cannot enforce a spend ceiling on ${format} requests`);
    this.name = "BudgetClampUnsupported";
    this.format = format;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? null;
}

export function parseBudget(headers) {
  const raw = headerValue(headers, BUDGET_HEADER);
  const holdId = headerValue(headers, HOLD_HEADER);
  if (raw == null || !holdId || !HOLD_ID_PATTERN.test(String(holdId))) return null;
  const credits = Number(raw);
  if (!Number.isFinite(credits) || credits < 0 || credits > MAX_BUDGET_CREDITS) return null;
  return { credits, holdId: String(holdId) };
}

// ---- pricing ---------------------------------------------------------------

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const canon = canonicalizeUsage(usage);
  if (!canon) return null;
  const nested = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0);
  if (!canon.reasoning_tokens && nested > 0) canon.reasoning_tokens = nested;
  return canon;
}

// A request whose prompt crosses a tier threshold bills every token at that tier (see priceForPrompt).
function rawCost(usage, saleRow) {
  const u = normalizeUsage(usage);
  if (!u) return 0;
  const sale = priceForPrompt(saleRow, u.prompt_tokens || 0);
  const cached = u.cached_tokens || 0;
  const created = u.cache_creation_input_tokens || 0;
  const reasoning = Math.min(u.reasoning_tokens || 0, u.completion_tokens || 0);
  const uncached = Math.max(0, (u.prompt_tokens || 0) - cached - created);
  const output = Math.max(0, (u.completion_tokens || 0) - reasoning);
  return (
    uncached * (sale.input ?? 0) +
    cached * (sale.cached ?? sale.input ?? 0) +
    created * (sale.cacheCreation ?? sale.input ?? 0) +
    output * (sale.output ?? 0) +
    reasoning * (sale.reasoning ?? sale.output ?? 0)
  ) / PER_MILLION;
}

const roundUp = (x) => Math.max(0, Math.ceil(x - 1e-9));

export function actualCostCredits(usage, sale) {
  return roundUp(rawCost(usage, sale));
}

export function maxTokensForBudget(credits, saleRow, inputTokens, reasoningAllowance) {
  const sale = priceForReserve(saleRow, inputTokens);
  const remaining = credits
    - (inputTokens * (sale.input ?? 0)) / PER_MILLION
    - (reasoningAllowance * (sale.reasoning ?? sale.output ?? 0)) / PER_MILLION;
  if (remaining <= 0) return 0;
  const rate = sale.output ?? 0;
  if (rate <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((remaining * PER_MILLION) / rate + 1e-9));
}

// ---- estimates -------------------------------------------------------------

export function tokensForText(text) {
  let weight = 0;
  for (let i = 0; i < text.length; i++) {
    weight += text.charCodeAt(i) < 128 ? ASCII_TOKENS_PER_CHAR : NON_ASCII_TOKENS_PER_CHAR;
  }
  return Math.ceil(weight - 1e-9);
}

const isB64Char = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;

// Only a long run that follows an explicit base64 marker is an attachment; any other long string is
// text and is priced as text. Linear scan, no regex backtracking on attacker-sized input.
function stripBase64Runs(json) {
  let out = "";
  let from = 0;
  let images = 0;
  for (;;) {
    let hit = -1;
    let markerLen = 0;
    for (const m of BASE64_MARKERS) {
      const i = json.indexOf(m, from);
      if (i !== -1 && (hit === -1 || i < hit)) {
        hit = i;
        markerLen = m.length;
      }
    }
    if (hit === -1) break;
    const start = hit + markerLen;
    let end = start;
    while (end < json.length && isB64Char(json.charCodeAt(end))) end++;
    if (end - start >= BASE64_MIN_RUN) {
      out += json.slice(from, start);
      images++;
      from = end;
    } else {
      out += json.slice(from, Math.max(start, end));
      from = Math.max(start, end);
    }
  }
  return { text: out + json.slice(from), images };
}

export function estimateInputTokens(body) {
  let json;
  try {
    json = JSON.stringify(body) || "";
  } catch {
    json = "";
  }
  const stripped = stripBase64Runs(json);
  json = stripped.text;
  const images = stripped.images;
  return Math.ceil(tokensForText(json) * INPUT_SAFETY) + images * IMAGE_PLACEHOLDER_TOKENS;
}

export function reasoningAllowanceFor(body) {
  if (!body || typeof body !== "object") return 0;
  const thinking = body.thinking?.budget_tokens ?? body.generationConfig?.thinkingConfig?.thinkingBudget
    ?? body.request?.generationConfig?.thinkingConfig?.thinkingBudget;
  if (Number.isFinite(Number(thinking)) && Number(thinking) > 0) return Number(thinking);
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  return EFFORT_ALLOWANCE[effort] ?? 0;
}

// ---- clamp -----------------------------------------------------------------

const lower = (current, n) => (Number.isFinite(Number(current)) && Number(current) > 0 ? Math.min(Number(current), n) : n);

function clampGenerationConfig(holder, n) {
  const gc = { ...(holder.generationConfig || {}) };
  gc.maxOutputTokens = lower(gc.maxOutputTokens, n);
  return { ...holder, generationConfig: gc };
}

/** Returns a copy of `body` whose output cap is at most `n` tokens; throws for formats it cannot cap. */
export function clampOutputTokens(body, format, n) {
  switch (format) {
    case "openai": {
      const out = { ...body };
      const hasCompletion = out.max_completion_tokens != null;
      const hasMax = out.max_tokens != null;
      if (hasCompletion) out.max_completion_tokens = lower(out.max_completion_tokens, n);
      if (hasMax || !hasCompletion) out.max_tokens = lower(out.max_tokens, n);
      return out;
    }
    case "claude":
      return { ...body, max_tokens: lower(body.max_tokens, n) };
    case "openai-responses":
    case "openai-response":
      return { ...body, max_output_tokens: lower(body.max_output_tokens, n) };
    case "gemini":
    case "vertex":
      return clampGenerationConfig(body, n);
    case "gemini-cli":
    case "antigravity":
      return { ...body, request: clampGenerationConfig(body.request || {}, n) };
    case "ollama":
      return { ...body, options: { ...(body.options || {}), num_predict: lower(body.options?.num_predict, n) } };
    default:
      throw new BudgetClampUnsupported(format);
  }
}

// ---- gate ------------------------------------------------------------------

const REFUSALS = {
  budget_required: "A spend budget is required for this request",
  not_sellable: "This model has no sale price and cannot be used",
  ai_credit_exhausted: "AI credit exhausted",
};

/** enforce=true: every call must carry a budget. A budget that IS present is always honored. */
export async function gateBudget({ headers, model, enforce, getSale }) {
  const budget = parseBudget(headers);
  if (!budget) {
    if (enforce) return { ok: false, status: 402, code: "budget_required", message: REFUSALS.budget_required };
    return { ok: true, ctx: null };
  }
  const sale = await getSale(model);
  if (!sale) return { ok: false, status: 402, code: "not_sellable", message: REFUSALS.not_sellable };
  if (budget.credits <= 0) return { ok: false, status: 402, code: "ai_credit_exhausted", message: REFUSALS.ai_credit_exhausted };
  return { ok: true, ctx: { credits: budget.credits, holdId: budget.holdId, sale, spent: 0 } };
}

export function budgetRefusalResponse(r) {
  return new Response(JSON.stringify({ error: { message: r.message, type: "billing_error", code: r.code } }), {
    status: r.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ---- stream cut ------------------------------------------------------------

/** Running-cost tracker. onChunk takes cumulative counts and says whether the budget is reached. */
export function createBudgetCut({ budgetCredits, sale, inputTokens }) {
  let last = { prompt_tokens: inputTokens || 0, completion_tokens: 0 };
  // Until the provider reports a prompt count, only the estimate is known, so price it at the reserve tier.
  let reported = false;
  const priced = () => rawCost(last, reported ? sale : priceForReserve(sale, inputTokens || 0));
  return {
    onChunk(counts) {
      reported = counts?.prompt_tokens != null;
      last = { prompt_tokens: inputTokens || 0, completion_tokens: 0, ...counts };
      return priced() >= budgetCredits ? "cut" : "continue";
    },
    cost: () => roundUp(priced()),
  };
}

const sse = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

// The client-facing usage carries the router's context-safety buffer (addBufferToUsage) on the input
// side; the customer is billed for the tokens the provider reported, so take the buffer back out.
// Gemini-shaped usage is never buffered.
const UNBUFFERED_FORMATS = new Set(["gemini", "gemini-cli", "vertex", "antigravity"]);
function withoutBuffer(usage, format) {
  if (!usage || typeof usage !== "object" || UNBUFFERED_FORMATS.has(format)) return usage;
  const out = { ...usage };
  for (const k of ["prompt_tokens", "input_tokens"]) {
    if (Number.isFinite(out[k])) out[k] = Math.max(0, out[k] - BUFFER_TOKENS);
  }
  return out;
}

const usageOf = (u) => (u && typeof u === "object" ? u : {});

// One adapter per client-facing stream format. parse() -> what an event carries;
// augment() stamps cost fields onto a held final event; cutEvents() ends the stream early.
const ADAPTERS = {
  openai: {
    parse(d) {
      const ch = d.choices?.[0];
      const delta = ch?.delta || {};
      const args = (delta.tool_calls || []).map((t) => t?.function?.arguments || "").join("");
      return {
        text: (typeof delta.content === "string" ? delta.content : "") + args,
        reasoning: delta.reasoning_content || delta.reasoning || "",
        usage: d.usage,
        final: ch?.finish_reason != null || d.usage != null,
        meta: { id: d.id, model: d.model, created: d.created },
      };
    },
    augment: (d, f) => ({ ...d, ...f }),
    cutEvents(meta, f, outTokens) {
      return sse({
        ...meta, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: f.inputTokens, completion_tokens: outTokens, total_tokens: f.inputTokens + outTokens },
        wavebot_cost_credits: f.wavebot_cost_credits, wavebot_hold_id: f.wavebot_hold_id,
      }) + sse("[DONE]");
    },
    costOnlyEvent: (meta, f) => sse({ ...meta, object: "chat.completion.chunk", choices: [], ...f.fields }),
    doneMarker: true,
  },
  claude: {
    parse(d) {
      const t = d.type;
      const delta = d.delta || {};
      return {
        text: t === "content_block_delta" ? (delta.text || delta.partial_json || "") : "",
        reasoning: t === "content_block_delta" ? (delta.thinking || "") : "",
        usage: t === "message_start" ? d.message?.usage : t === "message_delta" ? d.usage : undefined,
        merge: true,
        final: t === "message_delta",
        stop: t === "message_stop",
        index: t === "content_block_start" || t === "content_block_delta" ? d.index : undefined,
        meta: {},
      };
    },
    augment: (d, f) => ({ ...d, ...f }),
    cutEvents(meta, f, outTokens, state) {
      const stop = state.openBlock != null ? sse({ type: "content_block_stop", index: state.openBlock }, "content_block_stop") : "";
      return stop
        + sse({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: outTokens }, ...f.fields }, "message_delta")
        + sse({ type: "message_stop" }, "message_stop");
    },
  },
  "openai-responses": {
    parse(d) {
      const t = d.type || "";
      return {
        text: t === "response.output_text.delta" || t === "response.function_call_arguments.delta" ? (d.delta || "") : "",
        reasoning: t.startsWith("response.reasoning") && t.endsWith(".delta") ? (d.delta || "") : "",
        usage: t === "response.completed" || t === "response.incomplete" ? d.response?.usage : undefined,
        final: t === "response.completed" || t === "response.incomplete",
        meta: {},
      };
    },
    augment: (d, f) => ({ ...d, ...f }),
    cutEvents(meta, f, outTokens) {
      return sse({
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: f.inputTokens, output_tokens: outTokens, total_tokens: f.inputTokens + outTokens } },
        ...f.fields,
      }, "response.incomplete");
    },
  },
  gemini: {
    parse(d) {
      const cand = d.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const um = d.usageMetadata;
      return {
        text: parts.filter((p) => !p.thought).map((p) => p.text || "").join(""),
        reasoning: parts.filter((p) => p.thought).map((p) => p.text || "").join(""),
        usage: um && {
          prompt_tokens: um.promptTokenCount, cached_tokens: um.cachedContentTokenCount || 0,
          completion_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0), reasoning_tokens: um.thoughtsTokenCount || 0,
        },
        final: cand?.finishReason != null || um != null,
        meta: {},
      };
    },
    augment: (d, f) => ({ ...d, ...f }),
    cutEvents(meta, f, outTokens) {
      return sse({
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "MAX_TOKENS", index: 0 }],
        usageMetadata: { promptTokenCount: f.inputTokens, candidatesTokenCount: outTokens, totalTokenCount: f.inputTokens + outTokens },
        ...f.fields,
      });
    },
  },
};
ADAPTERS["openai-response"] = ADAPTERS["openai-responses"];

export const budgetFormatSupported = (format) => !!ADAPTERS[format];

function parseEvent(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

function usageFields(ctx, cost) {
  return { wavebot_cost_credits: cost, wavebot_hold_id: ctx.holdId };
}

/**
 * Transform over the client-facing SSE bytes. Counts visible tokens, cuts when the budget is
 * reached (dropping the crossing event), and stamps the final event with the cost and hold id.
 */
export function createBudgetStream(ctx) {
  const adapter = ADAPTERS[ctx.format] || ADAPTERS.openai;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const base = ctx.spent || 0;
  const remaining = Math.max(0, ctx.credits - base);
  const inputTokens = ctx.inputTokens || 0;
  const cut = createBudgetCut({ budgetCredits: remaining, sale: ctx.sale, inputTokens });

  let buffer = "";
  let textChars = 0;
  let reasoningChars = 0;
  let usage = null;
  let meta = {};
  let held = null; // { raw, event, data }
  let done = false;
  const state = { openBlock: null };

  const counts = () => {
    const reasoning = Math.ceil(reasoningChars / 3);
    return { completion_tokens: Math.ceil((textChars + reasoningChars) / 3), reasoning_tokens: reasoning };
  };

  const settle = () => {
    const attempt = usage ? actualCostCredits(withoutBuffer(usage, ctx.format), ctx.sale) : cut.cost();
    ctx.spent = base + attempt;
    return ctx.spent;
  };

  const emit = (controller, text) => controller.enqueue(encoder.encode(text));

  const releaseHeld = (controller) => {
    if (!held) return false;
    const cost = settle();
    const fields = usageFields(ctx, cost);
    const out = held.data && held.data !== "[DONE]"
      ? sse(adapter.augment(JSON.parse(held.data), fields), held.event)
      : held.raw + "\n\n";
    emit(controller, out);
    held = null;
    return true;
  };

  const doCut = (controller) => {
    const outTokens = counts().completion_tokens;
    const attempt = Math.min(cut.cost(), Math.ceil(remaining));
    ctx.spent = base + attempt;
    const f = { inputTokens, wavebot_cost_credits: ctx.spent, wavebot_hold_id: ctx.holdId, fields: usageFields(ctx, ctx.spent) };
    emit(controller, adapter.cutEvents(meta, f, outTokens, state));
    done = true;
    try {
      ctx.onCut?.({ attemptCost: attempt, usage: { prompt_tokens: inputTokens, ...counts() } });
      ctx.abort?.();
    } finally {
      ctx.onDone?.();
      controller.terminate();
    }
  };

  const handleEvent = (controller, raw) => {
    if (done) return;
    const { event, data } = parseEvent(raw);
    if (data === "[DONE]") {
      if (!releaseHeld(controller)) {
        const cost = settle();
        if (adapter.costOnlyEvent) emit(controller, adapter.costOnlyEvent(meta, { fields: usageFields(ctx, cost) }));
      }
      emit(controller, raw + "\n\n");
      return;
    }
    let parsed;
    try {
      parsed = data ? JSON.parse(data) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      emit(controller, raw + "\n\n");
      return;
    }
    const p = adapter.parse(parsed);
    if (p.meta) meta = { ...meta, ...Object.fromEntries(Object.entries(p.meta).filter(([, v]) => v != null)) };
    if (p.index !== undefined) state.openBlock = p.index;
    if (p.usage) usage = p.merge ? { ...usageOf(usage), ...p.usage } : p.usage;

    if (p.stop) {
      releaseHeld(controller);
      emit(controller, raw + "\n\n");
      return;
    }
    if (held) releaseHeld(controller);

    if (p.final) {
      held = { raw, event, data };
      return;
    }
    if (p.text || p.reasoning) {
      textChars += (p.text ? tokensForText(p.text) * 3 : 0);
      reasoningChars += (p.reasoning ? tokensForText(p.reasoning) * 3 : 0);
      if (cut.onChunk(counts()) === "cut") {
        doCut(controller);
        return;
      }
    }
    emit(controller, raw + "\n\n");
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      buffer += decoder.decode(chunk, { stream: true });
      let m;
      while (!done && (m = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (raw.trim()) handleEvent(controller, raw);
      }
    },
    flush(controller) {
      if (done) return;
      if (buffer.trim()) handleEvent(controller, buffer);
      if (!releaseHeld(controller)) settle();
      ctx.onDone?.();
    },
  });
}

// ---- non-stream cost -------------------------------------------------------

function usageFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (body.usageMetadata) return ADAPTERS.gemini.parse({ usageMetadata: body.usageMetadata }).usage;
  return body.usage || null;
}

/** Stamps the cost and hold id on a non-stream response; the body is passed through untouched. */
export async function attachCostHeaders(res, ctx) {
  let text = null;
  let attempt = 0;
  const type = res.headers.get("content-type") || "";
  if (res.ok && type.includes("json")) {
    text = await res.text();
    try {
      const usage = usageFromBody(JSON.parse(text));
      if (usage) attempt = actualCostCredits(withoutBuffer(usage, ctx.format), ctx.sale);
    } catch {
      attempt = 0;
    }
  }
  ctx.spent = (ctx.spent || 0) + attempt;
  const headers = new Headers(res.headers);
  headers.set(COST_HEADER, String(ctx.spent));
  headers.set(HOLD_HEADER, ctx.holdId);
  return new Response(text ?? res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---- request-scoped context ------------------------------------------------

const contexts = new WeakMap();
export const setBudgetCtx = (request, ctx) => { if (request && ctx) contexts.set(request, ctx); };
export const getBudgetCtx = (request) => (request ? contexts.get(request) || null : null);

/** Per-attempt usage fields for saveRequestUsage. `attempt.saved` makes the save once-only. */
export function budgetUsageFields(tokens, attempt, costOverride) {
  if (!attempt || attempt.saved) return null;
  attempt.saved = true;
  const cost = costOverride ?? actualCostCredits(tokens, attempt.sale);
  return { holdId: attempt.holdId, costCredits: String(cost) };
}

/**
 * Open an attempt against the request's budget. Parallel legs (fanout/fusion) each reserve what is
 * still unreserved, so the sum of live attempts can never exceed the hold; a leg that finds nothing
 * left is refused. release() is idempotent and folds the attempt's spend back into the parent.
 */
export function openAttempt(parent, { format, inputTokens }) {
  const base = parent.spent || 0;
  const available = parent.credits - base - (parent.reserved || 0);
  if (available <= 0) return null;
  parent.reserved = (parent.reserved || 0) + available;
  const attempt = {
    credits: base + available, holdId: parent.holdId, sale: parent.sale,
    spent: base, format, inputTokens, saved: false, released: false,
  };
  attempt.release = () => {
    if (attempt.released) return;
    attempt.released = true;
    parent.reserved = Math.max(0, (parent.reserved || 0) - available);
    parent.spent = Math.max(parent.spent || 0, attempt.spent);
  };
  return attempt;
}

/** Fits the request body to the attempt: returns {body} or {refusal:{status,code,message}}. */
export function fitBodyToAttempt(body, targetFormat, attempt) {
  const remaining = attempt.credits - attempt.spent;
  const n = maxTokensForBudget(remaining, attempt.sale, attempt.inputTokens, reasoningAllowanceFor(body));
  if (n <= 0) return { refusal: { status: 402, code: "ai_credit_exhausted", message: REFUSALS.ai_credit_exhausted } };
  try {
    return { body: clampOutputTokens(body, targetFormat, n) };
  } catch (e) {
    if (e instanceof BudgetClampUnsupported) {
      return { refusal: { status: 400, code: "budget_unsupported_format", message: e.message } };
    }
    throw e;
  }
}
