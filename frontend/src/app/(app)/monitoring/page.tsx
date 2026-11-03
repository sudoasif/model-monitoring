"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  BrainCircuit,
  CheckCircle2,
  Database,
  FlaskConical,
  Gauge,
  RefreshCw,
  Server,
  Timer,
} from "lucide-react";

import {
  DeploymentSelect,
  ProjectSelect,
  SectionCard,
  SeverityBadge,
  SimulatedBadge,
  StatusBadge,
} from "@/components/common";
import {
  ConfidenceBars,
  DistributionChart,
  LatencyChart,
  TrafficChart,
  VersionUsageChart,
} from "@/components/charts";
import { DeploymentDriftPanel } from "@/components/deployment-drift";
import { PerformanceSection } from "@/components/performance-section";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { useDeploymentMonitoring, useDeployments } from "@/lib/hooks";
import {
  errorMessage,
  fmtBytes,
  fmtDate,
  fmtMs,
  fmtNumber,
  fmtPercent,
  fmtRelative,
  titleCase,
} from "@/lib/utils";

type RangeKey = "24h" | "7d" | "30d" | "90d";

const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

function rangeParams(range: RangeKey): { days?: number; hours?: number } {
  if (range === "24h") return { hours: 24 };
  return { days: Number(range.replace("d", "")) };
}

function rangeDays(range: RangeKey): number {
  return range === "24h" ? 1 : Number(range.replace("d", ""));
}

function DataQualityTable({ quality }: { quality: NonNullable<ReturnType<typeof useDeploymentMonitoring>["data"]>["data_quality"] }) {
  const features = (quality.features ?? []).slice().sort((a, b) => Math.abs(b.missing_delta) - Math.abs(a.missing_delta));
  const schemaChanges = quality.schema_changes ?? { missing_features: [], added_features: [], type_changes: [] };
  const hasSchemaChanges =
    schemaChanges.missing_features.length > 0 ||
    schemaChanges.added_features.length > 0 ||
    schemaChanges.type_changes.length > 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={quality.status} />
        <Badge tone="muted">{fmtNumber(quality.sample_count)} samples</Badge>
        {quality.window ? (
          <span className="text-[11px] text-muted-foreground">
            {fmtDate(quality.window.start)} → {fmtDate(quality.window.end)}
          </span>
        ) : null}
        {quality.latest_drift_severity ? <SeverityBadge severity={quality.latest_drift_severity} /> : null}
      </div>
      {quality.message ? (
        <p className="rounded-lg border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">{quality.message}</p>
      ) : null}
      {hasSchemaChanges ? (
        <div className="space-y-1 rounded-lg border border-warning/35 bg-warning/10 p-3 text-[11px] leading-relaxed">
          {schemaChanges.missing_features.length ? (
            <p><span className="font-medium">Missing features:</span> {schemaChanges.missing_features.join(", ")}</p>
          ) : null}
          {schemaChanges.added_features.length ? (
            <p><span className="font-medium">Added features:</span> {schemaChanges.added_features.join(", ")}</p>
          ) : null}
          {schemaChanges.type_changes.length ? (
            <p><span className="font-medium">Type changes:</span> {schemaChanges.type_changes.join(", ")}</p>
          ) : null}
        </div>
      ) : null}
      {features.length ? (
        <Table>
          <THead>
            <TR>
              <TH>Feature</TH>
              <TH>Missing rate</TH>
              <TH>Reference</TH>
              <TH>Δ</TH>
              <TH>Samples</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {features.slice(0, 20).map((feature) => (
              <TR key={feature.name}>
                <TD className="font-mono text-[11px]">{feature.name}</TD>
                <TD className="text-xs tabular-nums">{fmtPercent(feature.missing_rate)}</TD>
                <TD className="text-xs tabular-nums text-muted-foreground">{fmtPercent(feature.reference_missing_rate)}</TD>
                <TD className={`text-xs tabular-nums ${feature.missing_delta > 0.05 ? "text-destructive" : "text-muted-foreground"}`}>
                  {feature.missing_delta >= 0 ? "+" : ""}
                  {fmtPercent(feature.missing_delta)}
                </TD>
                <TD className="text-xs tabular-nums">{fmtNumber(feature.sample_count)}</TD>
                <TD><StatusBadge status={feature.status} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground">No captured feature samples in this window. Enable sample capture and send traffic.</p>
      )}
    </div>
  );
}

function MonitoringContent() {
  const searchParams = useSearchParams();
  const [projectId, setProjectId] = React.useState(searchParams.get("project") ?? "");
  const [deploymentId, setDeploymentId] = React.useState(searchParams.get("deployment") ?? "");
  const [range, setRange] = React.useState<RangeKey>("7d");
  const [granularity, setGranularity] = React.useState("day");
  const [simulated, setSimulated] = React.useState("all");

  const { data: deploymentData } = useDeployments({ project_id: projectId || undefined, limit: 100 });
  const deployments = React.useMemo(() => deploymentData?.items ?? [], [deploymentData]);

  React.useEffect(() => {
    if (!deployments.length) {
      if (deploymentId) setDeploymentId("");
      return;
    }
    if (!deploymentId || !deployments.some((item) => item.id === deploymentId)) {
      setDeploymentId(deployments[0].id);
    }
  }, [deployments, deploymentId]);

  const params = React.useMemo(
    () => ({ ...rangeParams(range), granularity, simulated }),
    [granularity, range, simulated],
  );
  const { data, isLoading, error, refetch, isFetching } = useDeploymentMonitoring(deploymentId || null, params);

  const days = rangeDays(range);
  const metrics = data?.metrics;
  const timeseries = data?.timeseries.points ?? [];
  const distributionBuckets = React.useMemo(() => {
    const distribution = metrics?.prediction_distribution;
    if (!distribution) return [];
    if (distribution.buckets?.length) return distribution.buckets;
    if (distribution.bins && distribution.counts) {
      return distribution.counts.map((count, index) => ({
        value: `${fmtNumber(distribution.bins?.[index], 2)}–${fmtNumber(distribution.bins?.[index + 1], 2)}`,
        count,
        share: 0,
      }));
    }
    return [];
  }, [metrics?.prediction_distribution]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Observe"
        title="Monitoring"
        description="Real request volume, latency percentiles, error and invalid-input rates, prediction distributions, resource usage, drift, and label-gated performance."
        actions={
          <>
            {deploymentId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/alerts?deployment=${deploymentId}`}>
                  <BellRing /> Alerts
                </Link>
              </Button>
            ) : null}
            {deploymentId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/deployments/${deploymentId}`}>
                  <ArrowRight /> Deployment
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
            </Button>
          </>
        }
      />

      <SectionCard contentClassName="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectSelect value={projectId} onChange={(value) => { setProjectId(value); setDeploymentId(""); }} allowAll />
          <DeploymentSelect value={deploymentId} onChange={setDeploymentId} projectId={projectId || null} />
          <Select value={range} onChange={(event) => setRange(event.target.value as RangeKey)} className="h-8 max-w-40 text-xs" aria-label="Time window">
            {Object.entries(RANGE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </Select>
          <Select value={granularity} onChange={(event) => setGranularity(event.target.value)} className="h-8 max-w-32 text-xs" aria-label="Granularity">
            <option value="hour">Hourly</option>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
          </Select>
          <Select value={simulated} onChange={(event) => setSimulated(event.target.value)} className="h-8 max-w-40 text-xs" aria-label="Traffic source">
            <option value="all">All traffic</option>
            <option value="production">Production only</option>
            <option value="simulated">Simulated only</option>
          </Select>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {data?.metrics.sampled ? <Badge tone="warning">sampled window</Badge> : null}
            {data?.metrics.source ? <Badge tone="muted">{titleCase(data.metrics.source)}</Badge> : null}
            {data?.simulated_filter !== "all" ? <SimulatedBadge simulated={data?.simulated_filter === "simulated"} /> : null}
          </div>
        </div>
      </SectionCard>

      {!deploymentId ? (
        <EmptyState
          icon={Activity}
          title="No deployment selected"
          description="Create a deployment and send authenticated predictions to populate monitoring. Every metric on this page is derived from stored prediction events."
          action={
            <Button asChild size="sm">
              <Link href="/deployments">Open deployments</Link>
            </Button>
          }
        />
      ) : isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 w-full" />)}
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
      ) : !data || !metrics ? (
        <EmptyState icon={Activity} title="No monitoring data" description="The selected deployment has no telemetry for this window." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title="Requests"
              value={fmtNumber(metrics.volume)}
              hint={`${fmtNumber(metrics.production_count)} production · ${fmtNumber(metrics.simulated_count)} simulated`}
              icon={Activity}
            />
            <StatCard
              title="Error rate"
              value={fmtPercent(metrics.error_rate, 2)}
              hint={`${fmtNumber(metrics.error_count)} errors · ${fmtNumber(metrics.invalid_input_count)} invalid inputs`}
              icon={AlertTriangle}
              tone={metrics.error_rate > 0.05 ? "danger" : "success"}
            />
            <StatCard
              title="p95 latency"
              value={fmtMs(metrics.latency_ms.p95)}
              hint={`p50 ${fmtMs(metrics.latency_ms.p50)} · p99 ${fmtMs(metrics.latency_ms.p99)} · avg ${fmtMs(metrics.latency_ms.avg)}`}
              icon={Timer}
              tone={(metrics.latency_ms.p95 ?? 0) > 500 ? "warning" : "primary"}
            />
            <StatCard
              title="Confidence"
              value={metrics.confidence.avg === null ? "—" : fmtPercent(metrics.confidence.avg, 1)}
              hint={`min ${fmtPercent(metrics.confidence.min)} · max ${fmtPercent(metrics.confidence.max)} · ${fmtNumber(metrics.labels_count)} labels`}
              icon={Gauge}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <SectionCard title="Request volume" description="Requests and errors per bucket.">
              <TrafficChart data={timeseries} granularity={data.window.granularity} height={250} />
            </SectionCard>
            <SectionCard title="Latency" description="End-to-end prediction latency percentiles.">
              <LatencyChart data={timeseries} granularity={data.window.granularity} height={250} />
            </SectionCard>
            <SectionCard title="Prediction distribution" description="Model outputs in the selected window.">
              <DistributionChart buckets={distributionBuckets} height={250} />
            </SectionCard>
            <SectionCard title="Version usage" description="Which deployed model versions produced these events.">
              <VersionUsageChart items={metrics.version_usage} />
            </SectionCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <SectionCard title="Confidence" description="Confidence is model-provided and not calibrated accuracy." contentClassName="pt-3">
              <ConfidenceBars avg={metrics.confidence.avg} min={metrics.confidence.min} max={metrics.confidence.max} />
            </SectionCard>
            <SectionCard title="Error breakdown" description="Errors are counted; raw inputs are not logged." contentClassName="pt-2">
              {metrics.errors_by_type?.length ? (
                <div className="space-y-2">
                  {metrics.errors_by_type.map((item) => (
                    <div key={item.error_type} className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-[11px]">{item.error_type}</span>
                      <Badge tone="danger">{fmtNumber(item.count)}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="size-4 text-success" /> No errors recorded in this window.
                </p>
              )}
            </SectionCard>
            <SectionCard title="API process resources" description={String(data.resources.note ?? "")} contentClassName="pt-2">
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between"><dt className="text-muted-foreground">Memory RSS</dt><dd className="tabular-nums">{fmtBytes(data.resources.memory_rss_bytes)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Memory VMS</dt><dd className="tabular-nums">{fmtBytes(data.resources.memory_vms_bytes)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">CPU</dt><dd className="tabular-nums">{fmtNumber(data.resources.cpu_percent, 1)}%</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Threads</dt><dd className="tabular-nums">{fmtNumber(data.resources.threads)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Open files</dt><dd className="tabular-nums">{fmtNumber(data.resources.open_files)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Measured</dt><dd>{fmtRelative(data.resources.measured_at)}</dd></div>
              </dl>
              <p className="mt-2 text-[10px] text-muted-foreground">Process-wide measurement, not per-deployment attribution.</p>
            </SectionCard>
          </div>

          <SectionCard
            title="Data quality"
            description="Missing values and schema changes compared with the deployment reference dataset."
            contentClassName="pt-2"
          >
            <DataQualityTable quality={data.data_quality} />
          </SectionCard>

          <PerformanceSection deploymentId={deploymentId} days={days} />

          <DeploymentDriftPanel deployment={data.deployment} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)]">
            <SectionCard title="Recent predictions" description="No raw feature payloads are shown." contentClassName="p-0">
              {data.recent_predictions.length ? (
                <Table>
                  <THead>
                    <TR>
                      <TH>Time</TH>
                      <TH>Request</TH>
                      <TH>Prediction</TH>
                      <TH>Confidence</TH>
                      <TH>Latency</TH>
                      <TH>Status</TH>
                      <TH>Source</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.recent_predictions.map((row) => (
                      <TR key={row.id}>
                        <TD className="whitespace-nowrap text-[11px] text-muted-foreground">{fmtDate(row.timestamp)}</TD>
                        <TD className="max-w-40 truncate font-mono text-[10px]">{row.request_id}</TD>
                        <TD className="text-xs">{row.prediction ?? "—"}</TD>
                        <TD className="text-xs tabular-nums">{fmtPercent(row.confidence, 1)}</TD>
                        <TD className="text-xs tabular-nums">{fmtMs(row.latency_ms)}</TD>
                        <TD><StatusBadge status={row.status} /></TD>
                        <TD><SimulatedBadge simulated={row.simulated} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <EmptyState icon={Activity} title="No predictions yet" description="Send a request from the deployment playground or API." className="border-0" />
              )}
            </SectionCard>

            <div className="space-y-4">
              <SectionCard title="Model & artifact" contentClassName="pt-2">
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Model</dt><dd className="font-medium">{data.deployment.model_name} v{data.model_version.version}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Artifact size</dt><dd>{fmtBytes(data.model_version.artifact_size_bytes)}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Reference</dt><dd className="text-right">{data.deployment.config.reference_dataset_version_id ? "Configured" : "Missing"}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Health</dt><dd><StatusBadge status={data.deployment.last_health_status} /></dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Drift</dt><dd><SeverityBadge severity={data.latest_drift_report?.severity} /></dd></div>
                </dl>
              </SectionCard>
              <SectionCard title="Investigate" contentClassName="pt-2">
                <div className="space-y-2">
                  <Button asChild variant="outline" size="sm" className="w-full justify-start">
                    <Link href={`/explainability?deployment=${deploymentId}`}><BrainCircuit /> Explainability</Link>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="w-full justify-start">
                    <Link href={`/alerts?deployment=${deploymentId}`}><BellRing /> Alerts & incidents</Link>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="w-full justify-start">
                    <Link href={`/pipelines?deployment=${deploymentId}`}><Server /> Pipeline jobs</Link>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="w-full justify-start">
                    <Link href={`/deployments/${deploymentId}`}><Database /> Predictions & labels</Link>
                  </Button>
                </div>
              </SectionCard>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Metrics are computed from stored prediction events. Simulated events are always marked and can be excluded. Performance
              metrics appear only when enough ground-truth labels exist; the API returns an explicit insufficient-labels state otherwise.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default function MonitoringPage() {
  return (
    <React.Suspense fallback={<LoadingBlock label="Loading monitoring…" />}>
      <MonitoringContent />
    </React.Suspense>
  );
}
