"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, FlaskConical, GitCompareArrows, Play, Radar, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SectionCard, SeverityBadge, StatusBadge } from "@/components/common";
import { DriftReportDialog } from "@/components/drift-report";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Pagination,
  Progress,
  Select,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useDriftOptions, useDriftReports, useJob } from "@/lib/hooks";
import type { Deployment, DriftReport, PipelineJob } from "@/lib/types";
import { errorMessage, fmtDate, fmtNumber, fmtPercent, fmtRelative, titleCase } from "@/lib/utils";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function RunDriftDialog({
  deployment,
  open,
  onOpenChange,
}: {
  deployment: Deployment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: options } = useDriftOptions(deployment.project_id);
  const [referenceId, setReferenceId] = React.useState("");
  const [currentId, setCurrentId] = React.useState("");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const { data: job } = useJob(jobId);
  const notified = React.useRef(false);

  React.useEffect(() => {
    if (open) {
      const deploymentOption = options?.deployments.find((item) => item.id === deployment.id);
      setReferenceId(deploymentOption?.reference_dataset_version_id ?? String(deployment.config.reference_dataset_version_id ?? ""));
      setCurrentId("");
      setJobId(null);
      notified.current = false;
    }
  }, [deployment.config.reference_dataset_version_id, deployment.id, open, options?.deployments]);

  React.useEffect(() => {
    if (!job) return;
    if (job.status === "succeeded" && !notified.current) {
      notified.current = true;
      toast.success("Drift analysis completed. The new report is available.");
      void queryClient.invalidateQueries({ queryKey: ["drift-reports"] });
      void queryClient.invalidateQueries({ queryKey: ["deployment-monitoring", deployment.id] });
      void queryClient.invalidateQueries({ queryKey: ["deployment", deployment.id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    }
    if (job.status === "failed" && !notified.current) {
      notified.current = true;
      toast.error(job.error || "Drift analysis failed.");
    }
  }, [deployment.id, job, queryClient]);

  const mutation = useMutation({
    mutationFn: () =>
      api<PipelineJob>("/drift/analyze", {
        method: "POST",
        body: {
          project_id: deployment.project_id,
          deployment_id: deployment.id,
          reference_dataset_version_id: referenceId || null,
          current_dataset_version_id: currentId || null,
        },
      }),
    onSuccess: (payload) => {
      setJobId(payload.id);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Drift analysis queued.");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const datasetVersions = options?.dataset_versions ?? [];
  const running = job?.status === "queued" || job?.status === "running";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Run drift analysis</DialogTitle>
          <DialogDescription>
            Compares the reference dataset or captured production features with a current dataset snapshot. The analysis runs as a
            background job and stores a historical report.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Reference dataset version" hint="Baseline distribution">
            <Select value={referenceId} onChange={(event) => setReferenceId(event.target.value)}>
              <option value="">Use deployment reference</option>
              {datasetVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.dataset_name} v{version.version} · {fmtNumber(version.rows)} rows
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Current data" hint="Leave empty to use captured production samples">
            <Select value={currentId} onChange={(event) => setCurrentId(event.target.value)}>
              <option value="">Captured production features</option>
              {datasetVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.dataset_name} v{version.version} · {fmtNumber(version.rows)} rows
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Low-sample windows are reported explicitly. Multiple feature comparisons use Benjamini–Hochberg FDR. Concept drift is never
              confirmed without ground-truth labels.
            </span>
          </div>
          {job ? (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={job.status} />
                <span className="text-[11px] text-muted-foreground">{job.stage}</span>
              </div>
              <Progress value={job.progress} tone={job.status === "failed" ? "danger" : "primary"} />
              {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
              {job.status === "succeeded" ? (
                <p className="text-xs text-success">Analysis complete. Close this dialog to view the report.</p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {job?.status === "succeeded" ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || running}>
            <Play /> {mutation.isPending ? "Queueing…" : running ? "Analysis running…" : "Start analysis"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeploymentDriftPanel({ deployment }: { deployment: Deployment }) {
  const [offset, setOffset] = React.useState(0);
  const [runOpen, setRunOpen] = React.useState(false);
  const [reportId, setReportId] = React.useState<string | null>(null);
  const limit = 10;
  const { data, isLoading, error, refetch, isFetching } = useDriftReports({ deployment_id: deployment.id, limit, offset });
  const reports = data?.items ?? [];
  const latest = reports[0];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Latest drift report"
          description="Feature, dataset, and prediction distribution evidence."
          className="lg:col-span-2"
          actions={
            <Button size="sm" onClick={() => setRunOpen(true)}>
              <Radar /> Run analysis
            </Button>
          }
        >
          {latest ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={latest.severity} />
                <StatusBadge status={latest.status} />
                <Badge tone="muted">{titleCase(latest.engine)}</Badge>
                <span className="text-[11px] text-muted-foreground">{fmtRelative(latest.created_at)}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Drifted</div>
                  <div className="text-sm font-semibold tabular-nums">{latest.drifted_feature_count}/{latest.feature_count}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Share</div>
                  <div className="text-sm font-semibold tabular-nums">{fmtPercent(latest.drift_share)}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Reference rows</div>
                  <div className="text-sm font-semibold tabular-nums">{fmtNumber(latest.reference_sample_size)}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current rows</div>
                  <div className="text-sm font-semibold tabular-nums">{fmtNumber(latest.current_sample_size)}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {latest.reference_label ?? "Reference"} → {latest.current_label ?? "Current"}
              </p>
              {asStringArray(latest.summary.warnings).length ? (
                <div className="space-y-1 rounded-lg border border-warning/35 bg-warning/10 p-2.5">
                  {asStringArray(latest.summary.warnings).slice(0, 3).map((warning) => (
                    <div key={warning} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setReportId(latest.id)}>
                  <GitCompareArrows /> Open report
                </Button>
                <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
                </Button>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Radar}
              title="No drift report yet"
              description="Run an analysis to compare the reference distribution with captured production features or a dataset snapshot."
              className="border-0"
              action={
                <Button size="sm" onClick={() => setRunOpen(true)}>
                  <Radar /> Run analysis
                </Button>
              }
            />
          )}
        </SectionCard>

        <SectionCard title="What this means" description="Signals are intentionally separated." contentClassName="pt-2">
          <div className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Data drift</span> compares feature distributions. It can be caused by a new
              population or a collection defect.
            </p>
            <p>
              <span className="font-medium text-foreground">Prediction drift</span> compares output distributions. It is not evidence of
              concept drift by itself.
            </p>
            <p>
              <span className="font-medium text-foreground">Concept drift</span> requires labels and is only suspected when labelled
              performance degrades. It is never confirmed from distribution tests alone.
            </p>
            <p className="flex items-start gap-1.5">
              <ArrowRight className="mt-0.5 size-3 shrink-0" /> Alerts are deduplicated and cooldown-controlled.
            </p>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Drift report history" description="Reports are stored with their configuration and feature-level results." contentClassName="p-0">
        {isLoading ? (
          <LoadingBlock label="Loading drift reports…" />
        ) : error ? (
          <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
        ) : !reports.length ? (
          <EmptyState icon={Radar} title="No reports" description="Run an analysis to create the first report." className="border-0" />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Created</TH>
                  <TH>Severity</TH>
                  <TH>Status</TH>
                  <TH>Drifted</TH>
                  <TH>Share</TH>
                  <TH>Samples</TH>
                  <TH>Reference</TH>
                  <TH className="text-right">Report</TH>
                </TR>
              </THead>
              <TBody>
                {reports.map((report: DriftReport) => (
                  <TR key={report.id}>
                    <TD className="text-[11px] text-muted-foreground">{fmtDate(report.created_at)}</TD>
                    <TD><SeverityBadge severity={report.severity} /></TD>
                    <TD><StatusBadge status={report.status} /></TD>
                    <TD className="text-xs tabular-nums">{report.drifted_feature_count}/{report.feature_count}</TD>
                    <TD className="text-xs tabular-nums">{fmtPercent(report.drift_share)}</TD>
                    <TD className="text-[11px] tabular-nums text-muted-foreground">
                      {fmtNumber(report.reference_sample_size)} → {fmtNumber(report.current_sample_size)}
                    </TD>
                    <TD className="max-w-48 truncate text-[11px] text-muted-foreground">{report.reference_label ?? "—"}</TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setReportId(report.id)}>
                        View
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </SectionCard>

      <RunDriftDialog deployment={deployment} open={runOpen} onOpenChange={setRunOpen} />
      <DriftReportDialog reportId={reportId} open={Boolean(reportId)} onOpenChange={(open) => !open && setReportId(null)} />
    </div>
  );
}
