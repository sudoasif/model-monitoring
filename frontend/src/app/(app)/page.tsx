"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BellRing,
  CheckCircle2,
  Cpu,
  Database,
  FolderKanban,
  Gauge,
  PackageCheck,
  RefreshCw,
  Rocket,
  Timer,
  TrendingUp,
} from "lucide-react";

import {
  MetricInline,
  SectionCard,
  SeverityBadge,
  SimulatedBadge,
  StatusBadge,
  TaskBadge,
} from "@/components/common";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingCards,
  PageHeader,
  Progress,
  StatCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { useAlertSummary, useDemoStatus, useOverview } from "@/lib/hooks";
import {
  errorMessage,
  fmtCompact,
  fmtMetric,
  fmtPercent,
  fmtRelative,
  metricLabel,
  primaryMetricName,
  primaryMetricLabel,
  titleCase,
} from "@/lib/utils";

export default function OverviewPage() {
  const [days, setDays] = React.useState(7);
  const { data, isLoading, error, refetch, isFetching } = useOverview(days);
  const { data: alertSummary } = useAlertSummary(30);
  const { data: demo } = useDemoStatus();

  const counts = data?.counts;
  const traffic = data?.traffic;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Workspace"
        title={data?.workspace.name ? `Good to see you, ${data.workspace.name}` : "Overview"}
        description="Live operational state across projects, experiments, deployed models, drift and alerts. Every number is derived from recorded platform events."
        actions={
          <>
            <label htmlFor="overview-window" className="sr-only">
              Time window
            </label>
            <select
              id="overview-window"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="h-9 rounded-lg border border-input bg-card px-3 text-xs"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/projects">
                <FolderKanban /> Projects
              </Link>
            </Button>
          </>
        }
      />

      {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}

      {isLoading ? <LoadingCards count={4} /> : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title="Requests in window"
              value={fmtCompact(traffic?.requests ?? 0)}
              hint={`${fmtCompact(traffic?.production ?? 0)} production · ${fmtCompact(traffic?.simulated ?? 0)} simulated`}
              icon={Activity}
              tone="primary"
            />
            <StatCard
              title="Active deployments"
              value={fmtCompact(counts?.active_deployments ?? 0)}
              hint={`${counts?.unhealthy_deployments ?? 0} unhealthy · ${counts?.deployments ?? 0} total`}
              icon={Rocket}
              tone={(counts?.unhealthy_deployments ?? 0) > 0 ? "danger" : "success"}
            />
            <StatCard
              title="Open alerts"
              value={fmtCompact(counts?.open_alerts ?? 0)}
              hint={`${counts?.critical_alerts ?? 0} critical · ${alertSummary?.unacknowledged ?? 0} unacknowledged`}
              icon={BellRing}
              tone={(counts?.critical_alerts ?? 0) > 0 ? "danger" : (counts?.open_alerts ?? 0) > 0 ? "warning" : "success"}
            />
            <StatCard
              title="Pending approvals"
              value={fmtCompact(counts?.pending_approvals ?? 0)}
              hint="Human approval is required before deployment"
              icon={PackageCheck}
              tone={(counts?.pending_approvals ?? 0) > 0 ? "warning" : "success"}
            />
          </div>

          {demo?.demo_mode ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-warning/40 bg-warning/5 px-4 py-3 text-xs">
              <SimulatedBadge simulated />
              <span className="font-medium">Demo mode is enabled.</span>
              <span className="text-muted-foreground">
                Sample datasets and simulated traffic are available. Simulation starts only when you explicitly request it.
              </span>
              <Button variant="link" size="sm" className="ml-auto h-auto p-0" asChild>
                <Link href="/settings?tab=system">
                  Seed demo workspace <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : null}

          {counts?.projects === 0 ? (
            <EmptyState
              title="Create your first project"
              description="A project groups datasets, training runs, registered models and deployments. You can start from a sample dataset in seconds."
              icon={FolderKanban}
              action={
                <Button asChild>
                  <Link href="/projects">
                    <FolderKanban /> Create a project
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-3">
              <SectionCard
                title="Traffic health"
                description={`Source: ${traffic?.source ?? "none"} · ${days}-day window`}
                className="xl:col-span-1"
                actions={
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/monitoring">
                      Monitor <ArrowRight />
                    </Link>
                  </Button>
                }
              >
                <div className="grid grid-cols-2 gap-2">
                  <MetricInline label="Error rate" value={(traffic?.error_rate ?? 0) * 100} digits={2} />
                  <MetricInline label="p95 latency" value={traffic?.latency_p95_ms ?? null} digits={1} />
                  <MetricInline label="Errors" value={traffic?.errors ?? 0} digits={0} />
                  <MetricInline label="Requests" value={traffic?.requests ?? 0} digits={0} />
                </div>
                <div className="mt-4 space-y-1.5">
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>Production vs simulated</span>
                    <span>
                      {fmtPercent(
                        traffic?.requests ? (traffic.production ?? 0) / traffic.requests : 0,
                        0,
                      )}{" "}
                      production
                    </span>
                  </div>
                  <Progress
                    value={traffic?.requests ? ((traffic.production ?? 0) / traffic.requests) * 100 : 0}
                    tone="success"
                  />
                  <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
                    Latency is measured at the prediction endpoint. Simulated traffic is labeled and never mixed into
                    production-only filters.
                  </p>
                </div>
              </SectionCard>

              <SectionCard
                title="Recent alerts"
                description="Latest alerts across this workspace."
                className="xl:col-span-1"
                actions={
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/alerts">
                      All alerts <ArrowRight />
                    </Link>
                  </Button>
                }
              >
                {data.recent_alerts.length ? (
                  <ul className="space-y-2">
                    {data.recent_alerts.map((alert) => (
                      <li key={alert.id} className="rounded-lg border p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <Link href={`/alerts?alert=${alert.id}`} className="min-w-0 text-xs font-medium hover:underline">
                            {alert.title}
                          </Link>
                          <SeverityBadge severity={alert.severity} />
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <StatusBadge status={alert.status} />
                          {alert.simulated ? <SimulatedBadge simulated /> : null}
                          <span>{fmtRelative(alert.created_at)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
                    <CheckCircle2 className="size-6 text-success" />
                    <p className="text-xs font-medium">No alerts recorded</p>
                    <p className="max-w-xs text-[11px] text-muted-foreground">
                      Alerts appear when configured rules or drift checks fire. Silence here is not proof of model health.
                    </p>
                  </div>
                )}
              </SectionCard>

              <SectionCard
                title="API process resources"
                description={data.resources.note ?? "Process-wide resources, not per-deployment."}
                className="xl:col-span-1"
                actions={<Cpu className="size-4 text-muted-foreground" />}
              >
                <div className="grid grid-cols-2 gap-2">
                  <MetricInline label="RSS memory" value={Math.round((data.resources.memory_rss_bytes ?? 0) / (1024 * 1024))} digits={0} />
                  <MetricInline label="CPU" value={data.resources.cpu_percent} digits={1} />
                  <MetricInline label="Threads" value={data.resources.threads} digits={0} />
                  <MetricInline label="Open files" value={data.resources.open_files} digits={0} />
                </div>
                <p className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Timer className="size-3" /> Measured {fmtRelative(data.resources.measured_at)}
                </p>
              </SectionCard>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <SectionCard
              title="Recent training runs"
              description="Held-out metrics from real training jobs."
              className="xl:col-span-2"
              actions={
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/experiments">
                    Experiments <ArrowRight />
                  </Link>
                </Button>
              }
              contentClassName="pt-0"
            >
              {data.recent_runs.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Run</TH>
                        <TH>Project</TH>
                        <TH>Status</TH>
                        <TH>Primary metric</TH>
                        <TH>Duration</TH>
                        <TH>Created</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.recent_runs.map((run) => {
                        const primary = primaryMetricName(
                          run.metrics?.roc_auc !== undefined ? "classification" : "regression",
                        );
                        const value = typeof run.metrics?.[primary] === "number" ? Number(run.metrics[primary]) : null;
                        return (
                          <TR key={run.id}>
                            <TD className="max-w-56">
                              <Link href={`/experiments?run=${run.id}`} className="block truncate text-xs font-medium hover:underline">
                                {run.name}
                              </Link>
                              <span className="text-[10px] text-muted-foreground">{titleCase(run.algorithm)}</span>
                            </TD>
                            <TD className="text-xs">
                              <Link href={`/projects/${run.project_id}`} className="hover:underline">
                                {run.project_name}
                              </Link>
                            </TD>
                            <TD>
                              <StatusBadge status={run.status} />
                            </TD>
                            <TD className="text-xs tabular-nums">
                              <span className="text-muted-foreground">{metricLabel(primary)} </span>
                              {fmtMetric(value, 4)}
                            </TD>
                            <TD className="text-xs text-muted-foreground">{run.duration_seconds ? `${run.duration_seconds.toFixed(1)}s` : "—"}</TD>
                            <TD className="text-xs text-muted-foreground">{fmtRelative(run.created_at)}</TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <EmptyState
                  title="No training runs yet"
                  description="Train a model from a project to see real evaluation metrics here."
                  icon={TrendingUp}
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/projects">Open projects</Link>
                    </Button>
                  }
                />
              )}
            </SectionCard>

            <SectionCard
              title="Drift activity"
              description="Latest dataset and prediction drift reports."
              actions={
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/monitoring">
                    <Gauge /> Monitoring
                  </Link>
                </Button>
              }
            >
              {data.recent_drift_reports.length ? (
                <ul className="space-y-2">
                  {data.recent_drift_reports.map((report) => (
                    <li key={report.id} className="rounded-lg border p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          href={`/monitoring?report=${report.id}`}
                          className="min-w-0 text-xs font-medium hover:underline"
                        >
                          {report.deployment_name ?? report.project_name}
                        </Link>
                        <SeverityBadge severity={report.severity} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span>
                          {report.drifted_feature_count}/{report.feature_count} features drifted
                        </span>
                        <span>·</span>
                        <span>{fmtPercent(report.drift_share, 0)} share</span>
                        <span>·</span>
                        <span>{fmtRelative(report.created_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
                  <Database className="size-6 text-muted-foreground" />
                  <p className="text-xs font-medium">No drift reports</p>
                  <p className="max-w-xs text-[11px] text-muted-foreground">
                    Run a drift analysis from Monitoring after a deployment has captured samples.
                  </p>
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard
            title="Projects"
            description="Recently updated projects in this workspace."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/projects">
                  <FolderKanban /> View all
                </Link>
              </Button>
            }
          >
            {data.projects.length ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/20"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold group-hover:text-primary">{project.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {project.description || "No description"}
                        </p>
                      </div>
                      <TaskBadge taskType={project.task_type} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Badge tone="muted">{project.dataset_count} datasets</Badge>
                      <Badge tone="muted">{project.model_count} models</Badge>
                      <Badge tone="muted">{project.deployment_count} deployments</Badge>
                      <span className="ml-auto">{fmtRelative(project.updated_at)}</span>
                    </div>
                    {project.latest_run ? (
                      <div className="mt-3 flex items-center justify-between rounded-lg bg-muted/40 px-2.5 py-1.5 text-[10px]">
                        <span className="truncate">{project.latest_run.name}</span>
                        <span className="ml-2 shrink-0 font-medium tabular-nums">
                          {primaryMetricLabel(project.task_type)}{" "}
                          {fmtMetric(
                            typeof project.latest_run.metrics?.[primaryMetricName(project.task_type)] === "number"
                              ? Number(project.latest_run.metrics[primaryMetricName(project.task_type)])
                              : null,
                            3,
                          )}
                        </span>
                      </div>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No projects in this workspace yet.</p>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
