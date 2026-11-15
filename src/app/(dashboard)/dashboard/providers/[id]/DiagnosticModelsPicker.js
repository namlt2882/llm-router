"use client";

import { useMemo, useState } from "react";
import { Button } from "@/shared/components";
import PropTypes from "prop-types";

/**
 * Multi-select of the provider's catalog models used by the daily capacity
 * scan (patch #20) as its cheap diagnostic traffic. Deliberately dumb: the
 * caller owns persistence (whole-map read-modify-write of
 * settings.diagnosticModels) and the catalog order is preserved as-is — no
 * price sorting, the operator picks what is cheap for THEIR account.
 */
export default function DiagnosticModelsPicker({ providerId, connectionId = null, models = [], value = [], onSave }) {
  const valueKey = useMemo(() => (Array.isArray(value) ? value.join("|") : ""), [value]);
  // Draft keyed by the persisted value it was seeded from: when `value`
  // changes underneath us (refetch, another save), the draft re-seeds during
  // render — no setState-in-effect cascade.
  const [draft, setDraft] = useState(() => ({ key: valueKey, list: Array.isArray(value) ? value : [] }));
  const selected = draft.key === valueKey ? draft.list : (Array.isArray(value) ? value : []);

  const dirty = selected.join("|") !== valueKey;

  const toggle = (modelId) => {
    setDraft({ key: valueKey, list: selected.includes(modelId) ? selected.filter((m) => m !== modelId) : [...selected, modelId] });
  };

  return (
    <div className="min-w-0" data-testid={`diagnostic-models-${connectionId || providerId}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Model chuẩn đoán</span>
        <span className="text-[11px] text-text-muted">{selected.length ? `${selected.length} model` : "Bỏ quét"}</span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
        Quét hạn mức concurrency dùng các model này (1 lần/ngày, cả hệ thống) — chọn model rẻ để hạn chế chi phí.
      </p>
      {(models || []).length === 0 ? (
        <p className="text-xs text-text-muted">Không có model trong catalog để chọn.</p>
      ) : (
        <div className="max-h-44 overflow-y-auto rounded-md border border-border p-1">
          {models.map((model) => {
            const id = typeof model === "string" ? model : model.id;
            const name = typeof model === "string" ? model : model.name || model.id;
            const checked = selected.includes(id);
            return (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(id)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <span className="min-w-0 truncate" title={id}>{name}</span>
              </label>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!dirty} onClick={() => onSave(selected)}>Lưu</Button>
        {!selected.length && (
          <span className="text-[11px] text-text-muted">Chưa chọn model — bỏ qua quét dung lượng cho mục này.</span>
        )}
      </div>
    </div>
  );
}

DiagnosticModelsPicker.propTypes = {
  providerId: PropTypes.string.isRequired,
  connectionId: PropTypes.string,
  models: PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.string, PropTypes.shape({ id: PropTypes.string, name: PropTypes.string })])),
  value: PropTypes.arrayOf(PropTypes.string),
  onSave: PropTypes.func.isRequired,
};
