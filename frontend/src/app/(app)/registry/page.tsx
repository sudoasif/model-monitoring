"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  GitBranch,
  History,
  PackageCheck,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  CopyButton,
  DetailRow,
  EmptyHint,
  SectionCard,
  StatusBadge,
  TaskBadge,
} from "@/components/common";
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api";
import {
  useModelVersions,
  useModels,
  useProjectOptions,
  useVersion,
} from "@/lib/hooks";
import type { Metrics, ModelVersion } from "@/lib/types";
import {
  cn,
  errorMessage,
  fmtDate,
  fmtMetric,
  fmtNumber,
  fmtRelative,
  metricLabel,
  metricOrder,
  primaryMetricName,
  titleCase,
  truncateMiddle,
} from "@/lib/utils";

const CARD_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: "intended_use", label: "Intended use", hint: "What decisions should this model support, and for whom?" },
  { key: "limitations", label: "Limitations", hint: "Known failure modes, excluded populations and unsupported inputs." },
  { key: "training_data", label: "Training data", hint: "Source, collection window, reference dataset version and known caveats." },
  { key: "evaluation", label: "Evaluation", hint: "Held-out protocol, primary metric, slice results and confidence notes." },
  { key: "ethical_considerations", label: "Ethical considerations", hint: "Fairness, privacy and human-oversight considerations." },
  { key: "owner", label: "Owner", hint: "Accountable team or person." },
];

function numericMetrics(metrics: Metrics | null | undefined): Array<[string, number]> {
  if (!metrics) return [];
  return Object.entries(metrics).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
}

function versionTaskType(version: ModelVersion): string {
  if (typeof version.params?.task_type === "string") return version.params.task_type;
  return version.metrics?.roc_auc !== undefined || version.metrics?.accuracy !== undefined
    ? "classification"
    : "regression";
}

function ValidationBadge({ version }: { version: ModelVersion }) {
  const status = version.validation_status || version.validation?.status || "unknown";
  return <StatusBadge status={status} label={status === "passed" ? "Passed" : titleCase(status)} />;
}

function VersionDialog({
  versionId,
  open,
  onOpenChange,
  isAdmin,
}: {
  versionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: version, isLoading, error, refetch } = useVersion(open ? versionId : null);
  const [tab, setTab] = React.useState("overview");
  const [note, setNote] = React.useState("");
  const [promote, setPromote] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [promoteTarget, setPromoteTarget] = React.useState("production");
  const [promoteNote, setPromoteNote] = React.useState("");
  const [card, setCard] = React.useState<Record<string, string>>({});
  const [integrity, setIntegrity] = React.useState<Record<string, unknown> | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTab("overview");
      setNote("");
      setPromote(false);
      setRejectReason("");
      setPromoteTarget("production");
      setPromoteNote("");
      setIntegrity(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (version) setCard(version.model_card ?? {});
  }, [version]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["version", versionId] });
    void queryClient.invalidateQueries({ queryKey: ["model-versions"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({ queryKey: ["deployments"] });
  };

  const approveMutation = useMutation({
    mutationFn: () =>
      api<ModelVersion>(`/versions/${versionId}/approve`, {
        method: "POST",
        body: { note: note.trim(), promote_to_production: promote },
      }),
    onSuccess: () => {
      toast.success("Model version approved. Deployment still requires a separate explicit action.");
      invalidate();
    },
    onError: (caught) => toast.error(errorMessage(caught)),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      api<ModelVersion>(`/versions/${versionId}/reject`, {
        method: "POST",
        body: { reason: rejectReason.trim() },
      }),
    onSuccess: () => {
      toast.success("Model version rejected.");
      invalidate();
    },
    onError: (caught) => toast.error(errorMessage(caught)),
  });

  const promoteMutation = useMutation({
    mutationFn: () =>
      api<ModelVersion>(`/versions/${versionId}/promote`, {
        method: "POST",
        body: { target: promoteTarget, note: promoteNote.trim() },
      }),
    onSuccess: () => {
      toast.success("Model stage updated. Existing deployments were not changed.");
      invalidate();
    },
    onError: (caught) => toast.error(errorMessage(caught)),
  });

  const cardMutation = useMutation({
    mutationFn: () =>
      api<ModelVersion>(`/versions/${versionId}/model-card`, {
        method: "PATCH",
        body: Object.fromEntries(CARD_FIELDS.map((field) => [field.key, card[field.key] ?? ""])),
      }),
    onSuccess: () => {
      toast.success("Model card saved.");
      invalidate();
    },
    onError: (caught) => toast.error(errorMessage(caught)),
  });

  const integrityMutation = useMutation({
    mutationFn: () => api<Record<string, unknown>>(`/registry/version/${versionId}/integrity`),
    onSuccess: (result) => {
      setIntegrity(result);
      if (result.integrity_ok) toast.success("Artifact SHA-256 matches the registered hash.");
      else toast.error("Artifact integrity verification failed.");
    },
    onError: (caught) => toast.error(errorMessage(caught)),
  });

  const orderedMetrics = React.useMemo(() => {
    if (!version) return [];
    const preferred = metricOrder(versionTaskType(version));
    return numericMetrics(version.metrics).sort((a, b) => {
      const ai = preferred.indexOf(a[0]);
      const bi = preferred.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [version]);

  const checks = version?.validation?.checks ?? [];
  const validationFailed = version?.validation_status === "failed";
  const canApprove = isAdmin && version?.approval_status !== "approved" && !validationFailed;
  const canPromoteProduction = isAdmin && version?.approval_status === "approved" && !validationFailed;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {version ? `${version.training_run_name || "Model"} · version ${version.version}` : "Model version"}
            {version ? <StatusBadge status={version.approval_status} /> : null}
            {version?.stage && version.stage !== "none" ? <Badge tone="info">{titleCase(version.stage)}</Badge> : null}
          </DialogTitle>
          <DialogDescription>
            Approval, promotion and deployment are separate, audited actions. A strong offline score never deploys a model.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isLoading ? <LoadingBlock label="Loading model version…" /> : null}
          {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
          {version ? (
            <>
              {version.approval_status === "pending" ? (
                <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs">
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="size-3.5 text-warning" /> Awaiting human approval
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    This version is registered and validated but cannot be deployed until a workspace administrator approves it.
                  </p>
                </div>
              ) : null}
              {version.rejected_reason ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                  <span className="font-medium">Rejected:</span> {version.rejected_reason}
                </div>
              ) : null}

              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="validation">Validation</TabsTrigger>
                  <TabsTrigger value="model-card">Model card</TabsTrigger>
                  <TabsTrigger value="governance">Governance</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {orderedMetrics.slice(0, 8).map(([key, value]) => (
                      <div key={key} className="rounded-lg border bg-muted/20 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{metricLabel(key)}</div>
                        <div className="mt-0.5 text-lg font-semibold tabular-nums">{fmtMetric(value, 4)}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionCard title="Lineage" description="Every version is traceable to a real run and dataset." contentClassName="pt-2">
                      <dl>
                        <DetailRow label="Algorithm">
                          <span>{version.algorithm ? titleCase(version.algorithm) : "Not recorded"}</span>
                        </DetailRow>
                        <DetailRow label="Training run">
                          {version.training_run_id ? (
                            <Link href={`/experiments?run=${version.training_run_id}`} className="text-primary hover:underline">
                              {version.training_run_name || version.training_run_id}
                            </Link>
                          ) : (
                            "Not linked"
                          )}
                        </DetailRow>
                        <DetailRow label="Dataset">
                          {version.dataset_name ? `${version.dataset_name} · v${version.dataset_version}` : "Not recorded"}
                        </DetailRow>
                        <DetailRow label="MLflow run">
                          <span className="font-mono text-[11px]">{version.mlflow_run_id || "not tracked"}</span>
                        </DetailRow>
                        <DetailRow label="MLflow model">
                          <span className="font-mono text-[11px]">{version.mlflow_model_uri || "not registered"}</span>
                        </DetailRow>
                        <DetailRow label="Feature count">{version.feature_schema?.length ?? 0}</DetailRow>
                        <DetailRow label="Created">{fmtDate(version.created_at)}</DetailRow>
                      </dl>
                    </SectionCard>

                    <SectionCard title="Artifact integrity" description="The registered SHA-256 hash is checked against stored bytes on demand." contentClassName="space-y-3 pt-2">
                      <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[10px]">
                          {version.artifact_hash}
                        </code>
                        <CopyButton value={version.artifact_hash} label="Copy" />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => integrityMutation.mutate()}
                        disabled={integrityMutation.isPending}
                      >
                        <ShieldCheck /> {integrityMutation.isPending ? "Verifying…" : "Verify artifact"}
                      </Button>
                      {integrity ? (
                        <div
                          className={cn(
                            "rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
                            integrity.integrity_ok
                              ? "border-success/30 bg-success/5"
                              : "border-destructive/30 bg-destructive/5",
                          )}
                        >
                          <p className="flex items-center gap-1.5 font-medium">
                            {integrity.integrity_ok ? <CheckCircle2 className="size-3.5 text-success" /> : <XCircle className="size-3.5 text-destructive" />}
                            {integrity.integrity_ok ? "Integrity verified" : "Integrity check failed"}
                          </p>
                          {typeof integrity.actual_hash === "string" ? (
                            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                              actual: {integrity.actual_hash}
                            </p>
                          ) : null}
                          {typeof integrity.error === "string" ? <p className="mt-1 text-muted-foreground">{integrity.error}</p> : null}
                        </div>
                      ) : null}
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        Deployments load only the platform-generated artifact bundle. Uploaded code is never executed and
                        artifact loading uses integrity-checked storage paths.
                      </p>
                    </SectionCard>
                  </div>

                  {version.feature_schema?.length ? (
                    <SectionCard title="Feature schema" description="Inputs expected by the model, after preprocessing.">
                      <div className="flex flex-wrap gap-1.5">
                        {version.feature_schema.map((field) => (
                          <Badge key={field.name} tone={field.kind === "numeric" ? "info" : "muted"}>
                            {field.name}
                            {field.kind ? ` · ${field.kind}` : ""}
                          </Badge>
                        ))}
                      </div>
                    </SectionCard>
                  ) : null}
                </TabsContent>

                <TabsContent value="validation" className="space-y-4">
                  <SectionCard
                    title="Validation gates"
                    description="Backend policy checks are enforced before approval and deployment."
                    actions={<ValidationBadge version={version} />}
                  >
                    <dl className="grid gap-x-6 sm:grid-cols-2">
                      <DetailRow label="Status">{titleCase(version.validation_status || "unknown")}</DetailRow>
                      <DetailRow label="Evaluated on">{version.validation?.evaluated_on || "Held-out test split"}</DetailRow>
                      <DetailRow label="Primary metric">{metricLabel(version.validation?.primary_metric || primaryMetricName(versionTaskType(version)))}</DetailRow>
                      <DetailRow label="Primary value">{fmtMetric(version.validation?.primary_value, 4)}</DetailRow>
                      <DetailRow label="Train metric">{fmtMetric(version.validation?.train_metric, 4)}</DetailRow>
                      <DetailRow label="Policy">{version.validation?.policy ? "Recorded" : "Default"}</DetailRow>
                    </dl>
                    {checks.length ? (
                      <div className="mt-3 overflow-x-auto rounded-lg border">
                        <Table>
                          <THead>
                            <TR>
                              <TH>Check</TH>
                              <TH>Result</TH>
                              <TH>Observed</TH>
                              <TH>Threshold</TH>
                              <TH>Message</TH>
                            </TR>
                          </THead>
                          <TBody>
                            {checks.map((check) => (
                              <TR key={check.name}>
                                <TD className="text-xs font-medium">{titleCase(check.name)}</TD>
                                <TD>
                                  <Badge tone={check.passed ? "success" : "danger"}>
                                    {check.passed ? <CheckCircle2 /> : <XCircle />} {check.passed ? "Passed" : "Failed"}
                                  </Badge>
                                </TD>
                                <TD className="text-xs tabular-nums">{String(check.observed)}</TD>
                                <TD className="text-xs tabular-nums">{String(check.threshold)}</TD>
                                <TD className="max-w-80 text-[11px] text-muted-foreground">{check.message}</TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </div>
                    ) : (
                      <EmptyHint>No individual checks were recorded for this version.</EmptyHint>
                    )}
                  </SectionCard>
                  {version.validation?.policy ? (
                    <SectionCard title="Recorded policy" description="The exact policy evaluated at registration time.">
                      <CodeBlock>{JSON.stringify(version.validation.policy, null, 2)}</CodeBlock>
                    </SectionCard>
                  ) : null}
                </TabsContent>

                <TabsContent value="model-card" className="space-y-4">
                  <SectionCard
                    title="Model card"
                    description="Document intended use, limitations and accountability. Changes are audited."
                    actions={
                      <Button size="sm" onClick={() => cardMutation.mutate()} disabled={cardMutation.isPending}>
                        <FileCheck2 /> {cardMutation.isPending ? "Saving…" : "Save model card"}
                      </Button>
                    }
                  >
                    <div className="grid gap-3 md:grid-cols-2">
                      {CARD_FIELDS.map((field) => (
                        <Field key={field.key} label={field.label} hint={field.hint} htmlFor={`card-${field.key}`}>
                          <Textarea
                            id={`card-${field.key}`}
                            value={card[field.key] ?? ""}
                            onChange={(event) => setCard((current) => ({ ...current, [field.key]: event.target.value }))}
                            rows={3}
                            maxLength={4000}
                          />
                        </Field>
                      ))}
                    </div>
                    <p className="mt-3 text-[10px] text-muted-foreground">
                      {version.model_card?.last_edited_by
                        ? `Last edited by ${version.model_card.last_edited_by} · ${fmtRelative(version.model_card.last_edited_at)}`
                        : "The model card has not been edited since registration."}
                    </p>
                  </SectionCard>
                </TabsContent>

                <TabsContent value="governance" className="space-y-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionCard title="Approval record" description="Human sign-off is required before deployment." contentClassName="pt-2">
                      <dl>
                        <DetailRow label="Approval status"><StatusBadge status={version.approval_status} /></DetailRow>
                        <DetailRow label="Approved by">{version.approved_by_name || "—"}</DetailRow>
                        <DetailRow label="Approved at">{fmtDate(version.approved_at)}</DetailRow>
                        <DetailRow label="Approval note">{version.approval_note || "—"}</DetailRow>
                        <DetailRow label="Validation"><ValidationBadge version={version} /></DetailRow>
                        <DetailRow label="Deployments">{fmtNumber(version.deployment_count)}</DetailRow>
                      </dl>
                      {!isAdmin ? (
                        <p className="mt-3 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                          Workspace administrator access is required to approve, reject or promote versions.
                        </p>
                      ) : null}
                    </SectionCard>

                    <SectionCard title="Artifact integrity" description="Verify the stored bytes before promotion." contentClassName="space-y-2 pt-2">
                      <Button variant="outline" size="sm" onClick={() => integrityMutation.mutate()} disabled={integrityMutation.isPending}>
                        <ShieldCheck /> {integrityMutation.isPending ? "Verifying…" : "Run integrity check"}
                      </Button>
                      <p className="break-all font-mono text-[10px] text-muted-foreground">{version.artifact_hash}</p>
                      {integrity ? (
                        <p className={cn("text-[11px] font-medium", integrity.integrity_ok ? "text-success" : "text-destructive")}>
                          {integrity.integrity_ok ? "SHA-256 matches." : `Verification failed${integrity.error ? `: ${String(integrity.error)}` : "."}`}
                        </p>
                      ) : null}
                    </SectionCard>
                  </div>

                  {isAdmin ? (
                    <div className="grid gap-4 lg:grid-cols-3">
                      <SectionCard title="Approve" description="Approval does not deploy the model.">
                        <div className="space-y-2">
                          <Field label="Approval note" htmlFor="approve-note" hint="Optional">
                            <Textarea
                              id="approve-note"
                              value={note}
                              onChange={(event) => setNote(event.target.value)}
                              rows={2}
                              maxLength={2000}
                              placeholder="Reviewed held-out metrics, validation checks and model card."
                            />
                          </Field>
                          <Checkbox
                            checked={promote}
                            onChange={(event) => setPromote(event.target.checked)}
                            label="Also mark this version as production stage"
                          />
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={() => approveMutation.mutate()}
                            disabled={!canApprove || approveMutation.isPending}
                          >
                            <CheckCircle2 /> {approveMutation.isPending ? "Approving…" : "Approve version"}
                          </Button>
                          {validationFailed ? (
                            <p className="text-[10px] text-destructive">Failed validation gates cannot be approved.</p>
                          ) : null}
                        </div>
                      </SectionCard>

                      <SectionCard title="Reject" description="Rejection requires a reason and blocks deployment.">
                        <div className="space-y-2">
                          <Field label="Reason" required htmlFor="reject-reason">
                            <Textarea
                              id="reject-reason"
                              value={rejectReason}
                              onChange={(event) => setRejectReason(event.target.value)}
                              rows={2}
                              maxLength={2000}
                              placeholder="Explain the concrete quality or policy issue."
                            />
                          </Field>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="w-full"
                            onClick={() => rejectMutation.mutate()}
                            disabled={rejectReason.trim().length < 3 || rejectMutation.isPending || version.deployment_count > 0}
                          >
                            <XCircle /> {rejectMutation.isPending ? "Rejecting…" : "Reject version"}
                          </Button>
                          {version.deployment_count > 0 ? (
                            <p className="text-[10px] text-destructive">Roll back or delete linked deployments before rejecting.</p>
                          ) : null}
                        </div>
                      </SectionCard>

                      <SectionCard title="Promote stage" description="Stage changes are advisory labels for operators; deployments are separate.">
                        <div className="space-y-2">
                          <Field label="Target stage" htmlFor="promote-target">
                            <Select id="promote-target" value={promoteTarget} onChange={(event) => setPromoteTarget(event.target.value)}>
                              <option value="production">Production</option>
                              <option value="staging">Staging</option>
                              <option value="archived">Archived</option>
                              <option value="none">None</option>
                            </Select>
                          </Field>
                          <Field label="Note" htmlFor="promote-note">
                            <Input
                              id="promote-note"
                              value={promoteNote}
                              onChange={(event) => setPromoteNote(event.target.value)}
                              maxLength={2000}
                              placeholder="Why is this stage changing?"
                            />
                          </Field>
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={() => promoteMutation.mutate()}
                            disabled={promoteMutation.isPending || (promoteTarget === "production" && !canPromoteProduction)}
                          >
                            <Rocket /> {promoteMutation.isPending ? "Updating…" : "Update stage"}
                          </Button>
                          {promoteTarget === "production" && !canPromoteProduction ? (
                            <p className="text-[10px] text-muted-foreground">Only approved, valid versions can be promoted to production.</p>
                          ) : null}
                        </div>
                      </SectionCard>
                    </div>
                  ) : null}

                  <SectionCard title="Why this is gated" description="Model governance rules enforced by the backend.">
                    <ul className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
                      <li className="flex gap-2">
                        <ClipboardCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                        Training registers a version as pending. Approval is an explicit administrator action.
                      </li>
                      <li className="flex gap-2">
                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                        Failed validation gates cannot be approved or deployed, regardless of the offline score.
                      </li>
                      <li className="flex gap-2">
                        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-success" />
                        Promotion never edits an existing deployment. Deploying a version is a separate action with its own audit entry.
                      </li>
                      <li className="flex gap-2">
                        <History className="mt-0.5 size-3.5 shrink-0 text-success" />
                        Every approval, rejection, promotion, integrity check and model-card edit is written to the audit log.
                      </li>
                    </ul>
                  </SectionCard>
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RegistryContent() {
  const searchParams = useSearchParams();
  const { isAdmin } = useAuth();
  const [projectId, setProjectId] = React.useState("");
  const [modelId, setModelId] = React.useState<string | null>(null);
  const [approval, setApproval] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const [versionOpen, setVersionOpen] = React.useState(false);

  const { data: projects, isLoading: projectsLoading } = useProjectOptions();
  const { data: models, isLoading, error, refetch, isFetching } = useModels(projectId || undefined);

  React.useEffect(() => {
    const project = searchParams.get("project");
    if (project) setProjectId(project);
    const model = searchParams.get("model");
    if (model) setModelId(model);
  }, [searchParams]);

  React.useEffect(() => {
    if (!projectId && projects?.items.length) setProjectId(projects.items[0].id);
  }, [projectId, projects]);

  const filteredModels = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return models ?? [];
    return (models ?? []).filter(
      (model) =>
        model.name.toLowerCase().includes(term) ||
        (model.description ?? "").toLowerCase().includes(term),
    );
  }, [models, search]);

  const activeModel = (models ?? []).find((model) => model.id === modelId) ?? (models ?? [])[0] ?? null;
  const { data: versions, isLoading: versionsLoading, error: versionsError, refetch: refetchVersions } = useModelVersions(
    activeModel?.id,
    approval || undefined,
  );

  const pending = (models ?? []).reduce((sum, model) => sum + model.pending_approvals, 0);
  const production = (models ?? []).filter((model) => model.production_version).length;
  const totalVersions = (models ?? []).reduce((sum, model) => sum + model.version_count, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Model Registry"
        title="Registered models"
        description="Versions are created by real training runs. Approval, stage promotion and deployment are deliberately separate so a score alone can never put a model in front of users."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => { void refetch(); void refetchVersions(); }} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Refresh
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/experiments">
                <History /> Training runs
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Registered models" value={models?.length ?? 0} hint={projectId ? "In the selected project" : "Select a project"} icon={PackageCheck} tone="primary" loading={isLoading} />
        <StatCard title="Pending approvals" value={pending} hint="Administrator sign-off required" icon={AlertTriangle} tone={pending ? "warning" : "success"} loading={isLoading} />
        <StatCard title="Production stages" value={production} hint="Advisory stage labels, not deployments" icon={Rocket} tone="success" loading={isLoading} />
        <StatCard title="Model versions" value={totalVersions} hint="All versions across this project" icon={Archive} tone="info" loading={isLoading} />
      </div>

      <SectionCard
        title="Choose a project"
        description="Model names are scoped to their project. Select a project to inspect versions and governance state."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setModelId(null);
                setApproval("");
              }}
              className="h-8 max-w-64 text-xs"
              aria-label="Project"
            >
              <option value="">{projectsLoading ? "Loading projects…" : "Select a project…"}</option>
              {(projects?.items ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <Button variant="outline" size="sm" asChild disabled={!projectId}>
              <Link href={projectId ? `/projects/${projectId}` : "/projects"}>Open project</Link>
            </Button>
          </div>
        }
      >
        {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
        {isLoading ? <LoadingBlock label="Loading registered models…" /> : null}
        {!isLoading && !error && !models?.length ? (
          <EmptyState
            title={projectId ? "No registered models in this project" : "Select a project"}
            description={
              projectId
                ? "Run a training job. A successful run registers a version as pending approval."
                : "Choose a project above to see its registered models and versions."
            }
            icon={PackageCheck}
            action={projectId ? <Button asChild><Link href={`/projects/${projectId}`}>Open training</Link></Button> : undefined}
          />
        ) : null}
        {models?.length ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search models…"
                  className="h-8 pl-8 text-xs"
                  aria-label="Search models"
                />
              </div>
              <span className="text-[11px] text-muted-foreground">{filteredModels.length} models</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredModels.map((model) => {
                const active = activeModel?.id === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setModelId(model.id)}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-colors",
                      active ? "border-primary/50 bg-primary/5" : "bg-card hover:border-primary/30 hover:bg-muted/20",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{model.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {model.description || "No description"}
                        </p>
                      </div>
                      <TaskBadge taskType={model.task_type} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <Badge tone="muted">{model.version_count} versions</Badge>
                      {model.pending_approvals ? <Badge tone="warning">{model.pending_approvals} pending</Badge> : <Badge tone="success">No pending</Badge>}
                      {model.production_version ? (
                        <Badge tone="success">Production v{model.production_version.version}</Badge>
                      ) : (
                        <Badge tone="muted">No production stage</Badge>
                      )}
                      <span className="ml-auto text-muted-foreground">{fmtRelative(model.created_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </SectionCard>

      {activeModel ? (
        <SectionCard
          title={`Versions · ${activeModel.name}`}
          description="Validation, approval and stage state for every version. Open a version to inspect metrics, the model card and artifact integrity."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={approval} onChange={(event) => setApproval(event.target.value)} className="h-8 w-auto text-xs" aria-label="Approval filter">
                <option value="">All approval states</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void refetchVersions()}>
                <RefreshCw /> Refresh
              </Button>
            </div>
          }
          contentClassName="pt-0"
        >
          {versionsError ? <ErrorState message={errorMessage(versionsError)} onRetry={() => void refetchVersions()} /> : null}
          {versionsLoading ? <LoadingBlock label="Loading versions…" /> : null}
          {!versionsLoading && !versions?.length ? (
            <EmptyState
              title={approval ? "No versions match this approval filter" : "No versions yet"}
              description={approval ? "Clear the filter to see all versions." : "Train a model to register the first version."}
              icon={Archive}
            />
          ) : null}
          {versions?.length ? (
            <div className="overflow-hidden rounded-lg border">
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Version</TH>
                      <TH>Approval</TH>
                      <TH>Stage</TH>
                      <TH>Validation</TH>
                      <TH>Primary metric</TH>
                      <TH>Deployments</TH>
                      <TH>Artifact</TH>
                      <TH>Created</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {versions.map((version) => {
                      const taskType = versionTaskType(version);
                      const primary = primaryMetricName(taskType);
                      const value = typeof version.metrics?.[primary] === "number" ? Number(version.metrics[primary]) : null;
                      return (
                        <TR key={version.id}>
                          <TD>
                            <span className="font-mono text-xs font-semibold">v{version.version}</span>
                            <span className="block max-w-44 truncate text-[10px] text-muted-foreground">
                              {version.training_run_name || version.algorithm || "Training run"}
                            </span>
                          </TD>
                          <TD><StatusBadge status={version.approval_status} /></TD>
                          <TD><Badge tone={version.stage === "production" ? "success" : version.stage === "staging" ? "info" : "muted"}>{titleCase(version.stage)}</Badge></TD>
                          <TD><ValidationBadge version={version} /></TD>
                          <TD className="whitespace-nowrap text-xs tabular-nums">
                            <span className="text-muted-foreground">{metricLabel(primary)} </span>
                            {fmtMetric(value, 4)}
                          </TD>
                          <TD className="text-xs tabular-nums">{fmtNumber(version.deployment_count)}</TD>
                          <TD>
                            <span className="font-mono text-[10px] text-muted-foreground" title={version.artifact_hash}>
                              {truncateMiddle(version.artifact_hash, 8, 6)}
                            </span>
                          </TD>
                          <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtRelative(version.created_at)}</TD>
                          <TD>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setVersionId(version.id);
                                setVersionOpen(true);
                              }}
                            >
                              Review
                            </Button>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </div>
          ) : null}
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            Artifact hashes are shortened in the table. Open a version to verify the full SHA-256 digest against stored bytes.
            Model versions cannot be deleted; rejected versions remain for audit.
          </p>
        </SectionCard>
      ) : null}

      <VersionDialog versionId={versionId} open={versionOpen} onOpenChange={setVersionOpen} isAdmin={isAdmin} />
    </div>
  );
}

export default function RegistryPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <LoadingBlock label="Loading registry…" />
        </div>
      }
    >
      <RegistryContent />
    </React.Suspense>
  );
}
