"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  FlaskConical,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Timer,
  Workflow,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { ProjectSelect, SearchField, SectionCard, SimulatedBadge, StatusBadge } from "@/components/common";
import { useAuth } from "@/components/providers";
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingBlock,
  PageHeader,
  Pagination,
  Progress,
  Select,
  StatCard,
  Table,
  TableShell,
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
import {
  useDebouncedValue,
  useDemoStatus,
  useJob,
  useJobs,
  useJobSummary,
} from "@/lib/hooks";
import type { PipelineJob } from "@/lib/types";
import { errorMessage, fmtDate, fmtDuration, fmtRelative, safeJson, titleCase } from "@/lib/utils";

const JOB_TYPES = [
  { value: "training", label: "Training", description: "Train and evaluate a candidate model" },
  { value: "retraining", label: "Retraining", description: "Rebuild from labelled production data" },
  { value: "drift_analysis", label: "Drift analysis", description: "Compare reference and current data" },
  { value: "simulation", label: "Traffic simulation", description: "Generate explicitly simulated traffic" },
] as const;

const JOB_TYPE_MAP = Object.fromEntries(JOB_TYPES.map((item) => [item.value, item]));

const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

function jobTypeLabel(type: string): string {
  return JOB_TYPE_MAP[type]?.label ?? titleCase(type);
}

function jobDuration(job: PipelineJob): number | null {
  const start = job.started_at ?? job.created_at;
  if (!start) return null;
  const end = job.finished_at ?? (job.status === "running" ? new Date().toISOString() : null);
  if (!end) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function JobStatusCell({ job }: { job: PipelineJob }) {
  return (
    <div className="min-w-32 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <StatusBadge status={job.status} />
        {job.simulated ? <SimulatedBadge simulated /> : null}
      </div>
      {job.status === "running" || job.status === "queued" ? (
        <>
          <Progress
            value={job.progress}
            tone={job.status === "queued" ? "muted" : "info"}
            className="h-1"
          />
          <div className="text-[10px] text-muted-foreground">{job.progress}%</div>
        </>
      ) : null}
    </div>
  );
}

function JobDetailDialog({
  jobId,
  onClose,
}: {
  jobId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: job, isLoading, isError, error, refetch, isFetching } = useJob(jobId);
  const logsRef = React.useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = React.useState(true);

  React.useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [job?.logs, autoScroll]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };

  const retry = useMutation({
    mutationFn: () => api<PipelineJob>(`/jobs/${jobId}/retry`, { method: "POST" }),
    onSuccess: (payload) => {
      toast.success("Retry queued. Opening the new job.");
      invalidate();
      onClose();
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("aperture:open-job", { detail: payload.id }));
      }, 50);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const cancel = useMutation({
    mutationFn: () => api<PipelineJob>(`/jobs/${jobId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Queued job cancelled.");
      invalidate();
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const canRetry = job?.status === "failed" || job?.status === "cancelled";
  const canCancel = job?.status === "queued";

  return (
    <Dialog open={Boolean(jobId)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {job ? jobTypeLabel(job.job_type) : "Pipeline job"}
            {job ? <StatusBadge status={job.status} /> : null}
            {job?.simulated ? <SimulatedBadge simulated /> : null}
          </DialogTitle>
          <DialogDescription>
            {job
              ? `${job.project_name ?? "Workspace"}${job.deployment_name ? ` · ${job.deployment_name}` : ""} · ${job.id}`
              : "Loading execution state and logs…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isLoading ? <LoadingBlock label="Loading job…" /> : null}
          {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
          {job ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Stage</div>
                  <div className="mt-0.5 text-xs font-medium">{titleCase(job.stage)}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Attempts</div>
                  <div className="mt-0.5 text-xs font-medium tabular-nums">
                    {job.attempts} / {job.max_attempts}
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Duration</div>
                  <div className="mt-0.5 text-xs font-medium tabular-nums">{fmtDuration(jobDuration(job))}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Triggered by</div>
                  <div className="mt-0.5 truncate text-xs font-medium">{job.triggered_by_name ?? "System"}</div>
                </div>
              </div>

              <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <span className="text-muted-foreground">Created: </span>
                  {fmtDate(job.created_at)}
                </div>
                <div>
                  <span className="text-muted-foreground">Started: </span>
                  {job.started_at ? fmtDate(job.started_at) : "Not started"}
                </div>
                <div>
                  <span className="text-muted-foreground">Finished: </span>
                  {job.finished_at ? fmtDate(job.finished_at) : "Not finished"}
                </div>
                <div>
                  <span className="text-muted-foreground">Dedupe key: </span>
                  <span className="font-mono text-[11px]">{job.dedupe_key ?? "—"}</span>
                </div>
              </div>

              {job.status === "running" || job.status === "queued" ? (
                <div className="space-y-1">
                  <Progress value={job.progress} tone={job.status === "running" ? "info" : "muted"} />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{job.progress}% · {titleCase(job.stage)}</span>
                    <span className="flex items-center gap-1">
                      {isFetching ? <RefreshCw className="size-3 animate-spin" /> : null} Polling every 1.5s
                    </span>
                  </div>
                </div>
              ) : null}

              {job.error ? (
                <InlineNote tone="danger">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{job.error}</span>
                  </div>
                </InlineNote>
              ) : null}

              <details className="rounded-lg border p-3 text-xs" open>
                <summary className="cursor-pointer font-medium">Execution logs</summary>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Checkbox checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
                    Follow output
                  </label>
                  <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching}>
                    <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
                  </Button>
                </div>
                <pre
                  ref={logsRef}
                  className="mt-2 max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed"
                >
                  {job.logs?.trim() ? job.logs : "No logs captured yet. Queued jobs write output when execution starts."}
                </pre>
              </details>

              <details className="rounded-lg border p-3 text-xs">
                <summary className="cursor-pointer font-medium">Parameters</summary>
                <CodeBlock className="mt-2">{safeJson(job.params)}</CodeBlock>
              </details>

              <details className="rounded-lg border p-3 text-xs">
                <summary className="cursor-pointer font-medium">Result payload</summary>
                <CodeBlock className="mt-2">{safeJson(job.result)}</CodeBlock>
              </details>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="justify-between">
          <div className="text-[11px] text-muted-foreground">
            {job?.status === "running" ? "Running jobs cannot be interrupted reliably by this runner." : null}
            {job?.status === "queued" ? "Cancellation is safe before execution begins." : null}
          </div>
          <div className="flex gap-2">
            {canCancel ? (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Square /> {cancel.isPending ? "Cancelling…" : "Cancel job"}
              </Button>
            ) : null}
            {canRetry ? (
              <Button variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RotateCcw /> {retry.isPending ? "Retrying…" : "Retry job"}
              </Button>
            ) : null}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DemoSeedCard() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: demo, isLoading } = useDemoStatus();
  const [taskTypes, setTaskTypes] = React.useState<string[]>(["classification"]);
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);

  const seed = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>("/demo/seed", {
        method: "POST",
        body: { task_types: taskTypes },
      }),
    onSuccess: (payload) => {
      setResult(payload);
      toast.success("Demo projects seeded. Training jobs were queued through the real pipeline.");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs", "summary"] });
      void queryClient.invalidateQueries({ queryKey: ["demo-status"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (isLoading) return <LoadingBlock label="Checking demo configuration…" />;

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <FlaskConical className="size-4" /> Demo workspace
        </span>
      }
      description="Seed synthetic classification and/or regression projects. Datasets are synthetic, but training runs, models, and predictions are real executions. Simulated traffic is never started automatically."
      actions={
        demo?.demo_mode ? (
          <Badge tone="success">Demo mode enabled</Badge>
        ) : (
          <Badge tone="muted">Demo mode disabled</Badge>
        )
      }
    >
      {!demo?.demo_mode ? (
        <InlineNote tone="info">
          Set <span className="font-mono">DEMO_MODE=true</span> on the API to enable sample projects and traffic
          simulation. Existing projects are unaffected.
        </InlineNote>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {(demo.sample_datasets ?? []).map((dataset) => (
              <div key={dataset.key} className="rounded-lg border bg-muted/20 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Database className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{dataset.name}</span>
                  <Badge tone={dataset.task_type === "regression" ? "info" : "primary"}>
                    {titleCase(dataset.task_type)}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{dataset.description}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-4 rounded-lg border p-3">
            <span className="text-xs font-medium">Seed task types</span>
            {(["classification", "regression"] as const).map((taskType) => (
              <Checkbox
                key={taskType}
                label={titleCase(taskType)}
                checked={taskTypes.includes(taskType)}
                onChange={(event) =>
                  setTaskTypes((current) =>
                    event.target.checked ? [...current, taskType] : current.filter((item) => item !== taskType),
                  )
                }
              />
            ))}
            <Button
              size="sm"
              className="ml-auto"
              disabled={!isAdmin || !taskTypes.length || seed.isPending}
              onClick={() => seed.mutate()}
              title={!isAdmin ? "Workspace administrator required" : undefined}
            >
              <Sparkles /> {seed.isPending ? "Seeding…" : "Seed demo projects"}
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {demo.seeded_project_count} demo project{demo.seeded_project_count === 1 ? "" : "s"} already exist. Seeding
            creates new projects and queues real training jobs; you must approve a model version before deploying it.
            {!isAdmin ? " Workspace administrator privileges are required to seed." : ""}
          </p>

          {result ? (
            <details className="rounded-lg border p-3 text-xs" open>
              <summary className="cursor-pointer font-medium">Seed result</summary>
              <CodeBlock className="mt-2">{safeJson(result)}</CodeBlock>
            </details>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

export default function PipelinesPage() {
  const [jobType, setJobType] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [projectId, setProjectId] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const limit = 25;
  const queryClient = useQueryClient();

  const summary = useJobSummary();
  const jobs = useJobs({
    job_type: jobType || undefined,
    status,
    project_id: projectId || undefined,
    q: debouncedSearch || undefined,
    limit,
    offset,
  });

  React.useEffect(() => {
    setOffset(0);
  }, [jobType, status, projectId, debouncedSearch]);

  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setSelectedJobId(detail);
    };
    window.addEventListener("aperture:open-job", handler);
    return () => window.removeEventListener("aperture:open-job", handler);
  }, []);

  const stats = summary.data;
  const byStatus = stats?.by_status ?? {};
  const recentFailed = (stats?.recent ?? []).filter((job) => job.status === "failed").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operate"
        title="Pipelines"
        description="Background execution for training, retraining, drift analysis, and explicit demo traffic. Jobs are retried deliberately and running work is never silently interrupted."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["jobs"] });
              void queryClient.invalidateQueries({ queryKey: ["jobs", "summary"] });
            }}
            disabled={jobs.isFetching}
          >
            <RefreshCw className={jobs.isFetching ? "animate-spin" : undefined} /> Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Active jobs"
          value={stats?.active ?? 0}
          hint="Queued or running"
          icon={Play}
          tone={stats?.active ? "info" : "success"}
          loading={summary.isLoading}
        />
        <StatCard
          title="Queued"
          value={byStatus.queued ?? 0}
          hint="Can still be cancelled safely"
          icon={ListChecks}
          tone="warning"
          loading={summary.isLoading}
        />
        <StatCard
          title="Failed"
          value={byStatus.failed ?? 0}
          hint={recentFailed ? `${recentFailed} in the five most recent jobs` : "No recent failures"}
          icon={XCircle}
          tone={byStatus.failed ? "danger" : "success"}
          loading={summary.isLoading}
        />
        <StatCard
          title="Succeeded"
          value={byStatus.succeeded ?? 0}
          hint="Completed executions"
          icon={CheckCircle2}
          tone="success"
          loading={summary.isLoading}
        />
      </div>

      {stats?.by_type?.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">By type</span>
          {stats.by_type.map((item) => (
            <Badge key={item.job_type} tone="muted">
              {jobTypeLabel(item.job_type)} · {item.count}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={jobType} onChange={(event) => setJobType(event.target.value)} className="h-8 w-44 text-xs" aria-label="Job type filter">
          <option value="">All job types</option>
          {JOB_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-36 text-xs" aria-label="Job status filter">
          <option value="all">All statuses</option>
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {titleCase(item)}
            </option>
          ))}
        </Select>
        <ProjectSelect value={projectId} onChange={setProjectId} allowAll />
        <SearchField value={search} onChange={setSearch} placeholder="Search stage or error…" />
        <span className="ml-auto text-[11px] text-muted-foreground">
          {jobs.data ? `${jobs.data.total} job${jobs.data.total === 1 ? "" : "s"}` : "—"}
        </span>
      </div>

      {jobs.isLoading ? <LoadingBlock label="Loading pipeline jobs…" /> : null}
      {jobs.isError ? <ErrorState message={errorMessage(jobs.error)} onRetry={() => void jobs.refetch()} /> : null}
      {!jobs.isLoading && !jobs.isError && !jobs.data?.items.length ? (
        <EmptyState
          icon={Workflow}
          title="No pipeline jobs in this view"
          description="Training, retraining, drift analysis, and demo simulation all create jobs. Start training from a project, run drift analysis from a deployment, or seed demo projects below."
          action={
            <Button variant="outline" size="sm" onClick={() => setStatus("all")}>
              Clear status filter
            </Button>
          }
        />
      ) : null}

      {jobs.data?.items.length ? (
        <>
          <TableShell>
            <Table>
              <THead>
                <TR>
                  <TH>Status</TH>
                  <TH>Job</TH>
                  <TH>Target</TH>
                  <TH>Stage</TH>
                  <TH>Attempts</TH>
                  <TH>Triggered by</TH>
                  <TH>Duration</TH>
                  <TH>Created</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {jobs.data.items.map((job) => (
                  <TR
                    key={job.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelectedJobId(job.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelectedJobId(job.id);
                    }}
                  >
                    <TD>
                      <JobStatusCell job={job} />
                    </TD>
                    <TD>
                      <div className="text-xs font-medium">{jobTypeLabel(job.job_type)}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{job.id.slice(0, 12)}…</div>
                    </TD>
                    <TD className="text-xs">
                      <div>{job.project_name ?? "Workspace"}</div>
                      <div className="text-[11px] text-muted-foreground">{job.deployment_name ?? "No deployment"}</div>
                    </TD>
                    <TD className="text-xs">
                      <div>{titleCase(job.stage)}</div>
                      {job.error ? (
                        <div className="max-w-48 truncate text-[11px] text-destructive" title={job.error}>
                          {job.error}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="text-xs tabular-nums">
                      {job.attempts}/{job.max_attempts}
                    </TD>
                    <TD className="text-xs">{job.triggered_by_name ?? "System"}</TD>
                    <TD className="whitespace-nowrap text-xs tabular-nums">
                      <span className="flex items-center gap-1">
                        <Timer className="size-3 text-muted-foreground" /> {fmtDuration(jobDuration(job))}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="size-3" /> {fmtRelative(job.created_at)}
                      </div>
                      <div className="text-[11px]">{fmtDate(job.created_at)}</div>
                    </TD>
                    <TD>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
          <Pagination total={jobs.data.total} limit={limit} offset={offset} onChange={setOffset} />
        </>
      ) : null}

      <DemoSeedCard />

      <JobDetailDialog jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
    </div>
  );
}
