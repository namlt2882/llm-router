"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Input, Select } from "@/shared/components";
import { filterRows } from "./filterRows.js";
import { calendarStaleNotice, editTiersFrom, fmtTokens, fmtUsd, parseDefaultBase, scheduleLabel, showPrice, tierLines, tiersForSave } from "./formatPrice.js";
import { bulkPreview, selectedVisible } from "./bulkPreview.js";

const FIELDS = [
  ["input", "Input"],
  ["output", "Output"],
  ["cached", "Cached"],
  ["reasoning", "Reasoning"],
  ["cacheCreation", "Cache write"],
  ["perImage", "Per image"],
];
const FILTERS = [
  { value: "all", label: "All" },
  { value: "model", label: "Models" },
  { value: "combo", label: "Combos" },
  { value: "custom", label: "Custom price" },
  { value: "promo", label: "Promotion" },
  { value: "below_floor", label: "Below floor" },
];
const BULK_ERRORS = {
  unsellable: "no base price",
  in_promotion: "in a promotion, end the promotion first",
  below_floor: "stored price is under the floor",
};

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");
const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const endOfDay = (yyyyMmDd) => new Date(`${yyyyMmDd}T23:59:59.999`).getTime();

function explain(err) {
  if (!err) return "";
  if (err.error === "below_floor") return `${err.field} must be at least $${fmtUsd(err.minimum)} per 1M tokens`;
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
  const [rows, setRows] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [fx, setFx] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [rowErrors, setRowErrors] = useState({});
  const [pinRate, setPinRate] = useState("");
  const [pinDays, setPinDays] = useState("7");
  const [fxError, setFxError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState({ action: "markup", pct: "", endsOn: "", label: "" });
  const [bulkMsg, setBulkMsg] = useState({ error: "", failures: [], applied: 0, belowFloor: 0 });
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("usd");
  const [baseDefault, setBaseDefault] = useState({ enabled: false, input: 0.05, cached: 0.005, output: 0.1 });
  const [defaultMsg, setDefaultMsg] = useState("");
  const [today] = useState(() => new Date().toLocaleDateString("en-CA"));

  const load = useCallback(async () => {
    const [l, p, f] = await Promise.all([call("/api/fork/pricelist"), call("/api/fork/saleprice"), call("/api/fork/fx")]);
    if (l.ok) {
      setRows(l.data.rows || []);
      if (l.data.default) setBaseDefault(l.data.default);
      setLoadError("");
    } else {
      setLoadError(l.status === 503 ? "No FX rate available yet, so prices cannot be shown" : `Could not load prices (${l.status})`);
    }
    if (p.ok) setFlagged(p.data.flagged || []);
    if (f.ok) setFx(f.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => filterRows(rows, { q, filter }), [rows, q, filter]);
  const sellable = useMemo(() => visible.filter((r) => r.status !== "no_base_price"), [visible]);
  const chosen = useMemo(() => selectedVisible(visible, selected), [visible, selected]);
  const hiddenSelected = selected.size - chosen.length;
  const allChosen = sellable.length > 0 && sellable.every((r) => selected.has(r.name));

  const toggle = (name) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleAll = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const r of sellable) {
        if (allChosen) next.delete(r.name);
        else next.add(r.name);
      }
      return next;
    });

  async function saveRow(row, edit, tiers) {
    const entry = { name: row.name, kind: row.kind, unit: "usd" };
    const saved = tiersForSave(tiers);
    if (saved) entry.tiers = saved;
    for (const [k] of FIELDS) {
      if (edit[k] === "" || edit[k] === undefined) {
        if (k === "perImage") continue;
        entry[k] = NaN;
      } else entry[k] = Number(edit[k]);
    }
    const r = await call("/api/fork/saleprice", { method: "PUT", body: JSON.stringify(entry) });
    if (!r.ok) {
      setRowErrors((e) => ({ ...e, [row.name]: explain(r.data) }));
      return false;
    }
    setRowErrors((e) => ({ ...e, [row.name]: "" }));
    await load();
    return true;
  }

  async function backToAuto(row) {
    if (row.status === "promo") await call("/api/fork/pricebulk", { method: "POST", body: JSON.stringify({ action: "revert", names: [row.name] }) });
    else await call(`/api/fork/saleprice?name=${encodeURIComponent(row.name)}`, { method: "DELETE" });
    await load();
  }

  const pct = Number(bulk.pct);
  const bulkReady =
    chosen.length > 0 && Number.isFinite(pct) && pct > 0 && (bulk.action === "markup" ? pct <= 500 : pct <= 100 && bulk.endsOn >= today);
  const previews = bulkReady ? chosen.slice(0, 5).map((r) => ({ row: r, ...bulkPreview(r, bulk.action, pct) })) : [];
  const underFloorCount = bulkReady && bulk.action === "promo" ? chosen.filter((r) => bulkPreview(r, "promo", pct)?.under).length : 0;

  async function applyBulk() {
    setBusy(true);
    const body = { action: bulk.action, names: chosen.map((r) => r.name), pct, ...(bulk.label ? { label: bulk.label } : {}) };
    if (bulk.action === "promo") body.endsAt = endOfDay(bulk.endsOn);
    const r = await call("/api/fork/pricebulk", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) return setBulkMsg({ error: r.data?.error || `Request failed (${r.status})`, failures: [], applied: 0, belowFloor: 0 });
    const results = r.data.results || [];
    setBulkMsg({
      error: "",
      failures: results.filter((x) => !x.ok),
      applied: results.filter((x) => x.ok).length,
      belowFloor: results.filter((x) => x.ok && x.belowFloor).length,
    });
    setSelected(new Set(results.filter((x) => !x.ok).map((x) => x.name)));
    await load();
  }

  async function saveDefault() {
    const { body, error } = parseDefaultBase(baseDefault);
    if (error) return setDefaultMsg(error);
    const r = await call("/api/fork/pricedefault", { method: "PUT", body: JSON.stringify(body) });
    if (!r.ok) return setDefaultMsg(r.data?.error || `Request failed (${r.status})`);
    setDefaultMsg("Saved");
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

      {calendarStaleNotice(rows) && (
        <Card title="Holiday calendar" subtitle={calendarStaleNotice(rows)} icon="warning" />
      )}

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

      <Card title="Default base price" subtitle="USD per 1M tokens, sold for names that have no base pricing" icon="price_change">
        <div className="flex flex-col gap-3" data-testid="default-base">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Enable default base price"
              checked={!!baseDefault.enabled}
              onChange={(e) => setBaseDefault({ ...baseDefault, enabled: e.target.checked })}
            />
            Enabled
          </label>
          <div className="flex flex-wrap items-end gap-3">
            {[["input", "Input (USD)"], ["cached", "Cached (USD)"], ["output", "Output (USD)"]].map(([k, label]) => (
              <Input
                key={k}
                label={label}
                type="number"
                value={baseDefault[k] ?? ""}
                onChange={(e) => setBaseDefault({ ...baseDefault, [k]: e.target.value })}
                className="w-40"
              />
            ))}
            <Button onClick={saveDefault}>Save</Button>
            {defaultMsg && <span className="pb-2 text-xs text-text-muted">{defaultMsg}</span>}
          </div>
          <p className="text-xs text-text-muted">
            A name with no base pricing has an unknown cost, so it cannot be sold while this is off; while it is on, every such name sells at these prices, and there is no per-name opt-out. A name with a real base price, even a free one, is never touched. Reasoning follows output and cache write follows input. A combo averages its members, so one member on the default base moves the whole combo.
          </p>
        </div>
      </Card>

      <Card title="Prices" subtitle="Every model and combo. Unpriced names sell at the cost floor; change prices only when you want to." icon="sell">
        {loadError && <p className="mb-3 text-sm text-red-500">{loadError}</p>}
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name contains..." className="w-64" />
          <Select label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} options={FILTERS} />
          <Select
            label="Currency"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[{ value: "usd", label: "USD per 1M" }, { value: "vnd", label: "VND per 1M" }]}
          />
          <span className="pb-2 text-xs text-text-muted" data-testid="row-count">{visible.length} of {rows.length} names, {selected.size} selected</span>
        </div>

        {selected.size > 0 && (
          <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="bulk-bar">
            <div className="flex flex-wrap items-end gap-3">
              <Select
                label="Action"
                value={bulk.action}
                onChange={(e) => setBulk({ ...bulk, action: e.target.value })}
                options={[{ value: "markup", label: "Apply markup %" }, { value: "promo", label: "Apply promotion %" }]}
              />
              <Input label="Percent" type="number" value={bulk.pct} onChange={(e) => setBulk({ ...bulk, pct: e.target.value })} className="w-28" />
              {bulk.action === "promo" && (
                <Input label="Until (end of day)" type="date" min={today} value={bulk.endsOn} onChange={(e) => setBulk({ ...bulk, endsOn: e.target.value })} className="w-44" />
              )}
              <Input label="Label (optional)" value={bulk.label} onChange={(e) => setBulk({ ...bulk, label: e.target.value })} className="w-48" />
              <Button disabled={!bulkReady || busy} onClick={applyBulk}>
                {bulk.action === "markup" ? `Apply markup to ${chosen.length}` : `Apply promotion to ${chosen.length}`}
              </Button>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
            </div>
            {previews.length > 0 && (
              <ul className="text-xs text-text-muted" data-testid="bulk-preview">
                {previews.map((p) => (
                  <li key={p.row.name}>
                    <span className="font-mono">{p.row.name}</span> input {showPrice(p.from, mode, fx?.rate)} → {showPrice(p.to, mode, fx?.rate)}
                    {p.skip ? <span className="text-red-500"> (skipped: in a promotion)</span> : p.under && <span className="text-red-500"> (under the floor)</span>}
                  </li>
                ))}
                {chosen.length > previews.length && <li>and {chosen.length - previews.length} more</li>}
              </ul>
            )}
            {hiddenSelected > 0 && (
              <p className="text-xs text-text-muted" data-testid="bulk-hidden">
                {hiddenSelected} selected name{hiddenSelected > 1 ? "s are" : " is"} hidden by the search or filter and will not be changed.
              </p>
            )}
            {underFloorCount > 0 && (
              <p className="text-xs text-red-500" data-testid="bulk-warning">
                Warning: {underFloorCount} name{underFloorCount > 1 ? "s" : ""} would sell below cost during this promotion.
              </p>
            )}
          </div>
        )}
        {(bulkMsg.error || bulkMsg.applied > 0 || bulkMsg.failures.length > 0) && (
          <div className="mb-3 text-sm" data-testid="bulk-result">
            {bulkMsg.error && <p className="text-red-500">{bulkMsg.error}</p>}
            {bulkMsg.applied > 0 && (
              <p>
                Applied to {bulkMsg.applied} name{bulkMsg.applied > 1 ? "s" : ""}.
                {bulkMsg.belowFloor > 0 && <span className="text-red-500"> {bulkMsg.belowFloor} now sell below cost.</span>}
              </p>
            )}
            {bulkMsg.failures.map((f) => (
              <p key={f.name} className="text-red-500">
                <span className="font-mono">{f.name}</span>: {BULK_ERRORS[f.error] || f.error}
              </p>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-2 pr-3">
                  <input type="checkbox" aria-label="Select all matching" checked={allChosen} onChange={toggleAll} />
                </th>
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Kind</th>
                <th className="pb-2 pr-3">Floor in / cached / out</th>
                <th className="pb-2 pr-3">Price in / cached / out</th>
                <th className="pb-2 pr-3">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <PriceRow
                  key={row.name}
                  row={row}
                  mode={mode}
                  rate={fx?.rate}
                  checked={selected.has(row.name)}
                  flagged={flaggedNames.has(row.name)}
                  error={rowErrors[row.name]}
                  onToggle={() => toggle(row.name)}
                  onSave={(edit, tiers) => saveRow(row, edit, tiers)}
                  onAuto={() => backToAuto(row)}
                />
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-3 text-text-muted">{rows.length === 0 ? "No models or combos are served yet." : "No name matches this search."}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatusBadges({ row, flagged }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.status === "auto" && <Badge variant="default">auto</Badge>}
      {row.status === "custom" && <Badge variant="primary">custom</Badge>}
      {row.status === "markup" && <Badge variant="primary">markup {row.stored?.pct}%</Badge>}
      {row.status === "promo" && <Badge variant="primary">promo -{row.stored?.pct}% until {fmtDate(row.endsAt)}</Badge>}
      {row.defaultBase && <Badge variant="default">default base</Badge>}
      {row.status === "no_base_price" && <Badge variant="default">no base price, not sellable</Badge>}
      {(row.belowFloor || flagged) && <Badge variant="error">below cost</Badge>}
    </span>
  );
}

function PriceRow({ row, mode, rate, checked, flagged, error, onToggle, onSave, onAuto }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState({});
  const [editTiers, setEditTiers] = useState([]);
  const locked = row.status === "no_base_price";
  const startEdit = () => {
    setEdit({ ...(row.effective || {}) });
    setEditTiers(editTiersFrom(row.effective, row.floor));
    setOpen(true);
  };
  const dirty =
    FIELDS.some(([k]) => String(edit[k] ?? "") !== String(row.effective?.[k] ?? "")) ||
    JSON.stringify(editTiers) !== JSON.stringify(editTiersFrom(row.effective, row.floor));
  return (
    <>
      <tr className={row.belowFloor || flagged ? "bg-red-500/5" : ""}>
        <td className="py-1 pr-3">
          <input type="checkbox" aria-label={`Select ${row.name}`} checked={checked && !locked} disabled={locked} onChange={onToggle} />
        </td>
        <td className="py-1 pr-3 font-mono">
          {row.name}
          {row.schedule && <div className="text-xs font-sans text-text-muted" data-testid="schedule-caption">{scheduleLabel(row.schedule)}</div>}
        </td>
        <td className="py-1 pr-3">{row.kind}</td>
        <td className="py-1 pr-3 whitespace-nowrap">
          {row.floor ? [row.floor.input, row.floor.cached, row.floor.output].map((v) => showPrice(v, mode, rate)).join(" / ") : "-"}
          {tierLines(row.floor, mode, rate).map((l) => <div key={l} className="text-xs text-text-muted">{l}</div>)}
        </td>
        <td className="py-1 pr-3 whitespace-nowrap">
          {row.effective ? [row.effective.input, row.effective.cached, row.effective.output].map((v) => showPrice(v, mode, rate)).join(" / ") : "-"}
          {tierLines(row.effective, mode, rate).map((l) => <div key={l} className="text-xs text-text-muted">{l}</div>)}
        </td>
        <td className="py-1 pr-3"><StatusBadges row={row} flagged={flagged} /></td>
        <td className="py-1 text-right whitespace-nowrap">
          {!locked && <Button size="sm" variant="ghost" onClick={open ? () => setOpen(false) : startEdit}>{open ? "Close" : "Edit"}</Button>}
          {!locked && row.stored && <Button size="sm" variant="ghost" onClick={onAuto}>{row.status === "promo" ? "End promotion" : "Back to auto"}</Button>}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={6} className="pb-3">
            <div className="flex flex-wrap items-end gap-3">
              {FIELDS.map(([k, label]) => (
                <label key={k} className="flex flex-col text-xs text-text-muted">
                  {`${label} (USD)`}
                  <input
                    aria-label={`${row.name} ${k}`}
                    type="number"
                    className="w-28 rounded-md bg-surface-2 px-2 py-1 text-sm text-text-main"
                    value={edit[k] ?? ""}
                    onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                  />
                </label>
              ))}
              <Button size="sm" disabled={!dirty} onClick={async () => (await onSave(edit, editTiers)) && setOpen(false)}>Save</Button>
            </div>
            {editTiers.map((t, i) => (
              <div key={t.above} className="mt-2 flex flex-wrap items-end gap-3">
                <span className="text-xs text-text-muted">{`Prompt over ${fmtTokens(t.above)} tokens, every token at`}</span>
                {FIELDS.filter(([k]) => k !== "perImage").map(([k, label]) => (
                  <label key={k} className="flex flex-col text-xs text-text-muted">
                    {`${label} (USD)`}
                    <input
                      aria-label={`${row.name} over ${fmtTokens(t.above)} ${k}`}
                      type="number"
                      className="w-28 rounded-md bg-surface-2 px-2 py-1 text-sm text-text-main"
                      value={t[k] ?? ""}
                      onChange={(e) => setEditTiers(editTiers.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                    />
                  </label>
                ))}
              </div>
            ))}
            {row.status === "promo" && <p className="mt-2 text-xs text-text-muted">Saving a manual price ends this promotion.</p>}
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td />
          <td colSpan={6} className="pb-2 text-xs text-red-500">{error}</td>
        </tr>
      )}
    </>
  );
}
