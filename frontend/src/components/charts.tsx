"use client";

import * as React from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { Metrics, TimeseriesPoint } from "@/lib/types";
import { fmtMetric, fmtMs, fmtNumber, metricLabel, primaryMetricName } from "@/lib/utils";

const AXIS = {
  stroke: "var(--muted-foreground)",
  fontSize: 10,
  tickLine: false,
  axisLine: false,
} as const;

const GRID = { stroke: "var(--border)", strokeDasharray: "3 3", vertical: false } as const;

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--popover-foreground)",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.08)",
} as const;

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function shortTimestamp(value: string, granularity = "hour") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return granularity === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TrafficChart({ data, granularity = "hour", height = 220 }: { data: TimeseriesPoint[]; granularity?: string; height?: number }) {
  const points = data.map((point) => ({ ...point, label: shortTimestamp(point.timestamp, granularity) }));
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="volume-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="label" {...AXIS} minTickGap={28} />
        <YAxis {...AXIS} allowDecimals={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Area type="monotone" dataKey="volume" name="Requests" stroke="var(--chart-1)" strokeWidth={2} fill="url(#volume-fill)" />
        <Line type="monotone" dataKey="errors" name="Errors" stroke="var(--chart-4)" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function LatencyChart({ data, granularity = "hour", height = 220 }: { data: TimeseriesPoint[]; granularity?: string; height?: number }) {
  const points = data.map((point) => ({ ...point, label: shortTimestamp(point.timestamp, granularity) }));
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="label" {...AXIS} minTickGap={28} />
        <YAxis {...AXIS} width={40} tickFormatter={(value: number) => `${Math.round(value)}`} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [fmtMs(Number(value)), String(name)]} />
        <Line type="monotone" dataKey="latency_p50" name="p50" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls />
        <Line type="monotone" dataKey="latency_p95" name="p95" stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function RunMetricsChart({
  runs,
  taskType,
  height = 240,
}: {
  runs: Array<{ id: string; name: string; metrics: Metrics }>;
  taskType: string;
  height?: number;
}) {
  const primary = primaryMetricName(taskType);
  const data = runs
    .filter((run) => typeof run.metrics?.[primary] === "number")
    .slice(0, 8)
    .reverse()
    .map((run) => ({
      name: run.name.length > 22 ? `${run.name.slice(0, 22)}…` : run.name,
      value: Number(run.metrics[primary]),
    }));
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">No completed runs with a primary metric yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 0 }}>
        <CartesianGrid {...GRID} horizontal={false} vertical />
        <XAxis type="number" {...AXIS} domain={[0, 1]} tickFormatter={(value: number) => value.toFixed(2)} />
        <YAxis type="category" dataKey="name" {...AXIS} width={140} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [fmtMetric(Number(value)), metricLabel(primary)]} />
        <Bar dataKey="value" name={metricLabel(primary)} fill="var(--chart-1)" radius={[0, 4, 4, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FeatureImportanceChart({
  items,
  height = 320,
  valueKey = "mean_abs_shap",
  colorKey = "direction",
}: {
  items: Array<Record<string, unknown>>;
  height?: number;
  valueKey?: string;
  colorKey?: string;
}) {
  const data = items
    .map((item) => ({
      feature: String(item.feature ?? ""),
      value: Number(item[valueKey] ?? 0),
      direction: String(item[colorKey] ?? "neutral"),
    }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 15)
    .reverse();
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">No feature attributions available.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 0 }}>
        <CartesianGrid {...GRID} horizontal={false} vertical />
        <XAxis type="number" {...AXIS} tickFormatter={(value: number) => value.toFixed(2)} />
        <YAxis type="category" dataKey="feature" {...AXIS} width={130} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [fmtMetric(Number(value), 4), "Contribution"]} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
          {data.map((entry) => (
            <Cell
              key={entry.feature}
              fill={entry.value >= 0 ? "var(--chart-1)" : "var(--chart-2)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DistributionChart({
  buckets,
  height = 220,
}: {
  buckets: Array<{ value: string; count: number; share?: number }>;
  height?: number;
}) {
  if (!buckets.length) {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">No predictions in this window.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <BarChart data={buckets} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="value" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [fmtNumber(Number(value)), "Predictions"]} />
        <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} barSize={38} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function VersionUsageChart({ items }: { items: Array<{ model_name: string; version: number; count: number }> }) {
  const data = items.map((item) => ({ name: `${item.model_name} v${item.version}`, value: item.count }));
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">No version usage recorded.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={200} minWidth={0}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={72} paddingAngle={3}>
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={PALETTE[index % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [fmtNumber(Number(value)), String(name)]} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function PerformanceTrendChart({
  points,
  primaryMetric,
  height = 220,
}: {
  points: Array<{ date: string; metrics: Metrics; label_count?: number; status?: string }>;
  primaryMetric: string;
  height?: number;
}) {
  const data = points
    .map((point) => ({
      date: point.date,
      value: typeof point.metrics?.[primaryMetric] === "number" ? Number(point.metrics[primaryMetric]) : null,
      labels: point.label_count ?? 0,
    }))
    .filter((point) => point.value !== null);
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">No labelled performance windows yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="date" {...AXIS} minTickGap={20} />
        <YAxis {...AXIS} width={40} domain={[0, "auto"]} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [fmtMetric(Number(value)), metricLabel(primaryMetric)]} />
        <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ConfidenceBars({ avg, min, max }: { avg: number | null; min: number | null; max: number | null }) {
  const data = [
    { label: "Min", value: min ?? 0 },
    { label: "Average", value: avg ?? 0 },
    { label: "Max", value: max ?? 0 },
  ];
  return (
    <div className="space-y-3">
      {data.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex justify-between text-[11px]">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium tabular-nums">{(item.value * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-chart-2" style={{ width: `${Math.max(0, Math.min(100, item.value * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
