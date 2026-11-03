"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronRight,
  Clock,
  Plus,
  RefreshCw,
  ShieldAlert,
  Siren,
  Trash2,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import {
  DeploymentSelect,
  ProjectSelect,
  SearchField,
  SeverityBadge,
  SimulatedBadge,
  StatusBadge,
} from "@/components/common";
import { useAuth } from "@/components/providers";
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Input,
  InlineNote,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Switch,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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
import {
  useAlert,
  useAlertRules,
  useAlertSummary,
  useAlerts,
  useDebouncedValue,
  useIncidents,
  useMembers,
  useProjectOptions,
} from "@/lib/hooks";
import type { Alert, AlertRule, Incident, Member } from "@/lib/types";
import { errorMessage, fmtDate, fmtRelative, safeJson, titleCase } from "@/lib/utils";

const ALERT_TYPES = [
  { value: "data_drift_share", label: "Data drift share", hint: "Share of drifted features (0–1)", defaultValue: 0.3 },
  { value: "feature_psi", label: "Feature PSI", hint: "Maximum feature PSI", defaultValue: 0.2 },
  { value: "performance_degradation", label: "Performance degradation", hint: "Relative drop from baseline (0–1)", defaultValue: 0.1 },
  { value: "latency_p95", label: "p95 latency", hint: "p95 latency in milliseconds", defaultValue: 500 },
  { value: "error_rate", label: "Error rate", hint: "Failed request share (0–1)", defaultValue: 0.05 },
  { value: "invalid_input_rate", label: "Invalid input rate", hint: "Rejected input share (0–1)", defaultValue: 0.05 },
  { value: "prediction_distribution_psi", label: "Prediction distribution PSI", hint: "PSI of the output distribution", defaultValue: 0.2 },
  { value: "endpoint_unavailable", label: "Endpoint unavailable", hint: "1 = unhealthy, 0 = healthy", defaultValue: 0 },
] as const;

const ALERT_TYPE_MAP = Object.fromEntries(ALERT_TYPES.map((item) => [item.value, item]));

const SEVERITIES = ["info", "warning", "high", "critical"] as const;
const INCIDENT_STATUSES = ["open", "investigating", "mitigated", "resolved"] as const;
const CHANNELS = ["in_app", "email", "slack"] as const;

function typeLabel(type: string): string {
  return ALERT_TYPE_MAP[type]?.label ?? titleCase(type);
}

function typeHint(type: string): string {
  return ALERT_TYPE_MAP[type]?.hint ?? "Observed value";
}

function thresholdLabel(rule: Pick<AlertRule, "metric_type" | "threshold" | "comparison">): string {
  const unit = ALERT_TYPE_MAP[rule.metric_type]?.hint ?? "";
  const symbol = rule.comparison === "lt" ? "<" : ">";
  if (rule.metric_type === "latency_p95") return `${symbol} ${rule.threshold} ms`;
  if (rule.metric_type === "endpoint_unavailable") return `${symbol} ${rule.threshold} (1 = unhealthy)`;
  if (unit.includes("(0–1)")) return `${symbol} ${(rule.threshold * 100).toFixed(1)}%`;
  return `${symbol} ${rule.threshold}`;
}

function useInvalidateAlertViews() {
  const queryClient = useQueryClient();
  return React.useCallback(
    (alertId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts", "summary"] });
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (alertId) void queryClient.invalidateQueries({ queryKey: ["alert", alertId] });
    },
    [queryClient],
  );
}

// ------------------------------------------------------------------ alert detail

function AlertDetailDialog({
  alertId,
  open,
  onOpenChange,
}: {
  alertId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { isAdmin } = useAuth();
  const { data: alert, isLoading, isError, error, refetch } = useAlert(open ? alertId : null);
  const invalidate = useInvalidateAlertViews();
  const [note, setNote] = React.useState("");
  const [remediationResult, setRemediationResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setNote("");
      setRemediationResult(null);
    }
  }, [open]);

  const acknowledge = useMutation({
    mutationFn: () => api(`/alerts/${alertId}/acknowledge`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Alert acknowledged.");
      invalidate(alertId ?? undefined);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const resolve = useMutation({
    mutationFn: () =>
      api(`/alerts/${alertId}/resolve`, {
        method: "POST",
        body: { note: note.trim() },
      }),
    onSuccess: () => {
      toast.success("Alert resolved.");
      setNote("");
      invalidate(alertId ?? undefined);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const remediate = useMutation({
    mutationFn: (action: "open_incident" | "schedule_retraining" | "recommend_rollback") =>
      api<Record<string, unknown>>(`/alerts/${alertId}/remediation`, {
        method: "POST",
        body: { action, note: note.trim() },
      }),
    onSuccess: (payload, action) => {
      const message =
        action === "open_incident"
          ? "Incident opened and linked to this alert."
          : action === "schedule_retraining"
            ? "Retraining job queued. It remains approval-gated."
            : "Rollback recommendation recorded. No deployment was changed.";
      setRemediationResult(`${message}\n\n${safeJson(payload)}`);
      toast.success(message);
      invalidate(alertId ?? undefined);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const data = alert;
  const resolved = data?.status === "resolved";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {data?.title ?? "Alert detail"}
            {data ? <SeverityBadge severity={data.severity} /> : null}
            {data ? <StatusBadge status={data.status} /> : null}
            {data ? <SimulatedBadge simulated={data.simulated} /> : null}
          </DialogTitle>
          <DialogDescription>
            {data ? `${typeLabel(data.type)} · created ${fmtDate(data.created_at)} (${fmtRelative(data.created_at)})` : "Loading alert evidence and audit trail…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isLoading ? <LoadingBlock label="Loading alert…" /> : null}
          {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
          {data ? (
            <>
              <div className="rounded-lg border bg-muted/20 p-3 text-sm leading-relaxed">{data.message}</div>

              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="font-medium">{typeLabel(data.type)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="font-medium">{data.project_name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Deployment</dt>
                  <dd className="font-medium">{data.deployment_name ?? "Workspace-wide"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Rule</dt>
                  <dd className="font-medium">{data.rule?.name ?? "No linked rule"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Acknowledged</dt>
                  <dd className="font-medium">
                    {data.acknowledged_at ? `${fmtDate(data.acknowledged_at)}${data.acknowledged_by ? ` · ${data.acknowledged_by}` : ""}` : "Not acknowledged"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Resolved</dt>
                  <dd className="font-medium">{data.resolved_at ? fmtDate(data.resolved_at) : "Not resolved"}</dd>
                </div>
              </dl>

              {data.resolution_note ? (
                <InlineNote tone="success">
                  <span className="font-medium">Resolution:</span> {data.resolution_note}
                </InlineNote>
              ) : null}

              {data.rule ? (
                <div className="rounded-lg border p-3 text-xs">
                  <div className="font-medium">Triggering rule</div>
                  <div className="mt-1 text-muted-foreground">
                    {typeLabel(data.rule.metric_type ?? "")} · {data.rule.comparison === "lt" ? "below" : "above"}{" "}
                    {data.rule.threshold} · {data.rule.window_minutes} min window · channels{" "}
                    {(data.rule.channels ?? ["in_app"]).join(", ")}
                  </div>
                </div>
              ) : null}

              <details className="rounded-lg border p-3 text-xs">
                <summary className="cursor-pointer font-medium">Observed evidence (JSON)</summary>
                <CodeBlock className="mt-2">{safeJson(data.details)}</CodeBlock>
              </details>

              <details className="rounded-lg border p-3 text-xs">
                <summary className="cursor-pointer font-medium">Notification delivery</summary>
                <CodeBlock className="mt-2">{safeJson(data.notification)}</CodeBlock>
              </details>

              {data.incident ? (
                <div className="rounded-lg border border-info/40 bg-info/5 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Siren className="size-3.5" />
                    <span className="font-medium">Linked incident</span>
                    <StatusBadge status={data.incident.status} />
                    <SeverityBadge severity={data.incident.severity} />
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {data.incident.title} · updated {fmtRelative(data.incident.updated_at)}
                  </div>
                </div>
              ) : null}

              {data.remediation_log.length ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium">Remediation audit trail</div>
                  <ol className="space-y-2">
                    {data.remediation_log.map((entry, index) => {
                      const item = entry as Record<string, unknown>;
                      return (
                        <li key={index} className="rounded-lg border bg-muted/20 p-2.5 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="info">{titleCase(String(item.action ?? "action"))}</Badge>
                            <span className="text-muted-foreground">{String(item.actor_name ?? "Unknown actor")}</span>
                            <span className="text-muted-foreground">· {fmtDate(String(item.at ?? ""))}</span>
                            {item.automatic_change === false ? <Badge tone="success">No automatic change</Badge> : null}
                          </div>
                          {item.note ? <p className="mt-1 text-muted-foreground">{String(item.note)}</p> : null}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : null}

              {!resolved ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="text-xs font-medium">Operator note</div>
                  <Textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Required context for resolution or remediation. Recorded in the audit log."
                    rows={3}
                  />
                  <div className="flex flex-wrap gap-2">
                    {data.status === "open" ? (
                      <Button size="sm" variant="outline" onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>
                        <CheckCircle2 /> {acknowledge.isPending ? "Acknowledging…" : "Acknowledge"}
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => resolve.mutate()} disabled={resolve.isPending || !note.trim()}>
                      <CheckCircle2 /> {resolve.isPending ? "Resolving…" : "Resolve alert"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">A resolution note is required so the decision is auditable.</p>
                </div>
              ) : null}

              {!resolved ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="text-xs font-medium">Explicit remediation</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Actions are manual and audited. Scheduling retraining never deploys the result, and rollback
                    recommendation never changes the active deployment.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remediate.mutate("open_incident")}
                      disabled={remediate.isPending || Boolean(data.incident)}
                    >
                      <Siren /> Open incident
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remediate.mutate("schedule_retraining")}
                      disabled={remediate.isPending || !isAdmin || !data.deployment_id}
                      title={!isAdmin ? "Workspace administrator required" : !data.deployment_id ? "Alert is not linked to a deployment" : undefined}
                    >
                      <Workflow /> Schedule retraining
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remediate.mutate("recommend_rollback")}
                      disabled={remediate.isPending || !isAdmin || !data.deployment_id}
                      title={!isAdmin ? "Workspace administrator required" : !data.deployment_id ? "Alert is not linked to a deployment" : undefined}
                    >
                      <RefreshCw /> Recommend rollback
                    </Button>
                  </div>
                  {!isAdmin ? (
                    <p className="text-[11px] text-muted-foreground">
                      Workspace administrators can schedule retraining or record rollback recommendations. Members can open incidents.
                    </p>
                  ) : null}
                  {remediationResult ? <CodeBlock>{remediationResult}</CodeBlock> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ alert rules

type RuleFormState = {
  name: string;
  project_id: string;
  metric_type: string;
  comparison: string;
  threshold: string;
  window_minutes: string;
  severity: string;
  cooldown_minutes: string;
  min_samples: string;
  channels: string[];
  enabled: boolean;
};

function ruleToForm(rule: AlertRule | null): RuleFormState {
  return {
    name: rule?.name ?? "",
    project_id: rule?.project_id ?? "",
    metric_type: rule?.metric_type ?? "data_drift_share",
    comparison: rule?.comparison ?? "gt",
    threshold: rule ? String(rule.threshold) : "0.3",
    window_minutes: String(rule?.window_minutes ?? 60),
    severity: rule?.severity ?? "warning",
    cooldown_minutes: String(rule?.cooldown_minutes ?? 30),
    min_samples: String(rule?.min_samples ?? 0),
    channels: rule?.channels ?? ["in_app"],
    enabled: rule?.enabled ?? true,
  };
}

function RuleDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AlertRule | null;
}) {
  const queryClient = useQueryClient();
  const { data: projects } = useProjectOptions();
  const [form, setForm] = React.useState<RuleFormState>(() => ruleToForm(rule));

  React.useEffect(() => {
    if (open) setForm(ruleToForm(rule));
  }, [open, rule]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        metric_type: form.metric_type,
        comparison: form.comparison,
        threshold: Number(form.threshold),
        window_minutes: Number(form.window_minutes),
        severity: form.severity,
        cooldown_minutes: Number(form.cooldown_minutes),
        min_samples: Number(form.min_samples),
        channels: form.channels.length ? form.channels : ["in_app"],
        enabled: form.enabled,
      };
      return rule
        ? api(`/alert-rules/${rule.id}`, { method: "PATCH", body })
        : api(`/alert-rules`, { method: "POST", body: { ...body, project_id: form.project_id || null } });
    },
    onSuccess: () => {
      toast.success(rule ? "Alert rule updated." : "Alert rule created.");
      void queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const valid =
    form.name.trim().length >= 2 &&
    Number.isFinite(Number(form.threshold)) &&
    Number(form.window_minutes) >= 5 &&
    Number(form.cooldown_minutes) >= 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit alert rule" : "Create alert rule"}</DialogTitle>
          <DialogDescription>
            Rules are evaluated by the background monitoring pipeline over the selected window. Notification
            channels are only used when configured on the server.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Rule name" required htmlFor="rule-name">
              <Input
                id="rule-name"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="e.g. Critical data drift"
              />
            </Field>
            <Field label="Project scope" hint={rule ? "Scope is immutable" : "Optional"}>
              <Select
                value={form.project_id}
                disabled={Boolean(rule)}
                onChange={(event) => setForm((current) => ({ ...current, project_id: event.target.value }))}
              >
                <option value="">Workspace-wide (all projects)</option>
                {(projects?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Metric" hint={typeHint(form.metric_type)}>
              <Select
                value={form.metric_type}
                onChange={(event) => {
                  const metric = ALERT_TYPES.find((item) => item.value === event.target.value);
                  setForm((current) => ({
                    ...current,
                    metric_type: event.target.value,
                    threshold: metric ? String(metric.defaultValue) : current.threshold,
                  }));
                }}
              >
                {ALERT_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
              <Field label="Comparison">
                <Select
                  value={form.comparison}
                  onChange={(event) => setForm((current) => ({ ...current, comparison: event.target.value }))}
                >
                  <option value="gt">Above (&gt;)</option>
                  <option value="lt">Below (&lt;)</option>
                </Select>
              </Field>
              <Field label="Threshold" required>
                <Input
                  type="number"
                  step="any"
                  value={form.threshold}
                  onChange={(event) => setForm((current) => ({ ...current, threshold: event.target.value }))}
                />
              </Field>
            </div>
            <Field label="Window (minutes)" hint="5–10080">
              <Input
                type="number"
                min={5}
                max={10080}
                value={form.window_minutes}
                onChange={(event) => setForm((current) => ({ ...current, window_minutes: event.target.value }))}
              />
            </Field>
            <Field label="Cooldown (minutes)" hint="Deduplication window">
              <Input
                type="number"
                min={1}
                max={10080}
                value={form.cooldown_minutes}
                onChange={(event) => setForm((current) => ({ ...current, cooldown_minutes: event.target.value }))}
              />
            </Field>
            <Field label="Severity">
              <Select
                value={form.severity}
                onChange={(event) => setForm((current) => ({ ...current, severity: event.target.value }))}
              >
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {titleCase(severity)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Minimum samples" hint="Skip evaluation below this">
              <Input
                type="number"
                min={0}
                value={form.min_samples}
                onChange={(event) => setForm((current) => ({ ...current, min_samples: event.target.value }))}
              />
            </Field>
          </div>

          <Field label="Notification channels" hint="Server configuration required for email/Slack">
            <div className="flex flex-wrap gap-4 rounded-lg border p-3">
              {CHANNELS.map((channel) => (
                <Checkbox
                  key={channel}
                  label={titleCase(channel)}
                  checked={form.channels.includes(channel)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      channels: event.target.checked
                        ? [...current.channels, channel]
                        : current.channels.filter((item) => item !== channel),
                    }))
                  }
                />
              ))}
            </div>
          </Field>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-xs font-medium">Rule enabled</div>
              <p className="text-[11px] text-muted-foreground">Disabled rules remain configured but are not evaluated.</p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: checked }))}
              aria-label="Rule enabled"
            />
          </div>

          <InlineNote tone="info">
            Thresholds are enforced against observed data only. Drift alerts describe statistical change; they do not
            assert that model quality has degraded without labelled outcomes.
          </InlineNote>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? "Saving…" : rule ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRuleDialog({
  rule,
  onClose,
}: {
  rule: AlertRule | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api(`/alert-rules/${rule?.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Alert rule deleted.");
      void queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={Boolean(rule)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete alert rule</DialogTitle>
          <DialogDescription>
            Deleting “{rule?.name}” stops future evaluations. Existing alerts and incidents are retained.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            <Trash2 /> {mutation.isPending ? "Deleting…" : "Delete rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesPanel({ projectId }: { projectId: string }) {
  const { isAdmin } = useAuth();
  const { data, isLoading, isError, error, refetch } = useAlertRules(projectId || null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AlertRule | null>(null);
  const [deleting, setDeleting] = React.useState<AlertRule | null>(null);
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: (rule: AlertRule) =>
      api(`/alert-rules/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } }),
    onSuccess: () => {
      toast.success("Rule state updated.");
      void queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const rules = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {rules.length} rule{rules.length === 1 ? "" : "s"} · alerts are deduplicated per rule using the configured cooldown.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          disabled={!isAdmin}
          title={!isAdmin ? "Workspace administrator required" : undefined}
        >
          <Plus /> Create rule
        </Button>
      </div>

      {!isAdmin ? (
        <InlineNote tone="info">
          Only workspace administrators can create, edit, enable, or delete alert rules. You can still acknowledge and
          resolve alerts and open incidents.
        </InlineNote>
      ) : null}

      {isLoading ? <LoadingBlock label="Loading alert rules…" /> : null}
      {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && rules.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No alert rules configured"
          description="Create rules for drift, latency, error rate, invalid inputs, endpoint availability, or prediction distribution. Alerts only fire from observed data."
          action={
            isAdmin ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus /> Create the first rule
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {rules.length ? (
        <TableShell>
          <Table>
            <THead>
              <TR>
                <TH>Rule</TH>
                <TH>Metric</TH>
                <TH>Condition</TH>
                <TH>Scope</TH>
                <TH>Severity</TH>
                <TH>Channels</TH>
                <TH>Enabled</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {rules.map((rule) => (
                <TR key={rule.id}>
                  <TD>
                    <div className="text-xs font-medium">{rule.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {rule.window_minutes} min window · {rule.cooldown_minutes} min cooldown
                    </div>
                  </TD>
                  <TD className="text-xs">{typeLabel(rule.metric_type)}</TD>
                  <TD className="text-xs tabular-nums">{thresholdLabel(rule)}</TD>
                  <TD className="text-xs">{rule.project_name ?? "Workspace"}</TD>
                  <TD>
                    <SeverityBadge severity={rule.severity} />
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {(rule.channels ?? ["in_app"]).map((channel) => (
                        <Badge key={channel} tone="muted">
                          {titleCase(channel)}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD>
                    <Switch
                      checked={rule.enabled}
                      disabled={!isAdmin || toggle.isPending}
                      onCheckedChange={() => toggle.mutate(rule)}
                      aria-label={`Toggle ${rule.name}`}
                    />
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isAdmin}
                        onClick={() => {
                          setEditing(rule);
                          setDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="ghost" size="icon-sm" disabled={!isAdmin} onClick={() => setDeleting(rule)} aria-label="Delete rule">
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      ) : null}

      <RuleDialog open={dialogOpen} onOpenChange={setDialogOpen} rule={editing} />
      <DeleteRuleDialog rule={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ incidents

function OwnerSelect({
  value,
  onChange,
  members,
}: {
  value: string;
  onChange: (value: string) => void;
  members: Member[];
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Unassigned</option>
      {members.map((member) => (
        <option key={member.user_id} value={member.user_id}>
          {member.full_name} ({member.role})
        </option>
      ))}
    </Select>
  );
}

function CreateIncidentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { data: projects } = useProjectOptions();
  const { data: members } = useMembers();
  const [projectId, setProjectId] = React.useState("");
  const [deploymentId, setDeploymentId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [severity, setSeverity] = React.useState("warning");
  const [ownerId, setOwnerId] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setProjectId("");
      setDeploymentId("");
      setTitle("");
      setDescription("");
      setSeverity("warning");
      setOwnerId("");
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      api<Incident>("/incidents", {
        method: "POST",
        body: {
          project_id: projectId,
          deployment_id: deploymentId || null,
          title: title.trim(),
          description: description.trim(),
          severity,
          owner_id: ownerId || null,
        },
      }),
    onSuccess: () => {
      toast.success("Incident created.");
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts", "summary"] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open an incident</DialogTitle>
          <DialogDescription>
            Incidents are manual coordination records. They do not change deployments or model approval state.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Project" required>
            <Select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setDeploymentId("");
              }}
            >
              <option value="">Select a project…</option>
              {(projects?.items ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deployment" hint="Optional">
            <DeploymentSelect value={deploymentId} onChange={setDeploymentId} projectId={projectId || null} allowAll />
          </Field>
          <Field label="Title" required>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short, specific summary" />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="Observed impact, scope, and initial hypothesis."
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Severity">
              <Select value={severity} onChange={(event) => setSeverity(event.target.value)}>
                {SEVERITIES.map((item) => (
                  <option key={item} value={item}>
                    {titleCase(item)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner">
              <OwnerSelect value={ownerId} onChange={setOwnerId} members={members ?? []} />
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !projectId || title.trim().length < 3}
          >
            {mutation.isPending ? "Creating…" : "Create incident"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentDialog({
  incident,
  onClose,
}: {
  incident: Incident | null;
  onClose: () => void;
}) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: members } = useMembers();
  const [status, setStatus] = React.useState("open");
  const [severity, setSeverity] = React.useState("warning");
  const [ownerId, setOwnerId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [resolutionNote, setResolutionNote] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (incident) {
      setStatus(incident.status);
      setSeverity(incident.severity);
      setOwnerId(incident.owner_id ?? "");
      setNote("");
      setResolutionNote(incident.resolution_note ?? "");
      setConfirmDelete(false);
    }
  }, [incident]);

  const update = useMutation({
    mutationFn: () =>
      api<Incident>(`/incidents/${incident?.id}`, {
        method: "PATCH",
        body: {
          status,
          severity,
          owner_id: ownerId || null,
          note: note.trim() || undefined,
          resolution_note: status === "resolved" ? resolutionNote.trim() : undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Incident updated.");
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts", "summary"] });
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => api(`/incidents/${incident?.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Incident deleted.");
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts", "summary"] });
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const dirty =
    Boolean(incident) &&
    (status !== incident?.status ||
      severity !== incident?.severity ||
      ownerId !== (incident?.owner_id ?? "") ||
      Boolean(note.trim()) ||
      (status === "resolved" && resolutionNote.trim() !== (incident?.resolution_note ?? "")));

  return (
    <Dialog open={Boolean(incident)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {incident?.title ?? "Incident"}
            {incident ? <StatusBadge status={incident.status} /> : null}
            {incident ? <SeverityBadge severity={incident.severity} /> : null}
          </DialogTitle>
          <DialogDescription>
            {incident ? `${incident.project_name ?? "Project"}${incident.deployment_name ? ` · ${incident.deployment_name}` : ""} · updated ${fmtRelative(incident.updated_at)}` : null}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {incident ? (
            <>
              <div className="rounded-lg border bg-muted/20 p-3 text-sm leading-relaxed">
                {incident.description || "No description provided."}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status">
                  <Select value={status} onChange={(event) => setStatus(event.target.value)}>
                    {INCIDENT_STATUSES.map((item) => (
                      <option key={item} value={item}>
                        {titleCase(item)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Severity">
                  <Select value={severity} onChange={(event) => setSeverity(event.target.value)}>
                    {SEVERITIES.map((item) => (
                      <option key={item} value={item}>
                        {titleCase(item)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Owner" className="sm:col-span-2">
                  <OwnerSelect value={ownerId} onChange={setOwnerId} members={members ?? []} />
                </Field>
              </div>

              <Field label="Add a note" hint="Appended to the incident timeline">
                <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="What changed or what was investigated?" />
              </Field>

              {status === "resolved" ? (
                <Field label="Resolution note" hint="Required for an auditable resolution">
                  <Textarea
                    value={resolutionNote}
                    onChange={(event) => setResolutionNote(event.target.value)}
                    rows={2}
                    placeholder="What fixed the issue, and what prevents recurrence?"
                  />
                </Field>
              ) : null}

              <div className="space-y-2">
                <div className="text-xs font-medium">Timeline</div>
                {(incident.notes ?? []).length ? (
                  <ol className="space-y-2">
                    {(incident.notes ?? []).map((entry, index) => (
                      <li key={index} className="rounded-lg border bg-muted/20 p-2.5 text-xs">
                        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                          <span className="font-medium text-foreground">{entry.by}</span>
                          <span>· {fmtDate(entry.at)}</span>
                        </div>
                        <p className="mt-1">{entry.note}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">No timeline entries.</p>
                )}
              </div>

              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="font-medium">{fmtDate(incident.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Resolved</dt>
                  <dd className="font-medium">{incident.resolved_at ? fmtDate(incident.resolved_at) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Linked alert</dt>
                  <dd className="font-mono text-[11px]">{incident.alert_id ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Incident ID</dt>
                  <dd className="font-mono text-[11px]">{incident.id}</dd>
                </div>
              </dl>

              {confirmDelete ? (
                <InlineNote tone="danger">
                  <div className="space-y-2">
                    <p>Delete this incident permanently? The audit log retains the deletion event.</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                        {remove.isPending ? "Deleting…" : "Confirm delete"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                        Keep incident
                      </Button>
                    </div>
                  </div>
                </InlineNote>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="justify-between">
          <div>
            {isAdmin && incident ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
                <Trash2 className="text-destructive" /> Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => update.mutate()}
              disabled={!dirty || update.isPending || (status === "resolved" && !resolutionNote.trim())}
            >
              {update.isPending ? "Saving…" : "Save incident"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentsPanel({ projectId }: { projectId: string }) {
  const [status, setStatus] = React.useState("all");
  const [severity, setSeverity] = React.useState("");
  const [deploymentId, setDeploymentId] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<Incident | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const limit = 25;

  React.useEffect(() => {
    setOffset(0);
  }, [status, severity, deploymentId, projectId, debouncedSearch]);

  const { data, isLoading, isError, error, refetch } = useIncidents({
    status,
    severity: severity || undefined,
    project_id: projectId || undefined,
    deployment_id: deploymentId || undefined,
    q: debouncedSearch || undefined,
    limit,
    offset,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-40 text-xs" aria-label="Incident status filter">
          <option value="all">All statuses</option>
          {INCIDENT_STATUSES.map((item) => (
            <option key={item} value={item}>
              {titleCase(item)}
            </option>
          ))}
        </Select>
        <Select value={severity} onChange={(event) => setSeverity(event.target.value)} className="h-8 w-36 text-xs" aria-label="Incident severity filter">
          <option value="">All severities</option>
          {SEVERITIES.map((item) => (
            <option key={item} value={item}>
              {titleCase(item)}
            </option>
          ))}
        </Select>
        <DeploymentSelect value={deploymentId} onChange={setDeploymentId} projectId={projectId || null} allowAll />
        <SearchField value={search} onChange={setSearch} placeholder="Search incidents…" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw /> Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> Open incident
          </Button>
        </div>
      </div>

      {isLoading ? <LoadingBlock label="Loading incidents…" /> : null}
      {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && !data?.items.length ? (
        <EmptyState
          icon={Siren}
          title="No incidents in this view"
          description="Incidents can be opened manually or from an alert's remediation panel. Adjust filters to see resolved or workspace-wide incidents."
        />
      ) : null}

      {data?.items.length ? (
        <>
          <TableShell>
            <Table>
              <THead>
                <TR>
                  <TH>Severity</TH>
                  <TH>Incident</TH>
                  <TH>Project / deployment</TH>
                  <TH>Status</TH>
                  <TH>Owner</TH>
                  <TH>Timeline</TH>
                  <TH>Updated</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {data.items.map((incident) => (
                  <TR
                    key={incident.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(incident)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelected(incident);
                    }}
                  >
                    <TD>
                      <SeverityBadge severity={incident.severity} />
                    </TD>
                    <TD>
                      <div className="max-w-72 truncate text-xs font-medium">{incident.title}</div>
                      <div className="max-w-72 truncate text-[11px] text-muted-foreground">{incident.description || "No description"}</div>
                    </TD>
                    <TD className="text-xs">
                      <div>{incident.project_name ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground">{incident.deployment_name ?? "Workspace-level"}</div>
                    </TD>
                    <TD>
                      <StatusBadge status={incident.status} />
                    </TD>
                    <TD className="text-xs">{incident.owner_name ?? "Unassigned"}</TD>
                    <TD className="text-xs tabular-nums">{incident.notes?.length ?? 0}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtRelative(incident.updated_at)}</TD>
                    <TD>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
          <Pagination total={data.total} limit={limit} offset={offset} onChange={setOffset} />
        </>
      ) : null}

      <CreateIncidentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <IncidentDialog incident={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function AlertsPage() {
  const [projectId, setProjectId] = React.useState("");
  const [deploymentId, setDeploymentId] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [severity, setSeverity] = React.useState("");
  const [type, setType] = React.useState("");
  const [simulated, setSimulated] = React.useState("all");
  const [sort, setSort] = React.useState("created_at");
  const [order, setOrder] = React.useState("desc");
  const [search, setSearch] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [selectedAlertId, setSelectedAlertId] = React.useState<string | null>(null);
  const [alertDialogOpen, setAlertDialogOpen] = React.useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const limit = 25;

  const summary = useAlertSummary(30);
  const alerts = useAlerts({
    status,
    severity: severity || undefined,
    type: type || undefined,
    project_id: projectId || undefined,
    deployment_id: deploymentId || undefined,
    simulated,
    q: debouncedSearch || undefined,
    sort,
    order,
    limit,
    offset,
  });

  React.useEffect(() => {
    setOffset(0);
  }, [status, severity, type, simulated, projectId, deploymentId, sort, order, debouncedSearch]);

  React.useEffect(() => {
    setDeploymentId("");
  }, [projectId]);

  const stats = summary.data;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operate"
        title="Alerts & incidents"
        description="Threshold alerts from observed traffic and drift evidence, with auditable acknowledgement, resolution, and explicit remediation. No automatic deployment or rollback."
        actions={
          <Button variant="outline" size="sm" onClick={() => void alerts.refetch()} disabled={alerts.isFetching}>
            <RefreshCw className={alerts.isFetching ? "animate-spin" : undefined} /> Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Unacknowledged alerts"
          value={stats?.unacknowledged ?? 0}
          hint="Open alerts with no acknowledgement"
          icon={BellRing}
          tone={stats?.unacknowledged ? "warning" : "success"}
          loading={summary.isLoading}
        />
        <StatCard
          title="Open incidents"
          value={stats?.open_incidents ?? 0}
          hint="Status open or investigating"
          icon={Siren}
          tone={stats?.open_incidents ? "danger" : "success"}
          loading={summary.isLoading}
        />
        <StatCard
          title="Critical / high"
          value={(stats?.by_severity?.critical ?? 0) + (stats?.by_severity?.high ?? 0)}
          hint="Alerts in the last 30 days"
          icon={ShieldAlert}
          tone="danger"
          loading={summary.isLoading}
        />
        <StatCard
          title="Alerts in window"
          value={Object.values(stats?.by_status ?? {}).reduce((sum, value) => sum + value, 0)}
          hint="All severities · last 30 days"
          icon={AlertTriangle}
          tone="info"
          loading={summary.isLoading}
        />
      </div>

      <Tabs defaultValue="alerts">
        <TabsList>
          <TabsTrigger value="alerts">
            <BellRing className="size-3.5" /> Alerts
          </TabsTrigger>
          <TabsTrigger value="incidents">
            <Siren className="size-3.5" /> Incidents
          </TabsTrigger>
          <TabsTrigger value="rules">
            <ShieldAlert className="size-3.5" /> Rules
          </TabsTrigger>
        </TabsList>

        <TabsContent value="alerts" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectSelect value={projectId} onChange={setProjectId} allowAll />
            <DeploymentSelect value={deploymentId} onChange={setDeploymentId} projectId={projectId || null} allowAll />
            <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-36 text-xs" aria-label="Alert status filter">
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </Select>
            <Select value={severity} onChange={(event) => setSeverity(event.target.value)} className="h-8 w-36 text-xs" aria-label="Alert severity filter">
              <option value="">All severities</option>
              {SEVERITIES.map((item) => (
                <option key={item} value={item}>
                  {titleCase(item)}
                </option>
              ))}
            </Select>
            <Select value={type} onChange={(event) => setType(event.target.value)} className="h-8 w-52 text-xs" aria-label="Alert type filter">
              <option value="">All alert types</option>
              {ALERT_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
            <Select value={simulated} onChange={(event) => setSimulated(event.target.value)} className="h-8 w-36 text-xs" aria-label="Simulated filter">
              <option value="all">All data</option>
              <option value="false">Production only</option>
              <option value="true">Simulated only</option>
            </Select>
            <SearchField value={search} onChange={setSearch} placeholder="Search alerts…" />
            <Select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 w-32 text-xs" aria-label="Sort alerts">
              <option value="created_at">Newest</option>
              <option value="severity">Severity</option>
            </Select>
            <Button variant="outline" size="icon-sm" onClick={() => setOrder(order === "desc" ? "asc" : "desc")} aria-label="Toggle sort direction">
              <RefreshCw className={order === "asc" ? "rotate-180" : undefined} />
            </Button>
          </div>

          {alerts.isLoading ? <LoadingBlock label="Loading alerts…" /> : null}
          {alerts.isError ? <ErrorState message={errorMessage(alerts.error)} onRetry={() => void alerts.refetch()} /> : null}
          {!alerts.isLoading && !alerts.isError && !alerts.data?.items.length ? (
            <EmptyState
              icon={BellRing}
              title="No alerts match this view"
              description="Alerts are created by enabled rules when observed drift, traffic, latency, errors, invalid inputs, availability, or prediction distribution cross their thresholds."
              action={
                <Button variant="outline" size="sm" onClick={() => setStatus("all")}>
                  Clear status filter
                </Button>
              }
            />
          ) : null}

          {alerts.data?.items.length ? (
            <>
              <TableShell>
                <Table>
                  <THead>
                    <TR>
                      <TH>Severity</TH>
                      <TH>Alert</TH>
                      <TH>Type</TH>
                      <TH>Target</TH>
                      <TH>Status</TH>
                      <TH>Created</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {alerts.data.items.map((alert: Alert) => (
                      <TR
                        key={alert.id}
                        className="cursor-pointer"
                        tabIndex={0}
                        onClick={() => {
                          setSelectedAlertId(alert.id);
                          setAlertDialogOpen(true);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            setSelectedAlertId(alert.id);
                            setAlertDialogOpen(true);
                          }
                        }}
                      >
                        <TD>
                          <SeverityBadge severity={alert.severity} />
                        </TD>
                        <TD>
                          <div className="flex max-w-80 items-center gap-1.5">
                            <span className="truncate text-xs font-medium">{alert.title}</span>
                            <SimulatedBadge simulated={alert.simulated} />
                          </div>
                          <div className="max-w-80 truncate text-[11px] text-muted-foreground">{alert.message}</div>
                        </TD>
                        <TD className="text-xs">{typeLabel(alert.type)}</TD>
                        <TD className="text-xs">
                          <div>{alert.project_name ?? "Workspace"}</div>
                          <div className="text-[11px] text-muted-foreground">{alert.deployment_name ?? "No deployment"}</div>
                        </TD>
                        <TD>
                          <StatusBadge status={alert.status} />
                        </TD>
                        <TD className="whitespace-nowrap text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="size-3" /> {fmtRelative(alert.created_at)}
                          </div>
                          <div className="text-[11px]">{fmtDate(alert.created_at)}</div>
                        </TD>
                        <TD>
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableShell>
              <Pagination total={alerts.data.total} limit={limit} offset={offset} onChange={setOffset} />
            </>
          ) : null}

          {summary.isError ? (
            <InlineNote tone="warning">Alert summary could not be loaded: {errorMessage(summary.error)}</InlineNote>
          ) : null}
        </TabsContent>

        <TabsContent value="incidents">
          <IncidentsPanel projectId={projectId} />
        </TabsContent>

        <TabsContent value="rules">
          <RulesPanel projectId={projectId} />
        </TabsContent>
      </Tabs>

      <AlertDetailDialog
        alertId={selectedAlertId}
        open={alertDialogOpen}
        onOpenChange={(open) => {
          setAlertDialogOpen(open);
          if (!open) setSelectedAlertId(null);
        }}
      />
    </div>
  );
}
