"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Database,
  Gauge,
  HeartPulse,
  PackageCheck,
  ShieldCheck,
  Timer,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { CopyButton, SectionCard, SeverityBadge, StatusBadge } from "@/components/common";
import {
  Badge,
  Button,
  ErrorState,
  LoadingCards,
  Skeleton,
  StatCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { api } from "@/lib/api";
import {
  useDatasets,
  useDeploymentMonitoring,
  useVersion,
} from "@/lib/hooks";
import type { Deployment, HealthStatus } from "@/lib/types";
import {
  errorMessage,
  fmtDate,
  fmtMetric,
  fmtMs,
  fmtNumber,
  fmtPercent,
  fmtRelative,
  metricLabel,
  titleCase,
  truncateMiddle,
} from "@/lib/utils";

function HistoryTable({ deployment }: { deployment: Deployment }) {
  const history = Array.isArray(deployment.config.deployed_version_history) ? deployment.config.deployed_version_history : [];
  if (!history.length) {
    return <p className="text-xs text-muted-foreground">No deployment history recorded yet.</p>;
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH>Action</TH>
          <TH>Version</TH>
          <TH>At</TH>
          <TH>By</TH>
        </TR>
      </THead>
      <TBody>
        {history
          .slice()
          .reverse()
          .map((item, index) => (
            <TR key={`${String(item.model_version_id ?? index)}-${index}`}>
              <TD className="text-xs">{titleCase(String(item.action ?? "deploy"))}</TD>
              <TD className="text-xs tabular-nums">v{String(item.model_version ?? "—")}</TD>
              <TD className="text-[11px] text-muted-foreground">{fmtDate(String(item.deployed_at ?? ""))}</TD>
              <TD className="font-mono text-[10px] text-muted-foreground">{truncateMiddle(String(item.deployed_by ?? "—"), 8, 4)}</TD>
            </TR>
          ))}
      </TBody>
    </Table>
  );
}

export function DeploymentOverviewPanel({ deployment }: { deployment: Deployment }) {
  const queryClient = useQueryClient();
  const { data: monitoring, isLoading, error, refetch } = useDeploymentMonitoring(deployment.id, { days: 7 });
  const { data: version } = useVersion(deployment.model_version_id);
  const { data: datasets } = useDatasets(deployment.project_id);
  const [health, setHealth] = React.useState<HealthStatus | null>(null);

  const referenceId = deployment.config.reference_dataset_version_id;
  const reference = React.useMemo(
    () => (datasets ?? []).flatMap((dataset) => dataset.versions.map((item) => ({ ...item, datasetName: dataset.name }))).find((item) => item.id === referenceId),
    [datasets, referenceId],
  );

  const healthMutation = useMutation({
    mutationFn: () => api<HealthStatus>(`/deployments/${deployment.id}/health`),
    onSuccess: (payload) => {
      setHealth(payload);
      void queryClient.invalidateQueries({ queryKey: ["deployment", deployment.id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      if (payload.status === "healthy") toast.success("Health check passed.");
      else toast.error("Health check failed. Review the artifact and model state.");
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  if (isLoading) return <LoadingCards count={4} />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;

  const metrics = monitoring?.metrics;
  const performance = monitoring?.performance;
  const resources = monitoring?.resources;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Requests · 7 days"
          value={fmtNumber(metrics?.volume)}
          hint={metrics ? `${fmtNumber(metrics.production_count)} production · ${fmtNumber(metrics.simulated_count)} simulated` : "No traffic yet"}
          icon={Activity}
        />
        <StatCard
          title="Error rate"
          value={fmtPercent(metrics?.error_rate, 2)}
          hint={metrics ? `${fmtNumber(metrics.error_count)} errors · ${fmtNumber(metrics.invalid_input_count)} invalid inputs` : "—"}
          icon={AlertTriangle}
          tone={(metrics?.error_rate ?? 0) > 0.05 ? "danger" : "success"}
        />
        <StatCard
          title="p95 latency"
          value={fmtMs(metrics?.latency_ms.p95)}
          hint={metrics ? `p50 ${fmtMs(metrics.latency_ms.p50)} · p99 ${fmtMs(metrics.latency_ms.p99)}` : "—"}
          icon={Timer}
          tone={(metrics?.latency_ms.p95 ?? 0) > 500 ? "warning" : "primary"}
        />
        <StatCard
          title="Latest drift"
          value={<SeverityBadge severity={monitoring?.latest_drift_report?.severity ?? deployment.latest_drift_severity} />}
          hint={
            monitoring?.latest_drift_report
              ? `${monitoring.latest_drift_report.drifted_feature_count}/${monitoring.latest_drift_report.feature_count} features · ${fmtRelative(monitoring.latest_drift_report.created_at)}`
              : "No drift report yet"
          }
          icon={Gauge}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Endpoint health"
          description="Loads the approved artifact and verifies it is usable."
          className="lg:col-span-1"
          contentClassName="pt-2"
          actions={
            <Button variant="outline" size="sm" onClick={() => healthMutation.mutate()} disabled={healthMutation.isPending}>
              <HeartPulse /> {healthMutation.isPending ? "Checking…" : "Check now"}
            </Button>
          }
        >
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Last recorded</span>
              <span className="flex items-center gap-1.5">
                <StatusBadge status={deployment.last_health_status} />
                <span className="text-[11px] text-muted-foreground">{fmtRelative(deployment.last_health_at)}</span>
              </span>
            </div>
            {health ? (
              <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center gap-2 font-medium">
                  {health.status === "healthy" ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-destructive" />}
                  {titleCase(health.status)}
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <span>Model {health.model_name} v{health.model_version}</span>
                  <span>{health.features} features</span>
                  <span>{health.task_type}</span>
                  <span>{fmtDate(health.checked_at)}</span>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">sha256 {truncateMiddle(health.artifact_hash, 16, 10)}</div>
              </div>
            ) : (
              <p className="text-muted-foreground">
                Run a live check to confirm the artifact hash matches the registry and the endpoint can score.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild size="sm" variant="outline">
                <Link href={`/monitoring?deployment=${deployment.id}`}>
                  Monitoring <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/explainability?deployment=${deployment.id}`}>
                  <BrainCircuit /> Explain
                </Link>
              </Button>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Model version" description="Exactly the artifact recorded at deployment time." contentClassName="pt-2">
          {version ? (
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Registered model</dt>
                <dd className="font-medium">{deployment.model_name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Version / stage</dt>
                <dd className="font-medium">
                  v{version.version} · {titleCase(version.stage)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Approval</dt>
                <dd><StatusBadge status={version.approval_status} /></dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Validation</dt>
                <dd><StatusBadge status={version.validation_status} /></dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Features</dt>
                <dd className="tabular-nums">{version.feature_schema?.length ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Approved by</dt>
                <dd>{version.approved_by_name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Approved at</dt>
                <dd>{fmtDate(version.approved_at)}</dd>
              </div>
              <div className="space-y-1 border-t pt-2">
                <dt className="text-muted-foreground">Artifact SHA-256</dt>
                <dd className="flex items-center gap-2">
                  <span className="break-all font-mono text-[10px]">{version.artifact_hash}</span>
                  <CopyButton value={version.artifact_hash} label="" className="size-7 shrink-0 px-0" />
                </dd>
              </div>
              <div className="pt-1">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/registry?project=${deployment.project_id}&model=${version.registered_model_id}`}>
                    <PackageCheck /> Open in registry
                  </Link>
                </Button>
              </div>
            </dl>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </SectionCard>

        <SectionCard title="Monitoring configuration" description="Reference data and label thresholds." contentClassName="pt-2">
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Reference dataset</dt>
              <dd className="text-right font-medium">
                {reference ? `${reference.datasetName} v${reference.version}` : referenceId ? truncateMiddle(referenceId, 8, 4) : "Not set"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Min labels</dt>
              <dd className="tabular-nums">{fmtNumber(Number(deployment.config.min_label_samples ?? 30))}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sample capture</dt>
              <dd>{deployment.config.capture_samples === false ? "Disabled" : "Enabled"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">API key prefix</dt>
              <dd className="font-mono text-[10px]">{deployment.api_key_prefix ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Created</dt>
              <dd>{fmtDate(deployment.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Health check</dt>
              <dd>{fmtRelative(deployment.last_health_at)}</dd>
            </div>
          </dl>
          <p className="mt-3 rounded-lg border bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground">
            Raw inputs are not logged by default. Captured feature samples power drift analysis and label-based performance only.
          </p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Performance with labels" description="No accuracy is shown without ground truth." className="lg:col-span-2" contentClassName="pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={performance?.status} />
            {performance?.primary_metric ? <Badge tone="muted">{metricLabel(performance.primary_metric)}</Badge> : null}
            {performance ? (
              <span className="text-[11px] text-muted-foreground">
                {fmtNumber(performance.label_count)} labels / {fmtNumber(performance.prediction_count)} predictions
              </span>
            ) : null}
            {performance?.degraded ? <Badge tone="danger">Degraded vs baseline</Badge> : null}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {performance?.message ?? "Performance will appear once labels are submitted."}
          </p>
          {performance?.metrics ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(performance.metrics)
                .filter(([, value]) => typeof value === "number")
                .slice(0, 8)
                .map(([key, value]) => (
                  <div key={key} className="rounded-lg border bg-muted/20 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{metricLabel(key)}</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtMetric(Number(value), 4)}</div>
                  </div>
                ))}
            </div>
          ) : null}
          {performance ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge tone="muted">Concept drift: {titleCase(performance.concept_drift.status)}</Badge>
              <span>Label delay p50 {performance.delayed_labels.p50_seconds === null ? "—" : fmtMs(performance.delayed_labels.p50_seconds * 1000)}</span>
              <span>· p95 {performance.delayed_labels.p95_seconds === null ? "—" : fmtMs(performance.delayed_labels.p95_seconds * 1000)}</span>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Process resources" description={String(resources?.note ?? "API process resources")} contentClassName="pt-2">
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Memory RSS</dt>
              <dd className="tabular-nums">{fmtNumber(Number(resources?.memory_rss_bytes ?? 0) / 1024 / 1024, 1)} MB</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">CPU</dt>
              <dd className="tabular-nums">{fmtNumber(resources?.cpu_percent, 1)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Threads</dt>
              <dd className="tabular-nums">{fmtNumber(resources?.threads)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Open files</dt>
              <dd className="tabular-nums">{fmtNumber(resources?.open_files)}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-start gap-2 rounded-lg border bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground">
            <Database className="mt-0.5 size-3.5 shrink-0" />
            <span>These are API-process measurements, not per-deployment attribution.</span>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Version history" description="Deployments and rollbacks are explicit, audited actions." contentClassName="p-0">
        <HistoryTable deployment={deployment} />
      </SectionCard>

      <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-[11px] leading-relaxed">
        <ShieldCheck className="size-4 shrink-0 text-success" />
        <span>
          This deployment serves a fixed approved artifact. Training improvements require a new approval, and no automatic promotion or
          rollback occurs.
        </span>
      </div>
    </div>
  );
}
