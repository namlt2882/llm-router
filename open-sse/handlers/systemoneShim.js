import { createErrorResult } from "../utils/error.js";
import { handleChatCore } from "./chatCore.js";

/**
 * The systemone shim: ask a TEXT model the systemone questions and validate
 * every answer before it reaches the caller. A systemone combo may list plain
 * text models; when the native systemone protocol has no protocol speaker for
 * one, the shim asks it once as a chat completion with a strict json_schema,
 * then re-derives the exact native answer shape from the reply. Schema in the
 * request is advice; the per-question checks below are the contract — a
 * missing, out-of-range or fabricated answer fails the whole member (502),
 * never a partial `answers`.
 */

const SCHEMA = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "object",
      additionalProperties: {
        oneOf: [
          { type: "object", required: ["noul"], properties: { noul: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false },
          { type: "object", required: ["choice", "confidence"], properties: { choice: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false },
          { type: "object", required: ["score", "confidence"], properties: { score: { type: "number" }, confidence: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false },
        ],
      },
    },
  },
};

const SYSTEM_PROMPT = `You answer a set of CLOSED questions about a conversation state. Reply with ONE JSON object and nothing else, exactly matching this schema:

${JSON.stringify(SCHEMA)}

Each entry of "answers" is keyed by the question name and must match the question's type: "noul" gives { "noul": <0..1> }, "choice" gives { "choice": "<one of the offered criteria keys>", "confidence": <0..1> }, "score" gives { "score": <number>, "confidence": <0..1> }. If you cannot answer a question, the correct output is { "answers": {} } — never a guess.`;

/**
 * Pull a JSON object out of a model reply: strip one leading ```json / trailing
 * ``` fence, else take the outermost balanced {…}. Null when no object exists.
 */
export function parseSystemoneJson(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) t = fenced[1].trim();
  const start = t.indexOf("{");
  if (start === -1) return null;
  // Walk to the matching close brace, honouring string literals.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(t.slice(start, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const inRange = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Validate a model's answers against the request's questions, in request order.
 * Extra keys are dropped; the validated entry echoes the question's `type`.
 * Every refusal names the reason with a `systemone-shim:` prefix.
 */
export function validateSystemoneAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { ok: false, reason: "systemone-shim: reply carries no answers object" };
  }
  const validated = {};
  for (const [name, q] of Object.entries(questions || {})) {
    const a = answers[name];
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      return { ok: false, reason: `systemone-shim: missing answer for question "${name}"` };
    }
    if (q.type === "noul") {
      if (!inRange(a.noul)) return { ok: false, reason: `systemone-shim: "noul" out of range for question "${name}"` };
      validated[name] = { type: "noul", noul: a.noul };
    } else if (q.type === "choice") {
      const offered = Object.keys(q.criteria || {});
      if (typeof a.choice !== "string" || !offered.includes(a.choice)) {
        return { ok: false, reason: `systemone-shim: "choice" not offered for question "${name}"` };
      }
      if (!inRange(a.confidence)) return { ok: false, reason: `systemone-shim: "confidence" out of range for question "${name}"` };
      validated[name] = { type: "choice", choice: a.choice, confidence: a.confidence };
    } else if (q.type === "score") {
      if (!Number.isFinite(a.score)) return { ok: false, reason: `systemone-shim: "score" not a finite number for question "${name}"` };
      if (!inRange(a.confidence)) return { ok: false, reason: `systemone-shim: "confidence" out of range for question "${name}"` };
      validated[name] = { type: "score", score: a.score, confidence: a.confidence };
    } else {
      return { ok: false, reason: `systemone-shim: question "${name}" has unknown type "${q.type}"` };
    }
  }
  return { ok: true, answers: validated };
}

/** The native wire shape carries no `type` — that echo is validation-internal. */
const toWire = (validated) =>
  Object.fromEntries(Object.entries(validated).map(([name, a]) => {
    const { type, ...rest } = a;
    return [name, rest];
  }));

/**
 * Ask one text model the systemone questions through chatCore (which owns
 * format translation, response_format degradation, token refresh and usage
 * recording) and return the native answer shape, validated. Same contract as
 * handleSystemoneCore plus `usageRecorded: true` — chatCore already saved the
 * usage row, so the caller must not record it a second time.
 *
 * @param {object} options
 * @param {object} options.body - The incoming /v1/systemone request ({state, questions, …})
 * @param {{provider: string, model: string}} options.modelInfo
 * @param {object} options.credentials - The caller's refreshed credentials
 * @param {object} options.log
 * @param {Function} [options.handleChat] - Defaults to handleChatCore
 */
export async function handleSystemoneShim({ body, modelInfo, credentials, log, handleChat = handleChatCore }) {
  const { provider, model } = modelInfo;
  const fail = (reason) => {
    log?.warn?.("SYSTEMONE", `shim member ${provider}/${model}: ${reason}`);
    return createErrorResult(502, `systemone-shim: member ${provider}/${model} ${reason}`);
  };

  const questions = body?.questions || {};
  const chatBody = {
    model: `${provider}/${model}`,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${body?.state ?? ""}\n${JSON.stringify({ questions })}` },
    ],
    temperature: 0,
    max_tokens: 1024,
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: "systemone_answers", strict: true, schema: SCHEMA } },
  };

  const result = await handleChat({
    body: chatBody,
    modelInfo: { provider, model },
    credentials,
    log,
    sourceFormatOverride: "openai",
  });
  if (!result?.success) {
    return fail(`chatCore ${result?.status || 500} ${result?.error || ""}`.trim());
  }

  let payload;
  try {
    payload = await result.response.json();
  } catch {
    return fail("returned an unreadable reply");
  }
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseSystemoneJson(content);
  if (!parsed) return fail("returned no JSON object");

  const checked = validateSystemoneAnswers(questions, parsed.answers);
  if (!checked.ok) return fail(checked.reason.replace(/^systemone-shim: /, ""));

  const u = payload?.usage;
  const mapped = Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens)
    ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : undefined;
  return {
    success: true,
    usageRecorded: true,
    usage: mapped ? { prompt_tokens: mapped.input_tokens, completion_tokens: mapped.output_tokens } : null,
    response: new Response(JSON.stringify({ model: modelInfo.model, answers: toWire(checked.answers), ...(mapped ? { usage: mapped } : {}) }),
      { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }),
  };
}
