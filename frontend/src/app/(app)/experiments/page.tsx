"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  BrainCircuit,
  FlaskConical,
  GitCommitHorizontal,
  RefreshCw,
  Scale,
  Timer,
  Trophy,
} from "lucide-react";

import { CompareRunsDialog } from "@/components/compare-runs";
import { RunDetailDialog } from "@/components/run-detail";
import { EmptyHint, SearchField, SectionCard, StatusBadge } from "@/components/common";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Pagination,
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
import { useAlgorithms, useDebouncedValue, useProjectOptions, useRuns } from "@/lib/hooks";
import type { TrainingRun } from "@/lib/types";
import {
  errorMessage,
  fmtDuration,
  fmtMetric,
  fmtRelative,
  metricLabel,
  primaryMetricName,
  titleCase,
} from "@/lib/utils";

const LIMIT = 20;

function runTaskType(run: TrainingRun): string {
  if (typeof run.params?.task_type === "string") return run.params.task_type;
  return run.metrics?.roc_auc !== undefined || run.metrics?.accuracy !== undefined ? "classification" : "regression";
}

function ExperimentsContent() {
  const searchParams = useSearchParams();
  const [projectId, setProjectId] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [algorithm, setAlgorithm] = React.useState("");
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [sort, setSort] = React.useState("created_at");
  const [order, setOrder] = React.useState("desc");
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [detailRun, setDetailRun] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [compareOpen, setCompareOpen] = React.useState(false);

  const { data: projects } = useProjectOptions();
  const { data: algorithms } = useAlgorithms(projectId || undefined);
  const { data, isLoading, error, refetch, isFetching } = useRuns({
    project_id: projectId || undefined,
    status: status || undefined,
    algorithm: algorithm || undefined,
    q: debouncedSearch || undefined,
    sort,
    order,
    limit: LIMIT,
    offset,
  });

  React.useEffect(() => {
    const project = searchParams.get("project");
    if (project) setProjectId(project);
    const run = searchParams.get("run");
    if (run) {
      setDetailRun(run);
      setDetailOpen(true);
    }
  }, [searchParams]);

  React.useEffect(() => {
    setOffset(0);
    setSelected([]);
    setAlgorithm("");
  }, [projectId, status, debouncedSearch, sort, order]);

  const toggle = (runId: string) => {
    setSelected((current) => {
      if (current.includes(runId)) return current.filter((item) => item !== runId);
      if (current.length >= 5) return current;
      return [...current, runId];
    });
  };

  const runs = data?.items ?? [];
  const total = data?.total ?? 0;
  const succeeded = runs.filter((run) => run.status === "succeeded").length;
  const running = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const failed = runs.filter((run) => run.status === "failed").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Experiments"
        title="Training experiments"
        description="Every run below is a real training execution tracked in MLflow. Compare held-out metrics, inspect artifacts, review the git commit and open the registered model lineage."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/projects">
                <FlaskConical /> New experiment
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Runs matching filters" value={total} hint="Workspace-wide run history" icon={FlaskConical} tone="primary" loading={isLoading} />
        <StatCard title="Succeeded on page" value={succeeded} hint={`${runs.length} runs shown`} icon={Trophy} tone="success" loading={isLoading} />
        <StatCard title="Queued or running" value={running} hint="Live pipeline activity" icon={Timer} tone={running ? "warning" : "muted"} loading={isLoading} />
        <StatCard title="Failed on page" value={failed} hint="Open a run for the failure message" icon={BrainCircuit} tone={failed ? "danger" : "success"} loading={isLoading} />
      </div>

      <SectionCard
        title="Run explorer"
        description="Select two to five runs to compare held-out metrics. The best run is advisory only and is never promoted automatically."
        actions={
          <Button size="sm" variant="outline" disabled={selected.length < 2} onClick={() => setCompareOpen(true)}>
            <Scale /> Compare {selected.length ? `(${selected.length})` : ""}
          </Button>
        }
        contentClassName="space-y-3 pt-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={search} onChange={setSearch} placeholder="Search runs…" />
          <Select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-8 w-auto max-w-56 text-xs"
            aria-label="Project filter"
          >
            <option value="">All projects</option>
            {(projects?.items ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-auto text-xs" aria-label="Run status">
            <option value="">All statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          {projectId ? (
            <Select value={algorithm} onChange={(event) => setAlgorithm(event.target.value)} className="h-8 w-auto text-xs" aria-label="Algorithm">
              <option value="">All algorithms</option>
              {(algorithms?.algorithms ?? []).map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </Select>
          ) : null}
          <Select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 w-auto text-xs" aria-label="Sort runs">
            <option value="created_at">Newest first</option>
            <option value="duration_seconds">Duration</option>
            <option value="name">Name</option>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setOrder((value) => (value === "desc" ? "asc" : "desc"))}>
            {order === "desc" ? "Descending" : "Ascending"}
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">{total} runs</span>
        </div>

        {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
        {isLoading ? <LoadingBlock label="Loading experiment runs…" /> : null}

        {!isLoading && !error && runs.length === 0 ? (
          <EmptyState
            title={debouncedSearch || status || projectId ? "No runs match these filters" : "No experiments yet"}
            description={
              debouncedSearch || status || projectId
                ? "Clear one or more filters to widen the result set."
                : "Start a training job from any project. Real metrics, artifacts and lineage will appear here."
            }
            icon={FlaskConical}
            action={
              <Button asChild>
                <Link href="/projects">Open projects</Link>
              </Button>
            }
          />
        ) : null}

        {runs.length ? (
          <div className="overflow-hidden rounded-lg border">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH className="w-8" />
                    <TH>Run</TH>
                    <TH>Project</TH>
                    <TH>Status</TH>
                    <TH>Primary metric</TH>
                    <TH>Duration</TH>
                    <TH>Commit</TH>
                    <TH>Created</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {runs.map((run) => {
                    const taskType = runTaskType(run);
                    const primary = primaryMetricName(taskType);
                    const value = typeof run.metrics?.[primary] === "number" ? Number(run.metrics[primary]) : null;
                    return (
                      <TR key={run.id}>
                        <TD>
                          <Checkbox
                            checked={selected.includes(run.id)}
                            onChange={() => toggle(run.id)}
                            aria-label={`Select ${run.name}`}
                          />
                        </TD>
                        <TD className="min-w-56">
                          <button
                            type="button"
                            className="block max-w-72 truncate text-left text-xs font-medium hover:text-primary hover:underline"
                            onClick={() => {
                              setDetailRun(run.id);
                              setDetailOpen(true);
                            }}
                          >
                            {run.name}
                          </button>
                          <span className="text-[10px] text-muted-foreground">
                            {titleCase(run.algorithm)} · {run.dataset_name ? `${run.dataset_name} v${run.dataset_version}` : "dataset unknown"}
                          </span>
                        </TD>
                        <TD className="text-xs">
                          <Link href={`/projects/${run.project_id}`} className="hover:text-primary hover:underline">
                            {run.project_name}
                          </Link>
                          <span className="block text-[10px] text-muted-foreground">{run.experiment_name || "Default experiment"}</span>
                        </TD>
                        <TD>
                          <StatusBadge status={run.status} />
                        </TD>
                        <TD className="whitespace-nowrap text-xs tabular-nums">
                          <span className="text-muted-foreground">{metricLabel(primary)} </span>
                          <span className="font-medium">{fmtMetric(value, 4)}</span>
                        </TD>
                        <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtDuration(run.duration_seconds)}</TD>
                        <TD className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                            <GitCommitHorizontal className="size-3" />
                            {run.git_commit ? run.git_commit.slice(0, 8) : "unversioned"}
                          </span>
                        </TD>
                        <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtRelative(run.created_at)}</TD>
                        <TD>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setDetailRun(run.id);
                              setDetailOpen(true);
                            }}
                          >
                            Details <ArrowUpRight />
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <Pagination total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="How comparisons work" description="Guardrails applied by the comparison and registry services.">
        <div className="grid gap-3 text-[11px] leading-relaxed text-muted-foreground md:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-1 font-medium text-foreground">Held-out metrics only</p>
            <p>
              Reported metrics come from the untouched test split. Cross-run comparisons are only meaningful when the
              dataset version and evaluation protocol match.
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-1 font-medium text-foreground">Best run is advisory</p>
            <p>
              The comparison dialog highlights the best primary metric. It does not approve, promote or deploy a model
              version.
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-1 font-medium text-foreground">Full lineage</p>
            <p>
              Each run carries its dataset version, algorithm, hyperparameters, duration, git commit and MLflow
              artifacts. Missing MLflow data is shown as a warning, never fabricated.
            </p>
          </div>
        </div>
        {!runs.length && !isLoading ? <EmptyHint>Run details include confusion matrices, per-class metrics, candidate comparisons and artifacts.</EmptyHint> : null}
      </SectionCard>

      <RunDetailDialog runId={detailRun} open={detailOpen} onOpenChange={setDetailOpen} />
      <CompareRunsDialog runIds={selected} open={compareOpen} onOpenChange={setCompareOpen} />
    </div>
  );
}

export default function ExperimentsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <LoadingBlock label="Loading experiments…" />
        </div>
      }
    >
      <ExperimentsContent />
    </React.Suspense>
  );
}
