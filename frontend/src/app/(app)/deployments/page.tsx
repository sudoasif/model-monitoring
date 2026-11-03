"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  Gauge,
  Plus,
  Rocket,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { toast } from "sonner";

import {
  CopyButton,
  ProjectSelect,
  SearchField,
  SectionCard,
  SeverityBadge,
  StatusBadge,
} from "@/components/common";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Label,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
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
import { useDebouncedValue, useDatasets, useDeployments, useModels, useModelVersions } from "@/lib/hooks";
import type { Deployment, DeploymentCreatedResult, DatasetVersion } from "@/lib/types";
import { errorMessage, fmtDate, fmtMs, fmtNumber, fmtPercent, fmtRelative, titleCase } from "@/lib/utils";

function flattenVersions(datasets: ReturnType<typeof useDatasets>["data"]): Array<DatasetVersion & { project_dataset: string }> {
  return (datasets ?? []).flatMap((dataset) =>
    dataset.versions.map((version) => ({ ...version, project_dataset: dataset.name })),
  );
}

function CreateDeploymentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [versionId, setVersionId] = React.useState("");
  const [referenceId, setReferenceId] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [minLabels, setMinLabels] = React.useState(30);
  const [created, setCreated] = React.useState<DeploymentCreatedResult | null>(null);

  const { data: models } = useModels(projectId || null);
  const { data: versions } = useModelVersions(modelId || null);
  const { data: datasets } = useDatasets(projectId || null);
  const datasetVersions = React.useMemo(() => flattenVersions(datasets), [datasets]);
  const approved = React.useMemo(
    () => (versions ?? []).filter((version) => version.approval_status === "approved"),
    [versions],
  );
  const selectedVersion = approved.find((version) => version.id === versionId) ?? null;
  const suggestedReference = React.useMemo(() => {
    if (selectedVersion?.dataset_version_id) {
      return datasetVersions.find((version) => version.id === selectedVersion.dataset_version_id)?.id ?? "";
    }
    return datasetVersions.find((version) => version.is_reference)?.id ?? "";
  }, [datasetVersions, selectedVersion]);

  React.useEffect(() => {
    if (!open) {
      setCreated(null);
    }
  }, [open]);

  React.useEffect(() => {
    setModelId("");
    setVersionId("");
    setReferenceId("");
  }, [projectId]);

  React.useEffect(() => {
    setVersionId("");
  }, [modelId]);

  React.useEffect(() => {
    if (!versionId) return;
    const version = approved.find((item) => item.id === versionId);
    if (version) {
      const model = (models ?? []).find((item) => item.id === version.registered_model_id);
      setName((current) => current || `${model?.name ?? "model"} v${version.version}`);
      const linked = datasetVersions.find((item) => item.id === version.dataset_version_id);
      setReferenceId(linked?.id ?? datasetVersions.find((item) => item.is_reference)?.id ?? "");
    }
  }, [approved, datasetVersions, models, versionId]);

  const mutation = useMutation({
    mutationFn: () =>
      api<DeploymentCreatedResult>("/deployments", {
        method: "POST",
        body: {
          project_id: projectId,
          model_version_id: versionId,
          name: name.trim(),
          description: description.trim(),
          reference_dataset_version_id: referenceId || null,
          min_label_samples: Number(minLabels) || 30,
        },
      }),
    onSuccess: (payload) => {
      setCreated(payload);
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      toast.success("Deployment created. Store the API key now — it will not be shown again.");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const reset = () => {
    setProjectId("");
    setModelId("");
    setVersionId("");
    setReferenceId("");
    setName("");
    setDescription("");
    setMinLabels(30);
    setCreated(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{created ? "Deployment created" : "Deploy an approved model"}</DialogTitle>
          <DialogDescription>
            {created
              ? "The API key is shown once. Copy it to a secret manager before closing this dialog."
              : "Only approved model versions can be deployed. A reference dataset is required for drift monitoring."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <DialogBody className="space-y-4">
            <div className="rounded-xl border border-success/30 bg-success/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-success" /> {created.name} is live
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Serving <span className="font-medium text-foreground">{created.model_name} v{created.model_version}</span> ·
                status <span className="font-medium text-foreground">{titleCase(created.status)}</span>
              </p>
            </div>
            <div className="space-y-2">
              <Label>API key (one-time display)</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={created.api_key} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                <CopyButton value={created.api_key} label="Copy key" />
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                The server stores only a hash and the prefix <span className="font-mono">{created.api_key_prefix}</span>. Rotate the
                key from the deployment settings if it is lost.
              </p>
            </div>
            <SectionCard title="Call the prediction API" contentClassName="pt-2">
              <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
{`curl -X POST "http://localhost:8000/api/predict/${created.slug}" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${created.api_key}" \\
  -d '{"features": { ... }, "return_probabilities": true}'`}
              </pre>
            </SectionCard>
          </DialogBody>
        ) : (
          <DialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project" required>
                <ProjectSelect
                  value={projectId}
                  onChange={setProjectId}
                  className="h-9 max-w-none"
                />
              </Field>
              <Field label="Registered model" required hint={projectId ? undefined : "Choose a project first"}>
                <Select
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  disabled={!projectId}
                  className="h-9"
                >
                  <option value="">Select a model…</option>
                  {(models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.version_count} version{model.version_count === 1 ? "" : "s"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Approved version" required hint={modelId ? `${approved.length} approved` : undefined}>
                <Select
                  value={versionId}
                  onChange={(event) => setVersionId(event.target.value)}
                  disabled={!modelId}
                  className="h-9"
                >
                  <option value="">Select an approved version…</option>
                  {approved.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version} · {version.approval_status} · {version.validation_status}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reference dataset version" hint="Used for drift baselines">
                <Select
                  value={referenceId}
                  onChange={(event) => setReferenceId(event.target.value)}
                  disabled={!projectId}
                  className="h-9"
                >
                  <option value="">{suggestedReference ? "Use training dataset" : "Select a dataset version…"}</option>
                  {datasetVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.project_dataset} v{version.version} · {fmtNumber(version.row_count)} rows
                      {version.is_reference ? " · reference" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {modelId && !approved.length ? (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                  This model has no approved versions. Approve a version in the{" "}
                  <Link href={`/registry?project=${projectId}`} className="font-medium text-primary hover:underline">
                    Model Registry
                  </Link>{" "}
                  before deploying.
                </span>
              </div>
            ) : null}

            <Field label="Deployment name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Fraud scoring · production" maxLength={160} />
            </Field>
            <Field label="Description" hint={`${description.length}/2000`}>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this endpoint is for, its consumers, and any operating constraints."
                maxLength={2000}
              />
            </Field>
            <Field label="Minimum labels for performance evaluation" hint="5–100,000">
              <Input
                type="number"
                min={5}
                max={100000}
                value={minLabels}
                onChange={(event) => setMinLabels(Number(event.target.value))}
                className="max-w-40"
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Deployment does not approve the model. The version must already have passed validation and received explicit approval.
              Model artifacts are loaded from the registry by hash; uploaded code is never executed.
            </p>
          </DialogBody>
        )}

        <DialogFooter>
          {created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button asChild>
                <Link href={`/deployments/${created.id}`}>
                  Open deployment <ArrowRight />
                </Link>
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={!projectId || !versionId || name.trim().length < 2 || mutation.isPending}
              >
                {mutation.isPending ? <Skeleton className="size-4 rounded-full" /> : <Rocket />}
                {mutation.isPending ? "Deploying…" : "Deploy model"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeploymentRow({ deployment }: { deployment: Deployment }) {
  return (
    <TR>
      <TD>
        <div className="flex min-w-0 flex-col">
          <Link href={`/deployments/${deployment.id}`} className="truncate font-medium text-foreground hover:text-primary">
            {deployment.name}
          </Link>
          <span className="truncate text-[11px] text-muted-foreground">
            {deployment.project_name} · <span className="font-mono">{deployment.slug}</span>
          </span>
        </div>
      </TD>
      <TD>
        <div className="flex flex-col">
          <span className="truncate text-xs font-medium">{deployment.model_name}</span>
          <span className="text-[11px] text-muted-foreground">v{deployment.model_version}</span>
        </div>
      </TD>
      <TD>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={deployment.status} />
          <StatusBadge status={deployment.last_health_status} label={deployment.last_health_status ? titleCase(deployment.last_health_status) : "No check"} />
        </div>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {deployment.last_health_at ? `checked ${fmtRelative(deployment.last_health_at)}` : "never checked"}
        </span>
      </TD>
      <TD>
        <div className="text-xs tabular-nums">
          <span className="font-medium">{fmtNumber(deployment.prediction_count)}</span>
          <span className="text-muted-foreground"> requests</span>
        </div>
        <div className="text-[11px] tabular-nums text-muted-foreground">
          error rate {deployment.error_rate === null ? "—" : fmtPercent(deployment.error_rate, 2)}
        </div>
      </TD>
      <TD>
        <span className="inline-flex items-center gap-1 text-xs tabular-nums">
          <Timer className="size-3 text-muted-foreground" /> {fmtMs(deployment.p95_latency_ms)}
        </span>
        <span className="block text-[10px] text-muted-foreground">p95 latency</span>
      </TD>
      <TD>
        <SeverityBadge severity={deployment.latest_drift_severity} />
        {deployment.latest_drift_at ? (
          <span className="mt-1 block text-[10px] text-muted-foreground">{fmtRelative(deployment.latest_drift_at)}</span>
        ) : null}
      </TD>
      <TD>
        <span className="text-[11px] text-muted-foreground">{fmtDate(deployment.created_at, false)}</span>
      </TD>
      <TD className="text-right">
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Open ${deployment.name}`}>
          <Link href={`/deployments/${deployment.id}`}>
            <ChevronRight />
          </Link>
        </Button>
      </TD>
    </TR>
  );
}

export default function DeploymentsPage() {
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [projectId, setProjectId] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [createOpen, setCreateOpen] = React.useState(false);
  const limit = 20;

  const { data, isLoading, error, refetch, isFetching } = useDeployments({
    project_id: projectId || undefined,
    status: status || undefined,
    q: debouncedSearch || undefined,
    limit,
    offset,
  });

  const items = data?.items ?? [];
  const activeCount = items.filter((item) => item.status === "active").length;
  const unhealthyCount = items.filter((item) => item.last_health_status === "unhealthy").length;
  const driftCount = items.filter((item) => ["high", "critical", "medium"].includes(item.latest_drift_severity ?? "")).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Serve"
        title="Deployments"
        description="Approved models served behind authenticated prediction endpoints, with health, traffic, latency, drift, and rollback controls."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <Activity className={isFetching ? "animate-pulse" : undefined} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> New deployment
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard className="p-4" contentClassName="pt-0">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Deployments in view</span>
            <Rocket className="size-4 text-primary" />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{data?.total ?? "—"}</div>
          <p className="text-[11px] text-muted-foreground">filtered result set</p>
        </SectionCard>
        <SectionCard className="p-4" contentClassName="pt-0">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Active on this page</span>
            <ShieldCheck className="size-4 text-success" />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{isLoading ? "—" : activeCount}</div>
          <p className="text-[11px] text-muted-foreground">of {items.length} shown</p>
        </SectionCard>
        <SectionCard className="p-4" contentClassName="pt-0">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Unhealthy</span>
            <AlertTriangle className="size-4 text-destructive" />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{isLoading ? "—" : unhealthyCount}</div>
          <p className="text-[11px] text-muted-foreground">latest health check failed</p>
        </SectionCard>
        <SectionCard className="p-4" contentClassName="pt-0">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Drift flagged</span>
            <Gauge className="size-4 text-warning" />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{isLoading ? "—" : driftCount}</div>
          <p className="text-[11px] text-muted-foreground">medium or higher on this page</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Serving endpoints"
        description="Prediction traffic is measured from real requests; simulated traffic is always labelled."
        contentClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="Search deployments…" />
          <ProjectSelect value={projectId} onChange={(value) => { setProjectId(value); setOffset(0); }} allowAll />
          <Select
            value={status}
            onChange={(event) => { setStatus(event.target.value); setOffset(0); }}
            className="h-8 max-w-40 text-xs"
            aria-label="Deployment status"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {data ? `${data.total} total` : null}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Rocket}
            title="No deployments yet"
            description={
              projectId || search || status
                ? "No deployments match the current filters. Clear filters or create a new endpoint."
                : "Deploy an approved model version to start collecting real prediction, latency, and drift telemetry."
            }
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> New deployment
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Deployment</TH>
                  <TH>Model</TH>
                  <TH>State</TH>
                  <TH>Traffic</TH>
                  <TH>Latency</TH>
                  <TH>Drift</TH>
                  <TH>Created</TH>
                  <TH className="text-right">Open</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((deployment) => (
                  <DeploymentRow key={deployment.id} deployment={deployment} />
                ))}
              </TBody>
            </Table>
            <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </SectionCard>

      <div className="grid gap-3 lg:grid-cols-3">
        <SectionCard title="Prediction contract" contentClassName="pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            POST a flat feature object to <span className="font-mono text-foreground">/api/predict/&#123;slug&#125;</span> with a
            bearer token or <span className="font-mono text-foreground">X-API-Key</span>. Request IDs are idempotent, probabilities are
            opt-in, and batch calls are limited by server configuration.
          </p>
        </SectionCard>
        <SectionCard title="Governance" contentClassName="pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Rollbacks only target approved versions. Promotion and rollback are explicit administrator actions recorded in the audit
            log. Training metrics never deploy a model automatically.
          </p>
        </SectionCard>
        <SectionCard title="Privacy" contentClassName="pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Raw prediction inputs are not logged by default. Monitoring stores derived features only when sample capture is enabled,
            and schema-safe defaults keep sensitive values out of the event log.
          </p>
        </SectionCard>
      </div>

      <CreateDeploymentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
