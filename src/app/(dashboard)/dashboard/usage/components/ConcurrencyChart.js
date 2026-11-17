"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

// The Usage tab's Concurrency view (2026-11-16 design): bars = average
// in-flight per bucket (left axis), the budget-weighted utilisation rate and
// window-cumulative token/cost lines ride on top. A bucket whose budget was
// zero has rate null — connectNulls={false} gaps the line there instead of
// drawing a misleading drop to zero.
export default function ConcurrencyChart({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const controller = new AbortController();
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/concurrency?period=${period}`, { signal: controller.signal });
      if (res.ok) setData(await res.json());
    } catch (e) {
      if (e?.name !== "AbortError") console.error("Failed to fetch concurrency chart data:", e);
    } finally {
      setLoading(false);
    }
    return controller;
  }, [period]);

  useEffect(() => {
    let controller;
    let cancelled = false;
    fetchData().then((c) => { if (!cancelled) controller = c; });
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [fetchData]);

  const hasData = data.some(
    (d) => (d.concurrency || 0) > 0 || d.utilityRate != null || (d.cumulativeTokens || 0) > 0 || (d.cumulativeCost || 0) > 0,
  );

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Concurrency</span>
        <span className="text-xs text-text-muted">cột: TB phiên đồng thời · đường: % hạn mức, token &amp; chi phí luỹ kế (trong khoảng chọn)</span>
      </div>
      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Chưa có dữ liệu concurrency</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              width={44}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              width={54}
              tickFormatter={fmtTokens}
            />
            {/* Cost gets its own hidden scale: sharing the token axis flattened
                the line onto zero (USD is orders of magnitude below tokens). */}
            <YAxis yAxisId="cost" orientation="right" hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) => {
                if (value == null) return ["—", name];
                if (name === "Token luỹ kế") return [fmtTokens(value), name];
                if (name === "Chi phí luỹ kế") return [fmtCost(value), name];
                if (name === "% hạn mức") return [`${Number(value).toFixed(1)}%`, name];
                return [value, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="left" dataKey="concurrency" name="Phiên đồng thời (TB)" fill="#6366f1" fillOpacity={0.7} />
            <Line yAxisId="left" dataKey="utilityRate" name="% hạn mức" stroke="#14b8a6" strokeWidth={2} connectNulls={false} dot={false} />
            <Line yAxisId="right" dataKey="cumulativeTokens" name="Token luỹ kế" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line yAxisId="cost" dataKey="cumulativeCost" name="Chi phí luỹ kế" stroke="#ef4444" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

ConcurrencyChart.propTypes = {
  period: PropTypes.string,
};
