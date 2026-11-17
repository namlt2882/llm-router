"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Select } from "@/shared/components";

const FIELDS = [
  ["input", "Input"],
  ["output", "Output"],
  ["cached", "Cached"],
  ["reasoning", "Reasoning"],
  ["cacheCreation", "Cache write"],
  ["perImage", "Per image"],
];
const EMPTY = { name: "", kind: "model", input: "", output: "", cached: "", reasoning: "", cacheCreation: "", perImage: "" };

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");

function explain(err) {
  if (!err) return "";
  if (err.error === "below_floor") return `${err.field} must be at least ${fmt(err.minimum)} credits per 1M tokens`;
  if (err.error === "unsellable") return "No base price for this name, so it cannot be sold";
  if (err.error === "kind_mismatch") return "Kind does not match: a combo name needs kind combo, a model needs kind model";
  if (err.error === "combo_cycle") return "This combo contains itself";
  if (err.error === "invalid") return `${err.field || "value"} is not valid`;
  return err.error || "Request failed";
}

async function call(url, options) {
  const res = await fetch(url, { ...options, headers: { "content-type": "application/json" } });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

export default function PricingClient() {
  const [prices, setPrices] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [fx, setFx] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(EMPTY);
  const [draftError, setDraftError] = useState("");
  const [rowErrors, setRowErrors] = useState({});
  const [pinRate, setPinRate] = useState("");
  const [pinDays, setPinDays] = useState("7");
  const [fxError, setFxError] = useState("");

  const load = useCallback(async () => {
    const [p, f] = await Promise.all([call("/api/fork/saleprice"), call("/api/fork/fx")]);
    if (p.ok) {
      setPrices(p.data.prices || []);
      setFlagged(p.data.flagged || []);
      setLoadError("");
    } else {
      setLoadError(p.status === 503 ? "No FX rate available yet, so prices cannot be validated" : `Could not load prices (${p.status})`);
    }
    if (f.ok) setFx(f.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toEntry = (row) => {
    const entry = { name: row.name.trim(), kind: row.kind };
    for (const [k] of FIELDS) {
      if (row[k] === "" || row[k] === undefined) {
        if (k === "perImage") continue;
        entry[k] = NaN;
      } else entry[k] = Number(row[k]);
    }
    return entry;
  };

  async function save(row, onError, after) {
    const entry = toEntry(row);
    if (!entry.name) return onError("Name is required");
    const r = await call("/api/fork/saleprice", { method: "PUT", body: JSON.stringify(entry) });
    if (!r.ok) return onError(explain(r.data));
    onError("");
    after?.();
    await load();
  }

  async function remove(name) {
    await call(`/api/fork/saleprice?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    await load();
  }

  async function fxAction(body) {
    const r = await call("/api/fork/fx", { method: "PUT", body: JSON.stringify(body) });
    if (!r.ok) return setFxError(r.data?.error || "Request failed");
    setFxError("");
    setFx(r.data);
  }

  const flaggedNames = new Set(flagged.map((f) => f.name));

  return (
    <div className="flex flex-col gap-6">
      <Card title="Exchange rate" subtitle="VND per USD used as the price floor: highest fresh source plus the margin" icon="currency_exchange">
        {fx ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold" data-testid="fx-rate">{fmt(fx.rate)}</span>
              <Badge variant="default">{fx.source}</Badge>
              {fx.pinned && <Badge variant="primary">pinned</Badge>}
              {fx.stale && <Badge variant="error">stale</Badge>}
              <span className="text-xs text-text-muted">margin {(fx.marginPct * 100).toFixed(1)}%</span>
              <Button size="sm" variant="secondary" onClick={() => fxAction({ refresh: true })}>Refresh now</Button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Input label="Pin rate (VND per USD)" type="number" value={pinRate} onChange={(e) => setPinRate(e.target.value)} className="w-56" />
              <Input label="Expires in (days)" type="number" value={pinDays} onChange={(e) => setPinDays(e.target.value)} className="w-40" />
              <Button
                size="md"
                onClick={() => fxAction({ pin: { rate: Number(pinRate), expiresAt: Date.now() + Number(pinDays) * 86_400_000 } })}
                disabled={!pinRate || !pinDays}
              >
                Pin
              </Button>
              {fx.pinned && <Button variant="outline" onClick={() => fxAction({ pin: null })}>Clear pin</Button>}
            </div>
            {fxError && <p className="text-xs text-red-500">{fxError}</p>}
          </div>
        ) : (
          <p className="text-sm text-text-muted">No rate yet.</p>
        )}
      </Card>

      {flagged.length > 0 && (
        <Card title="Below the current floor" subtitle="A rate or base-price change put these under cost. They are not rewritten; raise them." icon="warning">
          <ul className="flex flex-col gap-1 text-sm" data-testid="flagged-list">
            {flagged.map((f) => (
              <li key={f.name}>
                <span className="font-mono">{f.name}</span>: {explain({ error: f.violation.minimum !== undefined ? "below_floor" : f.violation.reason, ...f.violation })}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Sale prices" subtitle="Credits per 1M tokens (1 credit = 1 VND). Never below base cost at the floor rate." icon="sell">
        {loadError && <p className="mb-3 text-sm text-red-500">{loadError}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Kind</th>
                {FIELDS.map(([k, label]) => (
                  <th key={k} className="pb-2 pr-3">{label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {prices.map((row) => (
                <PriceRow
                  key={row.name}
                  row={row}
                  flagged={flaggedNames.has(row.name)}
                  error={rowErrors[row.name]}
                  onSave={(next) => save(next, (m) => setRowErrors((e) => ({ ...e, [row.name]: m })))}
                  onDelete={() => remove(row.name)}
                />
              ))}
              {prices.length === 0 && (
                <tr>
                  <td colSpan={FIELDS.length + 3} className="py-3 text-text-muted">Nothing is priced yet, so nothing is sellable.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Add a price" icon="add">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="Model or combo name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="cc/claude-sonnet-4-5" />
          <Select
            label="Kind"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            options={[{ value: "model", label: "model" }, { value: "combo", label: "combo" }]}
          />
          {FIELDS.map(([k, label]) => (
            <Input key={k} label={label} type="number" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          ))}
        </div>
        {draftError && <p className="mt-3 text-sm text-red-500" data-testid="draft-error">{draftError}</p>}
        <div className="mt-3">
          <Button onClick={() => save(draft, setDraftError, () => setDraft(EMPTY))}>Save price</Button>
        </div>
      </Card>
    </div>
  );
}

function PriceRow({ row, flagged, error, onSave, onDelete }) {
  const [edit, setEdit] = useState({ ...EMPTY, ...row });
  useEffect(() => setEdit({ ...EMPTY, ...row }), [row]);
  const dirty = FIELDS.some(([k]) => String(edit[k] ?? "") !== String(row[k] ?? ""));
  return (
    <>
      <tr className={flagged ? "bg-red-500/5" : ""}>
        <td className="py-1 pr-3 font-mono">{row.name}</td>
        <td className="py-1 pr-3">{row.kind}</td>
        {FIELDS.map(([k]) => (
          <td key={k} className="py-1 pr-3">
            <input
              aria-label={`${row.name} ${k}`}
              type="number"
              className="w-24 rounded-md bg-surface-2 px-2 py-1 text-sm"
              value={edit[k] ?? ""}
              onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
            />
          </td>
        ))}
        <td className="py-1 text-right whitespace-nowrap">
          <Button size="sm" disabled={!dirty} onClick={() => onSave(edit)}>Save</Button>{" "}
          <Button size="sm" variant="ghost" onClick={onDelete}>Remove</Button>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={FIELDS.length + 3} className="pb-2 text-xs text-red-500">{error}</td>
        </tr>
      )}
    </>
  );
}
