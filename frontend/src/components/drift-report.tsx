"use client";

import * as React from "react";
import { AlertTriangle, BarChart3, CheckCircle2, FlaskConical, GitCompareArrows, Info } from "lucide-react";

import { SectionCard, SeverityBadge, SimulatedBadge, StatusBadge } from "@/components/common";
import {
  Badge,
  ErrorState,
  LoadingBlock,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDriftReport } from "@/lib/hooks";
import type { DriftReport } from "@/lib/types";
import { errorMessage, fmtDate, fmtMetric, fmtNumber, fmtPercent, titleCase } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function DriftReportDialog({
  reportId,
  open,
  onOpenChange,
}: {
  reportId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: report, isLoading, error, refetch } = useDriftReport(open ? reportId : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Drift report <SeverityBadge severity={report?.severity} />
            {report ? <StatusBadge status={report.status} /> : null}
          </DialogTitle>
          <DialogDescription>
            {report
              ? `${report.project_name ?? "Project"} · ${report.deployment_name ?? "Dataset comparison"} · ${fmtDate(report.created_at)}`
              : "Loading the stored report and feature-level evidence."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {isLoading ? (
            <LoadingBlock label="Loading drift evidence…" />
          ) : error ? (
            <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
          ) : report ? (
            <DriftReportContent report={report} />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function DriftReportContent({ report }: { report: DriftReport }) {
  const overview = asRecord(report.summary.overview);
  const prediction = asRecord(report.summary.prediction_drift);
  const concept = asRecord(report.summary.concept_drift);
  const schema = asRecord(report.summary.schema_changes);
  const warnings = asStringArray(report.summary.warnings);
  const recommendations = asStringArray(report.summary.recommendations);
  const missing = asStringArray(schema.missing_features);
  const added = asStringArray(schema.added_features);
  const typeChanges = asStringArray(schema.type_changes);
  const evidently = asRecord(report.summary.evidently);
  const simulated = Boolean(overview.simulated);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Drifted features</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {report.drifted_feature_count} <span className="text-xs font-normal text-muted-foreground">/ {report.feature_count}</span>
          </div>
          <div className="text-[10px] text-muted-foreground">{fmtPercent(report.drift_share)} of analyzed features</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Samples</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {fmtNumber(report.reference_sample_size)} <span className="text-xs font-normal text-muted-foreground">ref</span>
          </div>
          <div className="text-[10px] text-muted-foreground">{fmtNumber(report.current_sample_size)} current</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Engine</div>
          <div className="mt-1 text-sm font-semibold">{titleCase(report.engine)}</div>
          <div className="text-[10px] text-muted-foreground">FDR-corrected statistics</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Window</div>
          <div className="mt-1 text-xs font-medium">
            {overview.window ? `${fmtDate(String(asRecord(overview.window).start))} →` : fmtDate(report.window.start)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {overview.window ? fmtDate(String(asRecord(overview.window).end)) : fmtDate(report.window.end)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge tone="muted">Reference: {report.reference_label ?? "—"}</Badge>
        <Badge tone="muted">Current: {report.current_label ?? "—"}</Badge>
        <SimulatedBadge simulated={simulated} />
        {typeof overview.alpha === "number" ? <Badge tone="muted">α {overview.alpha}</Badge> : null}
        {typeof overview.psi_threshold === "number" ? <Badge tone="muted">PSI ≥ {overview.psi_threshold}</Badge> : null}
        {typeof overview.share_threshold === "number" ? <Badge tone="muted">Share ≥ {fmtPercent(Number(overview.share_threshold))}</Badge> : null}
      </div>

      {warnings.length ? (
        <div className="space-y-1 rounded-lg border border-warning/35 bg-warning/10 p-3">
          {warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2 text-xs leading-relaxed">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Prediction drift" description="Output distribution only; this is not concept drift." contentClassName="pt-2">
          {Object.keys(prediction).length ? (
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={prediction.drifted ? "warning" : "success"}>{prediction.drifted ? "Shift detected" : "Stable"}</Badge>
                <span className="text-muted-foreground">PSI</span>
                <span className="font-medium tabular-nums">{fmtMetric(Number(prediction.psi), 4)}</span>
                <span className="text-muted-foreground">threshold {fmtMetric(Number(prediction.threshold), 4)}</span>
              </div>
              <p className="text-muted-foreground">{String(prediction.recommendation ?? "")}</p>
              <div className="text-[11px] text-muted-foreground">
                Baseline {fmtNumber(Number(prediction.reference_sample_size))} · current {fmtNumber(Number(prediction.current_sample_size))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Prediction drift was not assessed for this report.</p>
          )}
        </SectionCard>

        <SectionCard
          title="Concept drift"
          description="Requires labels and is never confirmed by distribution tests alone."
          contentClassName="pt-2"
        >
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={String(concept.status ?? "not_assessed")} />
              {typeof concept.performance_degraded === "boolean" ? (
                <Badge tone={concept.performance_degraded ? "danger" : "success"}>
                  {concept.performance_degraded ? "Performance degraded" : "Performance within threshold"}
                </Badge>
              ) : null}
              <span className="text-muted-foreground">{fmtNumber(Number(concept.labels_evaluated ?? 0))} labels</span>
            </div>
            <p className="text-muted-foreground">{String(concept.explanation ?? concept.message ?? "")}</p>
            {concept.message ? <p className="text-[11px] text-muted-foreground">{String(concept.message)}</p> : null}
          </div>
        </SectionCard>
      </div>

      {missing.length || added.length || typeChanges.length ? (
        <SectionCard title="Schema changes" contentClassName="pt-2">
          <div className="grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <div className="font-medium">Missing features</div>
              <p className="text-muted-foreground">{missing.length ? missing.join(", ") : "None"}</p>
            </div>
            <div>
              <div className="font-medium">Added features</div>
              <p className="text-muted-foreground">{added.length ? added.join(", ") : "None"}</p>
            </div>
            <div>
              <div className="font-medium">Type changes</div>
              <p className="text-muted-foreground">{typeChanges.length ? typeChanges.join(", ") : "None"}</p>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Feature-level evidence"
        description="PSI is the primary effect-size signal; KS / chi-square p-values are adjusted with Benjamini–Hochberg."
        contentClassName="p-0"
      >
        <div className="max-h-80 overflow-auto">
          <Table>
            <THead>
              <TR>
                <TH>Feature</TH>
                <TH>Method</TH>
                <TH>PSI</TH>
                <TH>Statistic</TH>
                <TH>Adj. p</TH>
                <TH>Missing (ref → cur)</TH>
                <TH>Samples</TH>
                <TH>Severity</TH>
              </TR>
            </THead>
            <TBody>
              {report.features.map((feature) => (
                <TR key={feature.feature}>
                  <TD className="font-mono text-[11px]">{feature.feature}</TD>
                  <TD className="text-[11px] text-muted-foreground">{feature.method}</TD>
                  <TD className="tabular-nums">{fmtMetric(feature.psi, 4)}</TD>
                  <TD className="tabular-nums">{fmtMetric(feature.statistic, 4)}</TD>
                  <TD className="tabular-nums">{fmtMetric(feature.adjusted_p_value, 4)}</TD>
                  <TD className="tabular-nums text-[11px]">
                    {fmtPercent(feature.reference_missing_rate)} → {fmtPercent(feature.current_missing_rate)}
                  </TD>
                  <TD className="tabular-nums text-[11px]">
                    {fmtNumber(feature.reference_sample_size)} → {fmtNumber(feature.current_sample_size)}
                  </TD>
                  <TD><SeverityBadge severity={feature.severity} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </SectionCard>

      {recommendations.length ? (
        <SectionCard title="Recommendations" contentClassName="pt-2">
          <ul className="space-y-1.5 text-xs leading-relaxed">
            {recommendations.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {Object.keys(evidently).length ? (
        <SectionCard title="Evidently cross-check" description="Secondary evidence; the custom statistics above drive severity." contentClassName="pt-2">
          <div className="flex flex-wrap gap-2 text-[11px]">
            {Object.entries(evidently).slice(0, 12).map(([key, value]) => (
              <Badge key={key} tone="muted">
                {titleCase(key)}: {typeof value === "object" ? "see report JSON" : String(value)}
              </Badge>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <GitCompareArrows className="size-3.5" /> Report {report.id}
        <FlaskConical className="size-3.5" /> Simulated samples are labelled in the report
        {report.status === "completed" ? <CheckCircle2 className="size-3.5 text-success" /> : <BarChart3 className="size-3.5" />}
      </div>
    </div>
  );
}
