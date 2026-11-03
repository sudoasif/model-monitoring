"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  FlaskConical,
  KeyRound,
  Pause,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { CopyButton, SectionCard, StatusBadge } from "@/components/common";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Switch,
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
import { useAuth } from "@/components/providers";
import { api, qs } from "@/lib/api";
import { useDatasets, useDemoStatus, useModelVersions } from "@/lib/hooks";
import type { Deployment, DeploymentCreatedResult, PipelineJob } from "@/lib/types";
import { errorMessage, fmtDate, fmtNumber } from "@/lib/utils";

export function DeploymentSettingsPanel({ deployment }: { deployment: Deployment }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const { data: datasets } = useDatasets(deployment.project_id);
  const { data: versions } = useModelVersions(deployment.model_id);
  const { data: demo } = useDemoStatus();

  const [name, setName] = React.useState(deployment.name);
  const [description, setDescription] = React.useState(deployment.description ?? "");
  const [referenceId, setReferenceId] = React.useState(String(deployment.config.reference_dataset_version_id ?? ""));
  const [minLabels, setMinLabels] = React.useState(Number(deployment.config.min_label_samples ?? 30));
  const [captureSamples, setCaptureSamples] = React.useState(deployment.config.capture_samples !== false);

  const [rotatedKey, setRotatedKey] = React.useState<string | null>(null);
  const [rollbackId, setRollbackId] = React.useState("");
  const [simulationJob, setSimulationJob] = React.useState<PipelineJob | null>(null);
  const [simCount, setSimCount] = React.useState(50);
  const [simShift, setSimShift] = React.useState(true);
  const [simLabels, setSimLabels] = React.useState(true);
  const [simFraction, setSimFraction] = React.useState(0.8);
  const [simInterval, setSimInterval] = React.useState(0);

  React.useEffect(() => {
    setName(deployment.name);
    setDescription(deployment.description ?? "");
    setReferenceId(String(deployment.config.reference_dataset_version_id ?? ""));
    setMinLabels(Number(deployment.config.min_label_samples ?? 30));
    setCaptureSamples(deployment.config.capture_samples !== false);
  }, [deployment]);

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["deployment", deployment.id] });
    void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    void queryClient.invalidateQueries({ queryKey: ["deployment-monitoring", deployment.id] });
    void queryClient.invalidateQueries({ queryKey: ["predictions", deployment.id] });
    void queryClient.invalidateQueries({ queryKey: ["retraining-status", deployment.id] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  }, [deployment.id, queryClient]);

  const versionsFlat = React.useMemo(
    () => (datasets ?? []).flatMap((dataset) => dataset.versions.map((version) => ({ ...version, datasetName: dataset.name }))),
    [datasets],
  );
  const approvedVersions = React.useMemo(
    () => (versions ?? []).filter((version) => version.approval_status === "approved" && version.id !== deployment.model_version_id),
    [deployment.model_version_id, versions],
  );

  const save = useMutation({
    mutationFn: () =>
      api<Deployment>(`/deployments/${deployment.id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          description: description.trim(),
          reference_dataset_version_id: referenceId || null,
          min_label_samples: Number(minLabels) || 30,
          capture_samples: captureSamples,
        },
      }),
    onSuccess: () => {
      toast.success("Deployment settings saved.");
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const setStatus = useMutation({
    mutationFn: (status: "active" | "paused") =>
      api<Deployment>(`/deployments/${deployment.id}/status${qs({ status })}`, { method: "POST" }),
    onSuccess: (payload) => {
      toast.success(payload.status === "active" ? "Deployment activated." : "Deployment paused.");
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const rotate = useMutation({
    mutationFn: () => api<DeploymentCreatedResult>(`/deployments/${deployment.id}/rotate-key`, { method: "POST" }),
    onSuccess: (payload) => {
      setRotatedKey(payload.api_key);
      toast.success("API key rotated. The previous key is now invalid.");
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const rollback = useMutation({
    mutationFn: () =>
      api<Deployment>(`/deployments/${deployment.id}/rollback${qs({ target_version_id: rollbackId })}`, { method: "POST" }),
    onSuccess: (payload) => {
      toast.success(`Rolled back to v${payload.model_version}. The change is recorded in the audit log.`);
      setRollbackId("");
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const simulate = useMutation({
    mutationFn: () =>
      api<PipelineJob>("/demo/simulate", {
        method: "POST",
        body: {
          deployment_id: deployment.id,
          count: Number(simCount) || 1,
          shift: simShift,
          provide_labels: simLabels,
          label_fraction: Number(simFraction),
          interval_ms: Number(simInterval) || 0,
        },
      }),
    onSuccess: (job) => {
      setSimulationJob(job);
      toast.success("Simulated traffic job queued. Events will be explicitly marked simulated.");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!isAdmin) {
    return (
      <SectionCard title="Administrator access required" description="Deployment lifecycle, keys, rollback, and simulation are restricted.">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your workspace role does not permit deployment changes. You can still view monitoring, explainability, and prediction history.
          Ask a workspace owner or administrator for access.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Endpoint settings"
          description="Reference data and label thresholds apply to future drift and performance evaluations."
          actions={
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || name.trim().length < 2}>
              <Save /> {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="Name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
            </Field>
            <Field label="Description" hint={`${description.length}/2000`}>
              <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
            </Field>
            <Field label="Reference dataset version" hint="Drift baseline">
              <Select value={referenceId} onChange={(event) => setReferenceId(event.target.value)}>
                <option value="">Not set</option>
                {versionsFlat.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.datasetName} v{version.version} · {fmtNumber(version.row_count)} rows
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Minimum labels" hint="5–100,000">
                <Input type="number" min={5} max={100000} value={minLabels} onChange={(event) => setMinLabels(Number(event.target.value))} />
              </Field>
              <div className="flex items-end justify-between gap-3 rounded-lg border p-3">
                <div>
                  <div className="text-xs font-medium">Capture feature samples</div>
                  <p className="text-[10px] text-muted-foreground">Required for drift and retraining</p>
                </div>
                <Switch checked={captureSamples} onCheckedChange={setCaptureSamples} aria-label="Capture feature samples" />
              </div>
            </div>
          </div>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Lifecycle" description="Paused deployments reject predictions but keep history.">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={deployment.status} />
              <span className="text-[11px] text-muted-foreground">
                {deployment.status === "active" ? "Accepting authenticated requests." : "Requests are rejected until activated."}
              </span>
              <div className="ml-auto flex gap-2">
                {deployment.status === "active" ? (
                  <Button variant="outline" size="sm" onClick={() => setStatus.mutate("paused")} disabled={setStatus.isPending}>
                    <Pause /> Pause
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setStatus.mutate("active")} disabled={setStatus.isPending}>
                    <Play /> Activate
                  </Button>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="API key"
            description="Only a hash and prefix are stored. Rotation invalidates the previous key immediately."
            actions={
              <Button variant="outline" size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                <KeyRound /> {rotate.isPending ? "Rotating…" : "Rotate key"}
              </Button>
            }
          >
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Current prefix</span>
                <span className="font-mono">{deployment.api_key_prefix ?? "—"}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Rotating is audited. Existing consumers will fail authentication until they receive the new key.
              </p>
            </div>
          </SectionCard>

          <SectionCard title="Rollback" description="Only approved versions can be targeted. Rollback never happens automatically.">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Serving</span>
                <span className="font-medium">{deployment.model_name} v{deployment.model_version}</span>
              </div>
              <Field label="Target approved version">
                <Select value={rollbackId} onChange={(event) => setRollbackId(event.target.value)}>
                  <option value="">Select a version…</option>
                  {approvedVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version} · approved {fmtDate(version.approved_at, false)} · {version.stage}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="outline" size="sm" onClick={() => rollback.mutate()} disabled={!rollbackId || rollback.isPending}>
                <RotateCcw /> {rollback.isPending ? "Rolling back…" : "Roll back explicitly"}
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>

      <SectionCard
        title="Simulated traffic"
        description="Demo traffic only runs when you explicitly start it. Simulated events are marked and filterable everywhere."
        actions={demo?.demo_mode ? <Badge tone="warning"><FlaskConical /> Demo mode</Badge> : <Badge tone="muted">Demo mode disabled</Badge>}
      >
        {demo?.demo_mode ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Field label="Requests" hint="1–2000">
                <Input type="number" min={1} max={2000} value={simCount} onChange={(event) => setSimCount(Number(event.target.value))} />
              </Field>
              <Field label="Label fraction" hint="0–1">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step="0.05"
                  value={simFraction}
                  onChange={(event) => setSimFraction(Number(event.target.value))}
                  disabled={!simLabels}
                />
              </Field>
              <Field label="Interval (ms)" hint="≤ 5000; total ≤ 10 min">
                <Input type="number" min={0} max={5000} value={simInterval} onChange={(event) => setSimInterval(Number(event.target.value))} />
              </Field>
              <div className="flex flex-col justify-end gap-2">
                <Checkbox checked={simShift} onChange={(event) => setSimShift(event.target.checked)} label="Apply distribution shift" />
                <Checkbox checked={simLabels} onChange={(event) => setSimLabels(event.target.checked)} label="Provide ground-truth labels" />
              </div>
              <div className="flex items-end">
                <Button onClick={() => simulate.mutate()} disabled={simulate.isPending || deployment.status !== "active"}>
                  <Sparkles /> {simulate.isPending ? "Queueing…" : "Start simulation"}
                </Button>
              </div>
            </div>
            {deployment.status !== "active" ? (
              <p className="text-xs text-destructive">Activate the deployment before generating traffic.</p>
            ) : null}
            {simulationJob ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
                <StatusBadge status={simulationJob.status} />
                <span className="font-mono text-[10px] text-muted-foreground">{simulationJob.id}</span>
                <span className="text-muted-foreground">{simulationJob.stage}</span>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/pipelines?job=${simulationJob.id}`}>
                    Open job <ArrowRight />
                  </Link>
                </Button>
              </div>
            ) : null}
            <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-[11px] leading-relaxed">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                Simulated traffic produces real model executions and real alerts when thresholds are breached, but every event and alert is
                tagged simulated. It never counts as production evidence.
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Set <span className="font-mono">DEMO_MODE=true</span> in the backend environment to enable explicit synthetic traffic. No traffic
            is generated automatically in any mode.
          </p>
        )}
      </SectionCard>

      <Dialog open={Boolean(rotatedKey)} onOpenChange={(open) => !open && setRotatedKey(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>This key is shown once. Store it before closing this dialog.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={rotatedKey ?? ""} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
              <CopyButton value={rotatedKey ?? ""} label="Copy key" />
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-[11px] leading-relaxed">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>The previous key was invalidated. Update all consumers and secret stores now.</span>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setRotatedKey(null)}>I have stored the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
