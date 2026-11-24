import { IMAGE_ADAPTER_IDS } from "../handlers/imageProviders/adapterIds.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";

/**
 * Can this exact model generate images? A model is image-capable when its
 * provider has an image adapter AND the registry says so:
 *
 * - No adapter -> NO. `serviceKinds` is not the authority: venice declares image
 *   rows with no adapter, topaz declares the service kind and no models, and both
 *   answer "does not support image generation" at request time.
 * - Provider publishes NO model list -> YES. Measured 2026-11-24, exactly ONE
 *   adapter provider has no `PROVIDER_MODELS` key: `vercel-ai-gateway` (its
 *   catalogue is fetched live). There is nothing to check, and refusing it would
 *   break the live-catalogue lane.
 * - Row with kind:"image" -> YES.
 * - Any other row -> NO, and this includes a row with **no `kind`**: measured
 *   2026-11-24, every chat model on every adapter provider omits `kind`
 *   (openai/gpt-5.4, gemini/gemini-2.5-flash, xai/grok-4, ...). Treating "no kind"
 *   as capable would offer every text model in an image combo.
 * - No matching row in a list the provider DOES publish -> NO: absent from a
 *   published catalogue is "not a model here", not "not declared".
 * - `opts.acceptsImageModel(modelId)` -> YES: some adapters own an open id
 *   grammar the registry cannot enumerate (codex serves ANY base model through
 *   its `-image` suffix). The adapter — not a second registry — is the authority
 *   on that grammar; server callers supply the hook via
 *   `imageCapability.server.js`, client callers (which must not import the
 *   adapter graph — see adapterIds.js) leave it off.
 *
 * The row lookup MUST go through `PROVIDER_ID_TO_ALIAS`: `PROVIDER_MODELS` is keyed
 * `entry.alias || entry.id`, and providers whose alias differs from their id keep
 * NO rows under the id (`codex` -> `cx`, `veoaifree-web` -> `veo-free`,
 * `uc-web` -> `uc`). Looking up the bare id would drop each into the row-less arm.
 *
 * This file must stay CLIENT-SAFE: its only imports are plain data. The live
 * probe (POST /api/providers/[id]/image-check) is the evidence, this is the gate.
 */
export function isImageCapable(providerId, modelId, opts = {}) {
  if (!IMAGE_ADAPTER_IDS.has(providerId)) return false;
  const rows = PROVIDER_MODELS[PROVIDER_ID_TO_ALIAS[providerId] || providerId];
  if (!rows) return true;                       // live-fetched catalogue, nothing to check
  if (rows.some((m) => m.id === modelId && m.kind === "image")) return true;
  return opts.acceptsImageModel?.(modelId) === true;
}
