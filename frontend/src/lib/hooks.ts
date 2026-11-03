"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { api, qs } from "@/lib/api";
import type {
  Alert,
  AlertDetail,
  AlertRule,
  AlertSummary,
  AdminOverview,
  AlgorithmCatalog,
  AuditEvent,
  Dataset,
  DemoStatus,
  Deployment,
  DeploymentMonitoring,
  DriftOptions,
  DriftReport,
  Experiment,
  GlobalExplanation,
  Incident,
  JobSummary,
  LabelStatus,
  Member,
  Metrics,
  ModelVersion,
  Overview,
  Paged,
  Performance,
  PerformanceReport,
  PipelineJob,
  PredictionRow,
  PredictionSchema,
  Project,
  ProjectMonitoring,
  RegisteredModel,
  RetrainingStatus,
  RunArtifacts,
  SettingsSnapshot,
  Timeseries,
  TrainingRun,
  User,
  Workspace,
} from "@/lib/types";

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useProjects(params: { q?: string; status?: string; sort?: string; order?: string; limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ["projects", params],
    queryFn: () => api<Paged<Project>>(`/projects${qs(params)}`),
  });
}

export function useProject(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

export function useProjectOptions() {
  return useQuery({
    queryKey: ["projects", "options"],
    queryFn: () => api<Paged<Project>>("/projects?limit=100&sort=name&order=asc"),
    staleTime: 60_000,
  });
}

export function useDatasets(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => api<Dataset[]>(`/projects/${projectId}/datasets`),
    enabled: Boolean(projectId),
  });
}

export function useDeployments(
  params: { project_id?: string; status?: string; q?: string; limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ["deployments", params],
    queryFn: () => api<Paged<Deployment>>(`/deployments${qs(params)}`),
  });
}

export function useDeploymentOptions(projectId?: string | null) {
  return useQuery({
    queryKey: ["deployments", "options", projectId],
    queryFn: () => api<Paged<Deployment>>(`/deployments${qs({ project_id: projectId, limit: 200 })}`),
    staleTime: 30_000,
  });
}

export function useDeployment(deploymentId: string | null | undefined) {
  return useQuery({
    queryKey: ["deployment", deploymentId],
    queryFn: () => api<Deployment>(`/deployments/${deploymentId}`),
    enabled: Boolean(deploymentId),
  });
}

export function useModels(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["models", projectId],
    queryFn: () => api<RegisteredModel[]>(`/projects/${projectId}/models`),
    enabled: Boolean(projectId),
  });
}

export function useModelVersions(modelId: string | null | undefined, approvalStatus?: string) {
  return useQuery({
    queryKey: ["model-versions", modelId, approvalStatus],
    queryFn: () => api<ModelVersion[]>(`/models/${modelId}/versions${qs({ approval_status: approvalStatus })}`),
    enabled: Boolean(modelId),
  });
}

export function useVersion(versionId: string | null | undefined) {
  return useQuery({
    queryKey: ["version", versionId],
    queryFn: () => api<ModelVersion>(`/versions/${versionId}`),
    enabled: Boolean(versionId),
  });
}

export function useRuns(params: {
  project_id?: string;
  status?: string;
  algorithm?: string;
  q?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["runs", params],
    queryFn: () => api<Paged<TrainingRun>>(`/runs${qs(params)}`),
  });
}

export function useRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api<TrainingRun>(`/runs/${runId}`),
    enabled: Boolean(runId),
  });
}

export function useExperiments(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["experiments", projectId],
    queryFn: () => api<Experiment[]>(`/projects/${projectId}/experiments`),
    enabled: Boolean(projectId),
  });
}

export function useJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<PipelineJob>(`/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

export function useJobs(params: {
  job_type?: string;
  status?: string;
  project_id?: string;
  deployment_id?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["jobs", params],
    queryFn: () => api<Paged<PipelineJob>>(`/jobs${qs(params)}`),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((job) => job.status === "queued" || job.status === "running") ? 2500 : false;
    },
  });
}

export function useJobSummary() {
  return useQuery({
    queryKey: ["jobs", "summary"],
    queryFn: () => api<JobSummary>("/jobs/summary"),
    refetchInterval: 10_000,
  });
}

export function useAlertSummary(days = 30) {
  return useQuery({
    queryKey: ["alerts", "summary", days],
    queryFn: () => api<AlertSummary>(`/alerts/summary${qs({ days })}`),
    refetchInterval: 30_000,
  });
}

export function useAlerts(params: {
  status?: string;
  severity?: string;
  type?: string;
  project_id?: string;
  deployment_id?: string;
  simulated?: string;
  q?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["alerts", params],
    queryFn: () => api<Paged<Alert>>(`/alerts${qs(params)}`),
  });
}

export function useAlert(alertId: string | null | undefined) {
  return useQuery({
    queryKey: ["alert", alertId],
    queryFn: () => api<AlertDetail>(`/alerts/${alertId}`),
    enabled: Boolean(alertId),
  });
}

export function useAlertRules(projectId?: string | null) {
  return useQuery({
    queryKey: ["alert-rules", projectId],
    queryFn: () => api<{ items: AlertRule[]; total: number }>(`/alert-rules${qs({ project_id: projectId })}`),
  });
}

export function useIncidents(params: {
  status?: string;
  severity?: string;
  project_id?: string;
  deployment_id?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["incidents", params],
    queryFn: () => api<Paged<Incident>>(`/incidents${qs(params)}`),
  });
}

export function useDriftReports(params: {
  project_id?: string;
  deployment_id?: string;
  severity?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["drift-reports", params],
    queryFn: () => api<Paged<DriftReport>>(`/drift/reports${qs(params)}`),
  });
}

export function useDriftReport(reportId: string | null | undefined) {
  return useQuery({
    queryKey: ["drift-report", reportId],
    queryFn: () => api<DriftReport>(`/drift/reports/${reportId}`),
    enabled: Boolean(reportId),
  });
}

export function useDriftOptions(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["drift-options", projectId],
    queryFn: () => api<DriftOptions>(`/drift/options${qs({ project_id: projectId })}`),
    enabled: Boolean(projectId),
  });
}

export function usePerformance(deploymentId: string | null | undefined, days = 7, minLabels?: number) {
  return useQuery({
    queryKey: ["performance", deploymentId, days, minLabels],
    queryFn: () => api<Performance>(`/deployments/${deploymentId}/performance${qs({ days, min_labels: minLabels })}`),
    enabled: Boolean(deploymentId),
  });
}

export function useLabelStatus(deploymentId: string | null | undefined, days = 30) {
  return useQuery({
    queryKey: ["label-status", deploymentId, days],
    queryFn: () => api<LabelStatus>(`/deployments/${deploymentId}/labels/status${qs({ days })}`),
    enabled: Boolean(deploymentId),
  });
}

export function useRetrainingStatus(deploymentId: string | null | undefined) {
  return useQuery({
    queryKey: ["retraining-status", deploymentId],
    queryFn: () => api<RetrainingStatus>(`/deployments/${deploymentId}/retraining`),
    enabled: Boolean(deploymentId),
    refetchInterval: (query) => {
      const status = query.state.data?.active_job?.status;
      return status === "queued" || status === "running" ? 2500 : false;
    },
  });
}

export function useGlobalExplanation(deploymentId: string | null | undefined, topN = 15) {
  return useQuery({
    queryKey: ["explanation", deploymentId, topN],
    queryFn: () => api<GlobalExplanation>(`/deployments/${deploymentId}/explainability${qs({ top_n: topN })}`),
    enabled: Boolean(deploymentId),
    staleTime: 5 * 60_000,
  });
}

export function useDemoStatus() {
  return useQuery({
    queryKey: ["demo-status"],
    queryFn: () => api<DemoStatus>("/demo/status"),
    staleTime: 60_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsSnapshot>("/settings"),
  });
}

export function useAuditEvents(params: { action?: string; entity_type?: string; q?: string; limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ["audit-events", params],
    queryFn: () =>
      api<Paged<AuditEvent> & { available_actions: Array<{ action: string; count: number }> }>(
        `/audit-events${qs(params)}`,
      ),
  });
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<AdminOverview>("/admin/overview"),
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api<User[]>("/admin/users"),
    enabled,
  });
}

export function useMembers() {
  return useQuery({
    queryKey: ["members"],
    queryFn: () => api<Member[]>("/workspaces/current/members"),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/workspaces"),
  });
}

export function useOverview(days = 7) {
  return useQuery({
    queryKey: ["overview", days],
    queryFn: () => api<Overview>(`/overview${qs({ days })}`),
    refetchInterval: 60_000,
  });
}

export function useProjectMonitoring(projectId: string | null | undefined, days = 7) {
  return useQuery({
    queryKey: ["project-monitoring", projectId, days],
    queryFn: () => api<ProjectMonitoring>(`/projects/${projectId}/monitoring/summary${qs({ days })}`),
    enabled: Boolean(projectId),
  });
}

export function useAlgorithms(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["algorithms", projectId],
    queryFn: () => api<AlgorithmCatalog>(`/projects/${projectId}/algorithms`),
    enabled: Boolean(projectId),
    staleTime: 10 * 60_000,
  });
}

export function useRunArtifacts(runId: string | null | undefined) {
  return useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api<RunArtifacts>(`/runs/${runId}/artifacts`),
    enabled: Boolean(runId),
    retry: false,
  });
}

export function useDeploymentMonitoring(
  deploymentId: string | null | undefined,
  params: { days?: number; hours?: number; granularity?: string; simulated?: string } = {},
) {
  return useQuery({
    queryKey: ["deployment-monitoring", deploymentId, params],
    queryFn: () => api<DeploymentMonitoring>(`/deployments/${deploymentId}/monitoring${qs(params)}`),
    enabled: Boolean(deploymentId),
    refetchInterval: 30_000,
  });
}

export function useDeploymentTimeseries(
  deploymentId: string | null | undefined,
  params: { days?: number; hours?: number; granularity?: string; simulated?: string } = {},
) {
  return useQuery({
    queryKey: ["deployment-timeseries", deploymentId, params],
    queryFn: () => api<Timeseries>(`/deployments/${deploymentId}/monitoring/timeseries${qs(params)}`),
    enabled: Boolean(deploymentId),
  });
}

export function usePredictions(
  deploymentId: string | null | undefined,
  params: {
    status?: string;
    simulated?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["predictions", deploymentId, params],
    queryFn: () => api<Paged<PredictionRow>>(`/deployments/${deploymentId}/predictions${qs(params)}`),
    enabled: Boolean(deploymentId),
  });
}

export function usePerformanceTrend(deploymentId: string | null | undefined, days = 30) {
  return useQuery({
    queryKey: ["performance-trend", deploymentId, days],
    queryFn: () =>
      api<{
        points: Array<{ date: string; metrics: Metrics; label_count?: number; status?: string }>;
        baseline_metrics: Metrics;
        primary_metric: string;
        min_labels: number;
      }>(`/deployments/${deploymentId}/performance/trend${qs({ days })}`),
    enabled: Boolean(deploymentId),
  });
}

export function usePerformanceReports(deploymentId: string | null | undefined, limit = 10) {
  return useQuery({
    queryKey: ["performance-reports", deploymentId, limit],
    queryFn: () => api<Paged<PerformanceReport>>(`/deployments/${deploymentId}/performance/reports${qs({ limit })}`),
    enabled: Boolean(deploymentId),
  });
}

export function usePredictionSchema(deploymentId: string | null | undefined) {
  return useQuery({
    queryKey: ["prediction-schema", deploymentId],
    queryFn: () => api<PredictionSchema>(`/deployments/${deploymentId}/prediction-schema`),
    enabled: Boolean(deploymentId),
    staleTime: 5 * 60_000,
  });
}
