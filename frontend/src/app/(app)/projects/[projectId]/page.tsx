"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Database,
  FolderKanban,
  Gauge,
  PackageCheck,
  Pencil,
  Rocket,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { CompareRunsDialog } from "@/components/compare-runs";
import {
  EmptyHint,
  SectionCard,
  SeverityBadge,
  StatusBadge,
  TaskBadge,
} from "@/components/common";
import { DatasetsPanel } from "@/components/datasets-panel";
import { RunDetailDialog } from "@/components/run-detail";
import { TrainingPanel } from "@/components/training-panel";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  LoadingCards,
  PageHeader,
  Skeleton,
  StatCard,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from "@/components/ui";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api";
import {
  useDeployments,
  useModels,
  useProject,
  useProjectMonitoring,
  useRuns,
} from "@/lib/hooks";
import type { Project, TrainingRun } from "@/lib/types";
import {
  errorMessage,
  fmtMetric,
  fmtNumber,
  fmtPercent,
  fmtRelative,
  metricLabel,
  primaryMetricName,
  titleCase,
} from "@/lib/utils";

type TabKey = "overview" | "datasets" | "training" | "runs" | "models" | "monitoring";

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "overview", label: "Overview", icon: FolderKanban },
  { key: "datasets", label: "Datasets", icon: Database },
  { key: "training", label: "Training", icon: BrainCircuit },
  { key: "runs", label: "Runs", icon: ScrollText },
  { key: "models", label: "Models", icon: PackageCheck },
  { key: "monitoring", label: "Monitoring", icon: Activity },
];

function EditProjectDialog({
  project,
  open,
  onOpenChange,
  isAdmin,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description ?? "");
  const [targetColumn, setTargetColumn] = React.useState(project.target_column ?? "");
  const [positiveLabel, setPositiveLabel] = React.useState(project.positive_label ?? "");
  const [status, setStatus] = React.useState(project.status);

  React.useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? "");
      setTargetColumn(project.target_column ?? "");
      setPositiveLabel(project.positive_label ?? "");
      setStatus(project.status);
    }
  }, [open, project]);

  const mutation = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, {
        method: "PATCH",
        body: {
          ...(isAdmin && name.trim() !== project.name ? { name: name.trim() } : {}),
          description: description.trim(),
          target_column: targetColumn.trim(),
          positive_label: positiveLabel.trim() || null,
          ...(isAdmin ? { status } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Project updated.");
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Task type cannot change after datasets exist. Renaming and archiving require workspace administrator access.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogBody className="space-y-3">
            <Field label="Name" required htmlFor="edit-project-name" hint={isAdmin ? undefined : "Admin only"}>
              <Input
                id="edit-project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!isAdmin}
                minLength={2}
                maxLength={160}
              />
            </Field>
            <Field label="Description" htmlFor="edit-project-description">
              <Textarea
                id="edit-project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={4000}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Target column" htmlFor="edit-project-target">
                <Input
                  id="edit-project-target"
                  value={targetColumn}
                  onChange={(event) => setTargetColumn(event.target.value)}
                  maxLength={160}
                />
              </Field>
              <Field label="Positive label" htmlFor="edit-project-positive">
                <Input
                  id="edit-project-positive"
                  value={positiveLabel}
                  onChange={(event) => setPositiveLabel(event.target.value)}
                  maxLength={120}
                />
              </Field>
            </div>
            {isAdmin ? (
              <Field label="Status" htmlFor="edit-project-status">
                <select
                  id="edit-project-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm"
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </Field>
            ) : null}
            <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Task type: <strong>{titleCase(project.task_type)}</strong>. Datasets, runs and model lineage remain intact when
              archiving a project.
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunsPanel({ projectId, taskType }: { projectId: string; taskType: string }) {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [detailRun, setDetailRun] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const { data, isLoading, error, refetch } = useRuns({
    project_id: projectId,
    q: search || undefined,
    status: status || undefined,
    limit: 15,
    offset,
  });
  const primary = primaryMetricName(taskType);

  const toggle = (runId: string) => {
    setSelected((current) => {
      if (current.includes(runId)) return current.filter((item) => item !== runId);
      if (current.length >= 5) {
        toast.info("Compare at most 5 runs at a time.");
        return current;
      }
      return [...current, runId];
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          placeholder="Search runs…"
          className="h-8 max-w-xs text-xs"
        />
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setOffset(0);
          }}
          className="h-8 rounded-lg border border-input bg-card px-2 text-xs"
          aria-label="Run status"
        >
          <option value="">All statuses</option>
          <option value="succeeded">Succeeded</option>
          <option value="running">Running</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <Button variant="outline" size="sm" disabled={selected.length < 2} onClick={() => setCompareOpen(true)}>
          Compare {selected.length ? `(${selected.length})` : ""}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">{data?.total ?? 0} runs</span>
      </div>
      {isLoading ? <LoadingBlock label="Loading runs…" /> : null}
      {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {data?.items.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH className="w-8" />
                  <TH>Run</TH>
                  <TH>Status</TH>
                  <TH>{metricLabel(primary)}</TH>
                  <TH>Dataset</TH>
                  <TH>Duration</TH>
                  <TH>Created</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {data.items.map((run: TrainingRun) => {
                  const value = typeof run.metrics?.[primary] === "number" ? Number(run.metrics[primary]) : null;
                  return (
                    <TR key={run.id}>
                      <TD>
                        <Checkbox checked={selected.includes(run.id)} onChange={() => toggle(run.id)} aria-label={`Select ${run.name}`} />
                      </TD>
                      <TD className="min-w-52">
                        <button
                          type="button"
                          className="block max-w-64 truncate text-left text-xs font-medium hover:text-primary hover:underline"
                          onClick={() => {
                            setDetailRun(run.id);
                            setDetailOpen(true);
                          }}
                        >
                          {run.name}
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {titleCase(run.algorithm)} · {run.git_commit || "unversioned"}
                        </span>
                      </TD>
                      <TD>
                        <StatusBadge status={run.status} />
                      </TD>
                      <TD className="text-xs font-medium tabular-nums">{fmtMetric(value, 4)}</TD>
                      <TD className="max-w-44 truncate text-[11px] text-muted-foreground">
                        {run.dataset_name ? `${run.dataset_name} v${run.dataset_version}` : "—"}
                      </TD>
                      <TD className="text-xs text-muted-foreground">{run.duration_seconds ? `${run.duration_seconds.toFixed(1)}s` : "—"}</TD>
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
                          Details
                        </Button>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + 15, data.total)} of {data.total}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 15))}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={offset + 15 >= data.total} onClick={() => setOffset(offset + 15)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      ) : !isLoading ? (
        <EmptyState
          title="No runs match"
          description="Train a model or clear the filters to see all runs."
          icon={BrainCircuit}
        />
      ) : null}
      <RunDetailDialog runId={detailRun} open={detailOpen} onOpenChange={setDetailOpen} />
      <CompareRunsDialog runIds={selected} open={compareOpen} onOpenChange={setCompareOpen} />
    </div>
  );
}

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { isAdmin } = useAuth();
  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const { data: models } = useModels(projectId);
  const { data: deployments } = useDeployments({ project_id: projectId, limit: 100 });
  const { data: runs } = useRuns({ project_id: projectId, limit: 6 });
  const { data: monitoring, isLoading: monitoringLoading } = useProjectMonitoring(projectId, 7);
  const [tab, setTab] = React.useState<TabKey>("overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const [runDetail, setRunDetail] = React.useState<string | null>(null);
  const [runDetailOpen, setRunDetailOpen] = React.useState(false);

  React.useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const runId = query.get("run");
    if (runId) {
      setRunDetail(runId);
      setRunDetailOpen(true);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <LoadingCards count={4} />
      </div>
    );
  }

  if (error || !project) {
    return <ErrorState message={error ? errorMessage(error) : "Project not found"} onRetry={() => void refetch()} />;
  }

  const pendingApprovals = (models ?? []).reduce((sum, model) => sum + model.pending_approvals, 0);
  const activeDeployments = (deployments?.items ?? []).filter((deployment) => deployment.status === "active").length;
  const latestRun = project.latest_run;
  const policy = (project.config?.promotion_policy ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link href="/projects" className="hover:underline">
              Projects
            </Link>
            <span>/</span>
            <span>{project.slug}</span>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.name}
            <TaskBadge taskType={project.task_type} />
            <StatusBadge status={project.status} />
          </span>
        }
        description={project.description || "No description provided."}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil /> Settings
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTab("training")}>
              <BrainCircuit /> Train
            </Button>
            <Button size="sm" onClick={() => setTab("datasets")}>
              <Database /> Datasets
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge tone="muted">Target: {project.target_column || "unset"}</Badge>
        {project.positive_label ? <Badge tone="muted">Positive: {project.positive_label}</Badge> : null}
        <Badge tone="muted">{project.dataset_count} datasets</Badge>
        <Badge tone="muted">{project.model_count} models</Badge>
        <Badge tone="muted">{project.deployment_count} deployments</Badge>
        <span className="ml-auto">Updated {fmtRelative(project.updated_at)}</span>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <div className="overflow-x-auto">
          <TabsList>
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.key} value={item.key}>
                  <Icon className="size-3.5" /> {item.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Datasets" value={project.dataset_count} hint="Versioned, content-hashed" icon={Database} tone="primary" />
            <StatCard title="Registered models" value={project.model_count} hint={`${pendingApprovals} pending approval`} icon={PackageCheck} tone={pendingApprovals ? "warning" : "success"} />
            <StatCard title="Active deployments" value={activeDeployments} hint={`${project.deployment_count} total`} icon={Rocket} tone={activeDeployments ? "success" : "muted"} />
            <StatCard
              title="Open alerts"
              value={monitoring?.open_alerts ?? 0}
              hint="Project-scoped alerts"
              icon={Activity}
              tone={(monitoring?.open_alerts ?? 0) > 0 ? "danger" : "success"}
              loading={monitoringLoading}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <SectionCard
              title="Latest training run"
              description="Metrics are from the untouched held-out test set."
              className="lg:col-span-2"
              actions={
                <Button variant="ghost" size="sm" onClick={() => setTab("runs")}>
                  All runs <ArrowRight />
                </Button>
              }
            >
              {latestRun ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="text-sm font-medium hover:text-primary hover:underline"
                      onClick={() => {
                        setRunDetail(latestRun.id);
                        setRunDetailOpen(true);
                      }}
                    >
                      {latestRun.name}
                    </button>
                    <StatusBadge status={latestRun.status} />
                    <Badge tone="muted">{titleCase(latestRun.algorithm)}</Badge>
                    <span className="ml-auto text-[11px] text-muted-foreground">{fmtRelative(latestRun.created_at)}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {Object.entries(latestRun.metrics)
                      .filter(([, value]) => typeof value === "number")
                      .slice(0, 5)
                      .map(([metric, value]) => (
                        <div key={metric} className="rounded-lg border bg-muted/20 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{metricLabel(metric)}</div>
                          <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtMetric(Number(value), 4)}</div>
                        </div>
                      ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setTab("runs")}>
                      Compare runs
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setTab("models")}>
                      Review model versions
                    </Button>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title="No training runs yet"
                  description="Upload a dataset, then start a real training job."
                  icon={BrainCircuit}
                  action={
                    <Button size="sm" onClick={() => setTab("training")}>
                      <BrainCircuit /> Start training
                    </Button>
                  }
                />
              )}
            </SectionCard>

            <SectionCard title="Promotion policy" description="Enforced by the backend for approval and retraining.">
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Require approval</dt>
                  <dd className="font-medium">{policy.require_approval ? "Yes" : "No"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Auto-promote safe candidates</dt>
                  <dd className="font-medium">{policy.allow_auto_promote ? "Enabled" : "Disabled"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Min primary metric</dt>
                  <dd className="font-medium tabular-nums">{policy.min_primary_metric === null || policy.min_primary_metric === undefined ? "Not set" : fmtMetric(Number(policy.min_primary_metric), 3)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Max generalization gap</dt>
                  <dd className="font-medium tabular-nums">{fmtMetric(Number(policy.max_generalization_gap ?? 0), 2)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Min test samples</dt>
                  <dd className="font-medium tabular-nums">{fmtNumber(Number(policy.min_test_samples ?? 0))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Retrain min improvement</dt>
                  <dd className="font-medium tabular-nums">{fmtPercent(Number(policy.retrain_min_improvement ?? 0), 2)}</dd>
                </div>
              </dl>
              <p className="mt-3 flex gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3 shrink-0 text-success" />
                A candidate that fails validation cannot be approved or deployed, regardless of its score.
              </p>
            </SectionCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title="Deployments"
              description="Models currently serving or paused for this project."
              actions={
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/deployments?project=${projectId}`}>
                    Manage <ArrowRight />
                  </Link>
                </Button>
              }
            >
              {deployments?.items.length ? (
                <div className="space-y-2">
                  {deployments.items.slice(0, 5).map((deployment) => (
                    <Link
                      key={deployment.id}
                      href={`/deployments/${deployment.id}`}
                      className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/30"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{deployment.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {deployment.model_name} v{deployment.model_version} · {fmtNumber(deployment.prediction_count)} requests
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <StatusBadge status={deployment.status} />
                        {deployment.latest_drift_severity ? <SeverityBadge severity={deployment.latest_drift_severity} /> : null}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState title="No deployments" description="Approve a model version and create a deployment from the Deployments page." icon={Rocket} />
              )}
            </SectionCard>

            <SectionCard
              title="Recent experiments"
              description="The last runs for this project."
              actions={
                <Button variant="ghost" size="sm" onClick={() => setTab("runs")}>
                  View runs <ArrowRight />
                </Button>
              }
            >
              {runs?.items.length ? (
                <div className="space-y-1.5">
                  {runs.items.slice(0, 5).map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                      onClick={() => {
                        setRunDetail(run.id);
                        setRunDetailOpen(true);
                      }}
                    >
                      <span className="min-w-0 truncate">{run.name}</span>
                      <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                        <StatusBadge status={run.status} />
                        {fmtRelative(run.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyHint>No experiments yet.</EmptyHint>
              )}
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="datasets">
          <DatasetsPanel projectId={projectId} taskType={project.task_type} isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="training">
          <TrainingPanel projectId={projectId} taskType={project.task_type} />
        </TabsContent>

        <TabsContent value="runs">
          <RunsPanel projectId={projectId} taskType={project.task_type} />
        </TabsContent>

        <TabsContent value="models" className="space-y-4">
          <SectionCard
            title="Registered models"
            description="Versions start as pending and require human approval before deployment."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href={`/registry?project=${projectId}`}>
                  <PackageCheck /> Open registry
                </Link>
              </Button>
            }
          >
            {models?.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {models.map((model) => (
                  <Link
                    key={model.id}
                    href={`/registry?project=${projectId}&model=${model.id}`}
                    className="rounded-xl border p-3 transition-colors hover:border-primary/40 hover:bg-muted/20"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{model.name}</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">{model.description || "No description"}</p>
                      </div>
                      {model.pending_approvals ? <Badge tone="warning">{model.pending_approvals} pending</Badge> : <Badge tone="success">Up to date</Badge>}
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{model.version_count} versions</span>
                      {model.production_version ? (
                        <Badge tone="success">Production v{model.production_version.version}</Badge>
                      ) : (
                        <Badge tone="muted">No production version</Badge>
                      )}
                      <span className="ml-auto">{fmtRelative(model.created_at)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No registered models"
                description="A successful training run registers a model version. It will appear here awaiting approval."
                icon={PackageCheck}
                action={
                  <Button size="sm" onClick={() => setTab("training")}>
                    Train a model
                  </Button>
                }
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="monitoring" className="space-y-4">
          {monitoringLoading ? <LoadingCards count={4} /> : null}
          {monitoring ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard title="Requests (7d)" value={fmtNumber(monitoring.metrics.total_requests)} hint={`${fmtNumber(monitoring.metrics.production_count)} production · ${fmtNumber(monitoring.metrics.simulated_count)} simulated`} icon={Activity} tone="primary" />
                <StatCard title="Error rate" value={fmtPercent(monitoring.metrics.error_rate, 2)} hint={`${fmtNumber(monitoring.metrics.error_count)} errors`} icon={Gauge} tone={monitoring.metrics.error_rate > 0.05 ? "danger" : "success"} />
                <StatCard title="Active deployments" value={monitoring.metrics.active_deployments} hint={`${monitoring.deployments.length} total`} icon={Rocket} tone="success" />
                <StatCard title="Open alerts" value={monitoring.open_alerts} hint="Project-scoped" icon={Activity} tone={monitoring.open_alerts ? "danger" : "success"} />
              </div>
              <SectionCard title="Deployments" description="Open a deployment for traffic, latency, drift, performance and retraining.">
                {monitoring.deployments.length ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <THead>
                        <TR>
                          <TH>Deployment</TH>
                          <TH>Model</TH>
                          <TH>Status</TH>
                          <TH>Requests</TH>
                          <TH>Error rate</TH>
                          <TH>Drift</TH>
                          <TH />
                        </TR>
                      </THead>
                      <TBody>
                        {monitoring.deployments.map((deployment) => (
                          <TR key={deployment.id}>
                            <TD className="font-medium">{deployment.name}</TD>
                            <TD className="text-xs">{deployment.model_name} v{deployment.model_version}</TD>
                            <TD><StatusBadge status={deployment.status} /></TD>
                            <TD className="tabular-nums">{fmtNumber(deployment.prediction_count)}</TD>
                            <TD className="tabular-nums">{deployment.error_rate === null ? "—" : fmtPercent(deployment.error_rate, 2)}</TD>
                            <TD>{deployment.latest_drift_severity ? <SeverityBadge severity={deployment.latest_drift_severity} /> : <Badge tone="muted">No report</Badge>}</TD>
                            <TD className="text-right">
                              <Button variant="ghost" size="sm" asChild>
                                <Link href={`/monitoring?deployment=${deployment.id}`}>
                                  Monitor <ArrowRight />
                                </Link>
                              </Button>
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                ) : (
                  <EmptyState title="No deployments" description="Monitoring starts after a model is deployed." icon={Rocket} />
                )}
              </SectionCard>
              <SectionCard title="Recent runs" description="Training activity in this project.">
                {monitoring.recent_runs.length ? (
                  <div className="space-y-1.5">
                    {monitoring.recent_runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs hover:bg-muted/30"
                        onClick={() => {
                          setRunDetail(run.id);
                          setRunDetailOpen(true);
                        }}
                      >
                        <span className="truncate">{run.name}</span>
                        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                          <StatusBadge status={run.status} /> {fmtRelative(run.created_at)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyHint>No recent runs.</EmptyHint>
                )}
              </SectionCard>
            </>
          ) : null}
        </TabsContent>
      </Tabs>

      <EditProjectDialog project={project} open={editOpen} onOpenChange={setEditOpen} isAdmin={isAdmin} />
      <RunDetailDialog runId={runDetail} open={runDetailOpen} onOpenChange={setRunDetailOpen} />
    </div>
  );
}
