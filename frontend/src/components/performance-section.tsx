"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock3, FlaskConical, RefreshCw, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";

import { SectionCard, StatusBadge } from "@/components/common";
import { PerformanceTrendChart } from "@/components/charts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { api, qs } from "@/lib/api";
import {
  useLabelStatus,
  usePerformance,
  usePerformanceReports,
  usePerformanceTrend,
} from "@/lib/hooks";
import type { Metrics } from "@/lib/types";
import {
  errorMessage,
  fmtDate,
  fmtMetric,
  fmtMs,
  fmtNumber,
  fmtPercent,
  higherIsBetter,
  metricLabel,
  titleCase,
} from "@/lib/utils";

function MetricGrid({ metrics, baseline, primary }: { metrics: Metrics | null; baseline: Metrics; primary: string }) {
  if (!metrics) return null;
  const numeric = Object.entries(metrics).filter(([, value]) => typeof value === "number");
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {numeric.slice(0, 12).map(([key, value]) => {
        const current = Number(value);
        const base = typeof baseline[key] === "number" ? Number(baseline[key]) : null;
        const delta = base === null ? null : current - base;
        const good = delta === null ? null : higherIsBetter(key) ? delta >= 0 : delta <= 0;
        return (
          <div key={key} className="rounded-lg border bg-muted/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{metricLabel(key)}</span>
              {key === primary ? <Badge tone="primary">primary</Badge> : null}
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtMetric(current, 4)}</div>
            <div className="text-[10px] text-muted-foreground">
              baseline {fmtMetric(base, 4)}
              {delta !== null ? (
                <span className={good === false ? " text-destructive" : good ? " text-success" : ""}>
                  {" "}
                  · Δ {delta >= 0 ? "+" : ""}
                  {fmtMetric(delta, 4)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PerformanceSection({ deploymentId, days = 7 }: { deploymentId: string; days?: number }) {
  const queryClient = useQueryClient();
  const { data: performance, isLoading, error, refetch } = usePerformance(deploymentId, days);
  const { data: labels } = useLabelStatus(deploymentId, Math.max(days, 30));
  const { data: trend } = usePerformanceTrend(deploymentId, Math.max(days, 30));
  const { data: reports } = usePerformanceReports(deploymentId, 5);

  const evaluate = useMutation({
    mutationFn: () => api(`/deployments/${deploymentId}/performance/evaluate${qs({ days })}`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["performance", deploymentId] });
      void queryClient.invalidateQueries({ queryKey: ["performance-trend", deploymentId] });
      void queryClient.invalidateQueries({ queryKey: ["performance-reports", deploymentId] });
      void queryClient.invalidateQueries({ queryKey: ["deployment-monitoring", deploymentId] });
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast.success("Performance evaluated from available ground-truth labels.");
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  if (isLoading) return <LoadingBlock label="Checking label availability and performance…" />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;
  if (!performance) return null;

  const insufficient = performance.status === "insufficient_labels" || !performance.metrics;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Delayed-label performance"
        description="Only ground-truth labels produce accuracy, F1, ROC AUC, MAE, RMSE, or R². Unlabelled predictions never imply accuracy."
        actions={
          <Button variant="outline" size="sm" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>
            <RefreshCw className={evaluate.isPending ? "animate-spin" : undefined} /> {evaluate.isPending ? "Evaluating…" : "Evaluate now"}
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={performance.status} />
            <Badge tone="muted">{metricLabel(performance.primary_metric)}</Badge>
            <Badge tone={performance.degraded ? "danger" : "success"}>
              {performance.degraded ? "Degraded vs baseline" : "Within baseline threshold"}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {fmtNumber(performance.label_count)} labels / {fmtNumber(performance.prediction_count)} predictions
              {performance.simulated_labels ? ` · ${fmtNumber(performance.simulated_labels)} simulated` : ""}
            </span>
          </div>

          {insufficient ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-xs leading-relaxed">
              <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <div className="font-medium">Insufficient labels — performance is not reported.</div>
                <p className="mt-1 text-muted-foreground">{performance.message}</p>
                <p className="mt-1 text-muted-foreground">
                  Minimum required: {fmtNumber(performance.min_labels)} labels. Submit labels from the predictions table or through the
                  labels API. Label delay p50:{" "}
                  {performance.delayed_labels.p50_seconds === null ? "—" : fmtMs(performance.delayed_labels.p50_seconds * 1000)}.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                <span>{performance.message}</span>
              </div>
              <MetricGrid metrics={performance.metrics} baseline={performance.baseline_metrics} primary={performance.primary_metric} />
            </>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium">
                <FlaskConical className="size-3.5" /> Concept drift status
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge status={performance.concept_drift.status} />
                {performance.concept_drift.performance_degraded !== undefined ? (
                  <Badge tone={performance.concept_drift.performance_degraded ? "danger" : "success"}>
                    {performance.concept_drift.performance_degraded ? "Performance degraded" : "No degradation"}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{performance.concept_drift.explanation}</p>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium">
                <Clock3 className="size-3.5" /> Delayed labels
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                <span>p50 delay</span>
                <span className="text-right font-medium text-foreground">
                  {performance.delayed_labels.p50_seconds === null ? "—" : fmtMs(performance.delayed_labels.p50_seconds * 1000)}
                </span>
                <span>p95 delay</span>
                <span className="text-right font-medium text-foreground">
                  {performance.delayed_labels.p95_seconds === null ? "—" : fmtMs(performance.delayed_labels.p95_seconds * 1000)}
                </span>
                <span>samples</span>
                <span className="text-right font-medium text-foreground">{fmtNumber(performance.delayed_labels.sample_count)}</span>
                <span>label rate (30d)</span>
                <span className="text-right font-medium text-foreground">{labels ? fmtPercent(labels.label_rate) : "—"}</span>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Performance trend"
        description="Stored evaluation windows. Gaps mean no labels were available for that window."
      >
        <PerformanceTrendChart
          points={(trend?.points ?? []) as Array<{ date: string; metrics: Metrics; label_count?: number; status?: string }>}
          primaryMetric={trend?.primary_metric ?? performance.primary_metric}
        />
      </SectionCard>

      <SectionCard title="Evaluation reports" description="Immutable snapshots of labelled performance." contentClassName="p-0">
        {!reports?.items.length ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No evaluation reports yet"
            description="Reports are created when labels are submitted or when performance is evaluated explicitly."
            className="border-0"
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Window</TH>
                <TH>Status</TH>
                <TH>Labels</TH>
                <TH>Primary</TH>
                <TH>Delta</TH>
                <TH>Concept drift</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {reports.items.map((report) => (
                <TR key={report.id}>
                  <TD className="text-[11px] text-muted-foreground">
                    {fmtDate(report.window_start, false)} → {fmtDate(report.window_end, false)}
                  </TD>
                  <TD><StatusBadge status={report.status} /></TD>
                  <TD className="text-xs tabular-nums">{fmtNumber(report.label_count)}</TD>
                  <TD className="text-xs tabular-nums">
                    {metricLabel(report.primary_metric)} {fmtMetric(Number(report.metrics?.[report.primary_metric]), 4)}
                  </TD>
                  <TD className="text-[11px]">
                    {typeof report.delta?.absolute === "number" ? (
                      <span className={report.degraded ? "text-destructive" : "text-success"}>
                        {Number(report.delta.absolute) >= 0 ? "+" : ""}
                        {fmtMetric(Number(report.delta.absolute), 4)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    {report.suspected_concept_drift ? (
                      <Badge tone="warning"><AlertTriangle /> Suspected</Badge>
                    ) : (
                      <Badge tone="muted">{titleCase(report.status)}</Badge>
                    )}
                  </TD>
                  <TD className="text-[11px] text-muted-foreground">{fmtDate(report.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
