import { NextResponse } from "next/server";
import { getProviderConnectionById, getSettings, updateSettings } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind, getInternalHeaders } from "@/app/api/models/test/ping";
import { isImageCapable } from "open-sse/providers/imageCapability.js";

/**
 * POST /api/providers/[id]/image-check — opt-in live probe (id = connectionId).
 * Pings each image-capable model of the connection through the internal
 * /v1/images/generations endpoint and persists the verdict as
 * settings.imageCapability[connectionId][modelId] = { ok, at, error }.
 * Nothing runs this automatically: a ping costs upstream money.
 *
 * Enumeration mirrors /api/providers/[id]/models: static registry rows first,
 * then the sibling route's live list with the connection's own token. Deliberately
 * NOT gated on isOpenAICompatibleProvider/isAnthropicCompatibleProvider like
 * test-models — those are prefix tests that vercel-ai-gateway (the one
 * live-catalogue provider whose only check IS this probe) does not satisfy.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    let models = getProviderModels(alias);
    if (models.length === 0) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`, { headers: await getInternalHeaders() });
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fall through to the empty refusal */ }
    }

    const imageModels = models.filter((m) => isImageCapable(providerId, m.id));
    if (imageModels.length === 0) {
      return NextResponse.json({ error: "No image-capable models for this connection" }, { status: 400 });
    }

    // Warm up with the first model to trigger token refresh before the parallel
    // calls (same reasoning as test-models: parallel probes would race one refresh).
    const [first, ...rest] = imageModels;
    const firstResult = await pingModelByKind(`${alias}/${first.id}`, "image", baseUrl);
    const restResults = await Promise.all(
      rest.map((m) => pingModelByKind(`${alias}/${m.id}`, "image", baseUrl))
    );
    const results = imageModels.map((m, i) => {
      const r = i === 0 ? firstResult : restResults[i - 1];
      return { modelId: m.id, ok: r.ok, latencyMs: r.latencyMs, error: r.error ?? null };
    });

    const current = await getSettings();
    const map = { ...(current.imageCapability || {}) };
    map[id] = Object.fromEntries(
      results.map((r) => [r.modelId, { ok: r.ok, at: new Date().toISOString(), error: r.error || null }])
    );
    await updateSettings({ imageCapability: map });   // whole map: updateSettings shallow-merges

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "image-check failed" }, { status: 500 });
  }
}
