import { getImageAdapter } from "../handlers/imageProviders/index.js";
import { isImageCapable as isImageCapableCore } from "./imageCapability.js";

/**
 * Server-side isImageCapable: the core predicate plus the adapter's open id
 * grammar (`acceptsImageModel`, e.g. codex's `-image` suffix). Server code must
 * import from HERE so the grammar check always rides along; client code imports
 * the core directly because the adapter graph is node-only (see adapterIds.js).
 */
export function isImageCapable(providerId, modelId) {
  return isImageCapableCore(providerId, modelId, {
    acceptsImageModel: getImageAdapter(providerId)?.acceptsImageModel,
  });
}
