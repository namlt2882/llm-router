/**
 * What a System One combo may seat. A native systemone row speaks the protocol;
 * every plain text row is admitted too — it answers through the validated JSON
 * shim (open-sse/handlers/systemoneShim.js, resolveSystemoneMode routes it).
 * ModelSelectModal calls these two predicates for kindFilter "systemone";
 * excluding text rows there is what made the shim unreachable from the UI
 * (browser test 2026-11-24: "No models found" for glm-5.3-flash).
 */

/** May a provider with this serviceKinds list appear in the systemone picker? */
export function connectionServesSystemone(serviceKinds) {
  const kinds = serviceKinds || ["llm"];
  return kinds.includes("systemone") || kinds.includes("llm");
}

/** May a model row of this kind appear in the systemone picker? */
export function modelServesSystemone(kind) {
  return kind === "systemone" || !kind || kind === "llm";
}
