"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitBranch,
  Play,
  RefreshCw,
  ShieldCheck,
  Timer,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import { SectionCard, StatusBadge } from "@/components/common";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Progress,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
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
import { useDatasets, useRetrainingStatus } from "@/lib/hooks";
import type { Deployment, PipelineJob } from "@/lib/types";
import { errorMessage, fmtDate, fmtMetric, fmtNumber, fmtPercent, fmtRelative, metricLabel, titleCase } from "@/lib/utils";

function JobStatus({ job }: { job: PipelineJob }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={job.status} />
      <Badge tone="muted">{titleCase(job.job_type)}</Badge>
      {job.attempts > 0 ? <Badge tone="muted">attempt {job.attempts}/{job.max_attempts}</Badge> : null}
      {job.simulated ? <Badge tone="warning">Simulated</Badge> : null}
    </div>
  );
}

function ScheduleRetrainingDialog({
  deployment,
  open,
  onOpenChange,
  labelStatus,
  minLabels,
}: {
  deployment: Deployment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelStatus: string;
  minLabels: number;
}) {
  const queryClient = useQueryClient();
  const { data: datasets } = useDatasets(deployment.project_id);
  const [datasetVersionId, setDatasetVersionId] = React.useState("");
  const [tune, setTune] = React.useState(false);
  const [nTrials, setNTrials] = React.useState(10);
  const [minNewLabels, setMinNewLabels] = React.useState(minLabels);
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setDatasetVersionId("");
      setTune(false);
      setNTrials(10);
      setMinNewLabels(minLabels);
      setNotes("");
    }
  }, [open, minLabels]);

  const versions = React.useMemo(
    () => (datasets ?? []).flatMap((dataset) => dataset.versions.map((version) => ({ ...version, datasetName: dataset.name }))),
    [datasets],
  );

  const mutation = useMutation({
    mutationFn: () =>
      api<PipelineJob>("/retrain", {
        method: "POST",
        body: {
          project_id: deployment.project_id,
          deployment_id: deployment.id,
          dataset_version_id: datasetVersionId || null,
          tune,
          n_trials: Number(nTrials) || 10,
          min_new_labels: Number(minNewLabels) || minLabels,
          notes: notes.trim(),
        },
      }),
    onSuccess: (job) => {
      toast.success("Retraining job queued. It will re-check label sufficiency before training.");
      void queryClient.invalidateQueries({ queryKey: ["retraining-status", deployment.id] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["job", job.id] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Schedule retraining</DialogTitle>
          <DialogDescription>
            A candidate is trained, registered, and left pending approval. It is never deployed automatically, even when offline metrics
            improve.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {labelStatus !== "sufficient" ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                Label sufficiency is currently <span className="font-medium">{titleCase(labelStatus)}</span>. The job will fail
                explicitly when it runs unless enough labelled predictions with captured features exist, or an explicit dataset version
                is provided.
              </span>
            </div>
          ) : null}
          <Field label="Training dataset" hint="Optional; defaults to monitored labelled data">
            <Select value={datasetVersionId} onChange={(event) => setDatasetVersionId(event.target.value)}>
              <option value="">Use monitored labelled data</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.datasetName} v{version.version} · {fmtNumber(version.row_count)} rows
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className="text-xs font-medium">Optuna hyperparameter tuning</div>
              <p className="text-[11px] text-muted-foreground">Runs real trials inside the training job. Increases duration.</p>
            </div>
            <Switch checked={tune} onCheckedChange={setTune} aria-label="Enable hyperparameter tuning" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Optuna trials" hint="1–50">
              <Input type="number" min={1} max={50} value={nTrials} onChange={(event) => setNTrials(Number(event.target.value))} disabled={!tune} />
            </Field>
            <Field label="Minimum new labels" hint="re-checked at execution">
              <Input type="number" min={1} value={minNewLabels} onChange={(event) => setMinNewLabels(Number(event.target.value))} />
            </Field>
          </div>
          <Field label="Notes" hint={`${notes.length}/2000`}>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Why is retraining being requested? What changed in the data or population?"
              maxLength={2000}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            <Play /> {mutation.isPending ? "Queueing…" : "Queue retraining"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeploymentRetrainingPanel({ deployment }: { deployment: Deployment }) {
  const { data, isLoading, error, refetch, isFetching } = useRetrainingStatus(deployment.id);
  const [open, setOpen] = React.useState(false);

  if (isLoading) return <LoadingBlock label="Checking label sufficiency and retraining history…" />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;
  if (!data) return null;

  const comparison = data.last_comparison;
  const active = data.active_job;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <SectionCard title="Label sufficiency" description="Retraining consumes labelled predictions with captured features." contentClassName="pt-2">
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={data.label_status} />
              <Badge tone="muted">
                {fmtNumber(data.label_stats.labels_with_features)} / {fmtNumber(data.min_labels_required)} required
              </Badge>
            </div>
            <Progress
              value={Math.min(100, (data.label_stats.labels_with_features / Math.max(1, data.min_labels_required)) * 100)}
              tone={data.label_status === "sufficient" ? "success" : "warning"}
            />
            <div className="grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground">
              <span>Labelled events</span>
              <span className="text-right font-medium text-foreground">{fmtNumber(data.label_stats.labelled_events)}</span>
              <span>With captured features</span>
              <span className="text-right font-medium text-foreground">{fmtNumber(data.label_stats.labels_with_features)}</span>
              <span>Feature coverage</span>
              <span className="text-right font-medium text-foreground">{fmtPercent(data.label_stats.feature_coverage)}</span>
              <span>Latest label</span>
              <span className="text-right font-medium text-foreground">{fmtRelative(data.label_stats.latest_label_at)}</span>
              <span>Counted since</span>
              <span className="text-right font-medium text-foreground">{fmtDate(data.label_stats.counted_since)}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{data.note}</p>
          </div>
        </SectionCard>

        <SectionCard title="Baseline model" description="The candidate is compared against the currently deployed version." contentClassName="pt-2">
          {data.baseline_model_version ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Version</span>
                <span className="font-medium">v{data.baseline_model_version.version}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Stage</span>
                <Badge tone="muted">{titleCase(data.baseline_model_version.stage)}</Badge>
              </div>
              <div className="grid gap-1.5 border-t pt-2 text-[11px]">
                {Object.entries(data.baseline_model_version.metrics)
                  .filter(([, value]) => typeof value === "number")
                  .slice(0, 5)
                  .map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{metricLabel(key)}</span>
                      <span className="font-medium tabular-nums">{fmtMetric(Number(value), 4)}</span>
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">The baseline model version is unavailable.</p>
          )}
        </SectionCard>

        <SectionCard
          title="Last comparison"
          description="Advisory only. Registration does not imply deployment."
          actions={
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
            </Button>
          }
          contentClassName="pt-2"
        >
          {comparison ? (
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={comparison.recommendation === "keep_baseline" ? "success" : "warning"}>
                  {titleCase(String(comparison.recommendation ?? "unknown"))}
                </Badge>
                {comparison.primary_metric ? <Badge tone="muted">{metricLabel(String(comparison.primary_metric))}</Badge> : null}
                {comparison.approval_required ? <Badge tone="info"><ShieldCheck /> Approval required</Badge> : null}
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground">
                <span>Baseline</span>
                <span className="text-right font-medium text-foreground">{fmtMetric(Number(comparison.baseline_value), 4)}</span>
                <span>Candidate</span>
                <span className="text-right font-medium text-foreground">{fmtMetric(Number(comparison.candidate_value), 4)}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{String(comparison.reason ?? "")}</p>
              {comparison.candidate_model_version_id ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/registry?project=${deployment.project_id}`}>
                    Review candidate <ArrowRight />
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No completed retraining comparison yet.</p>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Active retraining job"
        description="Background jobs are durable, deduplicated, and retryable."
        actions={
          <Button size="sm" onClick={() => setOpen(true)} disabled={Boolean(active)}>
            <GitBranch /> Schedule retraining
          </Button>
        }
      >
        {active ? (
          <div className="space-y-2">
            <JobStatus job={active} />
            <Progress value={active.progress} tone={active.status === "failed" ? "danger" : "primary"} />
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>{active.stage}</span>
              <span>{active.progress}%</span>
              <span>queued {fmtRelative(active.created_at)}</span>
              <span>attempts {active.attempts}/{active.max_attempts}</span>
            </div>
            {active.error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{active.error}</p> : null}
          </div>
        ) : (
          <EmptyState
            icon={Workflow}
            title="No active retraining job"
            description="Schedule retraining when label coverage is sufficient or when an explicit, versioned dataset is ready."
            className="border-0"
            action={
              <Button size="sm" onClick={() => setOpen(true)}>
                <GitBranch /> Schedule retraining
              </Button>
            }
          />
        )}
      </SectionCard>

      <SectionCard title="Recent retraining jobs" description="Real pipeline jobs with retries, stages, and logs." contentClassName="p-0">
        {!data.recent_jobs.length ? (
          <EmptyState icon={Timer} title="No retraining history" description="Jobs appear here after the first retraining request." className="border-0" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Created</TH>
                <TH>Status</TH>
                <TH>Stage</TH>
                <TH>Progress</TH>
                <TH>Attempts</TH>
                <TH>Result</TH>
                <TH>Finished</TH>
              </TR>
            </THead>
            <TBody>
              {data.recent_jobs.map((job) => (
                <TR key={job.id}>
                  <TD className="text-[11px] text-muted-foreground">{fmtDate(job.created_at)}</TD>
                  <TD><StatusBadge status={job.status} /></TD>
                  <TD className="text-[11px]">{job.stage}</TD>
                  <TD className="w-28">
                    <Progress value={job.progress} tone={job.status === "failed" ? "danger" : job.status === "succeeded" ? "success" : "primary"} />
                  </TD>
                  <TD className="text-xs tabular-nums">{job.attempts}/{job.max_attempts}</TD>
                  <TD className="max-w-64 text-[11px] text-muted-foreground">
                    {job.error ? (
                      <span className="text-destructive">{job.error}</span>
                    ) : typeof job.result?.comparison === "object" && job.result?.comparison ? (
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle2 className="size-3.5 text-success" />
                        {titleCase(String((job.result.comparison as Record<string, unknown>).recommendation ?? "compared"))}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD className="text-[11px] text-muted-foreground">{fmtDate(job.finished_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </SectionCard>

      <ScheduleRetrainingDialog
        deployment={deployment}
        open={open}
        onOpenChange={setOpen}
        labelStatus={data.label_status}
        minLabels={data.min_labels_required}
      />
    </div>
  );
}
