/**
 * The ids of the providers that carry an image adapter — as PLAIN DATA, with no
 * imports. This is the client's copy of the adapter map's key set: the browser
 * bundle needs "is this provider an image adapter at all" (the capability
 * gate's first check) but must never import the adapters themselves, because
 * their executor graph is node-only and breaks `next build` (measured 2026-11-24:
 * the build fails through executors/index.js when ModelSelectModal pulls the
 * adapter index).
 *
 * The unit test `image-capability.test.js :: adapterIds matches the real adapter
 * map` pins this list to `Object.keys(ADAPTERS)` — add the id to BOTH places,
 * or the picker and the server gate will disagree about a provider.
 */
export const IMAGE_ADAPTER_IDS = Object.freeze(new Set([
  "openai",
  "minimax",
  "openrouter",
  "recraft",
  "vercel-ai-gateway",
  "xai",
  "sensenova",
  "sensenova-intl",
  "gemini",
  "codex",
  "sdwebui",
  "comfyui",
  "huggingface",
  "nanobanana",
  "antigravity",
  "fal-ai",
  "stability-ai",
  "black-forest-labs",
  "runwayml",
  "cloudflare-ai",
  "muse-web",
  "chatgpt-web",
  "gemini-web",
  "grok-web",
  "veoaifree-web",
  "uc-web",
]));
