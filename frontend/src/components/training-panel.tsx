"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, CheckCircle2, Clock, Play, ShieldCheck, Workflow } from "lucide-react";
import { toast } from "sonner";

import { SectionCard, StatusBadge } from "@/components/common";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Progress,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAlgorithms, useDatasets, useJob, useRuns } from "@/lib/hooks";
import type { PipelineJob, TaskType, TrainingRun } from "@/lib/types";
import { errorMessage, fmtDate, fmtMetric, fmtRelative, primaryMetricName, titleCase } from "@/lib/utils";

export function TrainingPanel({ projectId, taskType }: { projectId: string; taskType: TaskType }) {
  const queryClient = useQueryClient();
  const { data: datasets, isLoading: datasetsLoading } = useDatasets(projectId);
  const { data: catalog, isLoading: catalogLoading } = useAlgorithms(projectId);
  const { data: runs } = useRuns({ project_id: projectId, limit: 5 });
  const [datasetVersionId, setDatasetVersionId] = React.useState("");
  const [algorithms, setAlgorithms] = React.useState<string[]>([]);
  const [tune, setTune] = React.useState(false);
  const [nTrials, setNTrials] = React.useState(10);
  const [testSize, setTestSize] = React.useState(0.2);
  const [randomState, setRandomState] = React.useState(42);
  const [modelName, setModelName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const initialized = React.useRef(false);

  const versions = React.useMemo(
    () =>
      (datasets ?? []).flatMap((dataset) =>
        dataset.versions.map((version) => ({
          ...version,
          label: `${dataset.name} · v${version.version} · ${version.row_count} rows`,
        })),
      ),
    [datasets],
  );

  React.useEffect(() => {
    if (!datasetVersionId && versions.length) {
      const reference = versions.find((version) => version.is_reference) ?? versions[0];
      setDatasetVersionId(reference.id);
    }
  }, [datasetVersionId, versions]);

  React.useEffect(() => {
    if (!initialized.current && catalog?.algorithms?.length) {
      setAlgorithms(catalog.algorithms.map((algorithm) => algorithm.key));
      initialized.current = true;
    }
  }, [catalog]);

  const { data: job } = useJob(jobId);
  const lastStatus = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!job) return;
    if (job.status === "succeeded" && lastStatus.current !== "succeeded") {
      toast.success("Training completed. Review the run and approve the registered version.");
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["models", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    }
    if (job.status === "failed" && lastStatus.current !== "failed") {
      toast.error(job.error || "Training failed. Open Pipelines for logs.");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
    lastStatus.current = job.status;
  }, [job, projectId, queryClient]);

  const mutation = useMutation({
    mutationFn: () =>
      api<PipelineJob>(`/projects/${projectId}/train`, {
        method: "POST",
        body: {
          dataset_version_id: datasetVersionId,
          algorithms,
          tune,
          n_trials: nTrials,
          test_size: testSize,
          random_state: randomState,
          model_name: modelName.trim() || null,
          notes: notes.trim(),
        },
      }),
    onSuccess: (created) => {
      toast.success("Training job queued. Metrics will appear when the real pipeline finishes.");
      setJobId(created.id);
      lastStatus.current = "queued";
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs", "summary"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const selectedAlgorithmLabels = (catalog?.algorithms ?? [])
    .filter((algorithm) => algorithms.includes(algorithm.key))
    .map((algorithm) => algorithm.label);

  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <SectionCard
        title="Train a model"
        description="Real scikit-learn / XGBoost training with leakage prevention, optional Optuna tuning and an untouched held-out test split."
        className="xl:col-span-3"
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Dataset version" required htmlFor="train-dataset">
            {datasetsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : versions.length ? (
              <Select id="train-dataset" value={datasetVersionId} onChange={(event) => setDatasetVersionId(event.target.value)} required>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                    {version.is_reference ? " · reference" : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground">Upload or create a dataset first.</p>
            )}
          </Field>

          <Field label="Algorithms" hint={`${algorithms.length} selected`}>
            {catalogLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(catalog?.algorithms ?? []).map((algorithm) => (
                  <label key={algorithm.key} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 accent-[var(--primary)]"
                      checked={algorithms.includes(algorithm.key)}
                      onChange={(event) => {
                        setAlgorithms((current) =>
                          event.target.checked
                            ? [...current, algorithm.key]
                            : current.filter((item) => item !== algorithm.key),
                        );
                      }}
                    />
                    <span>
                      <span className="block font-medium">{algorithm.label}</span>
                      <span className="block text-[10px] text-muted-foreground">{algorithm.family}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Test size" htmlFor="train-test-size" hint="Held out">
              <Input
                id="train-test-size"
                type="number"
                min={0.1}
                max={0.4}
                step={0.05}
                value={testSize}
                onChange={(event) => setTestSize(Number(event.target.value))}
              />
            </Field>
            <Field label="Random state" htmlFor="train-random-state">
              <Input
                id="train-random-state"
                type="number"
                min={0}
                value={randomState}
                onChange={(event) => setRandomState(Number(event.target.value))}
              />
            </Field>
            <Field label="Model name" htmlFor="train-model-name" hint="Optional">
              <Input
                id="train-model-name"
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
                maxLength={180}
                placeholder={`${titleCase(taskType)} model`}
              />
            </Field>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium">Optuna hyperparameter tuning</p>
                <p className="text-[10px] text-muted-foreground">Tuning uses validation folds only; the test set is never touched.</p>
              </div>
              <Switch checked={tune} onCheckedChange={setTune} aria-label="Enable hyperparameter tuning" />
            </div>
            {tune ? (
              <Field label="Trials per algorithm" htmlFor="train-trials" className="max-w-40">
                <Input
                  id="train-trials"
                  type="number"
                  min={1}
                  max={50}
                  value={nTrials}
                  onChange={(event) => setNTrials(Number(event.target.value))}
                />
              </Field>
            ) : null}
          </div>

          <Field label="Notes" htmlFor="train-notes">
            <Textarea
              id="train-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Why are you running this experiment?"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={mutation.isPending || !datasetVersionId || algorithms.length === 0}>
              <Play /> {mutation.isPending ? "Queueing…" : "Start training"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {selectedAlgorithmLabels.length ? selectedAlgorithmLabels.join(", ") : "Select at least one algorithm"}
            </span>
          </div>
        </form>
      </SectionCard>

      <div className="space-y-4 xl:col-span-2">
        <SectionCard title="Pipeline safety" description="What this run does and does not do.">
          <ul className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
              Identifier-like and PII-like columns are excluded; the target is removed from features before preprocessing.
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              Preprocessing is fitted inside the training pipeline, preventing validation/test leakage.
            </li>
            <li className="flex gap-2">
              <Clock className="mt-0.5 size-3.5 shrink-0 text-warning" />
              The final held-out test split is used once for reporting, never for algorithm selection.
            </li>
            <li className="flex gap-2">
              <BrainCircuit className="mt-0.5 size-3.5 shrink-0 text-primary" />
              A registered version starts as <strong>pending approval</strong>. A training score alone never deploys it.
            </li>
          </ul>
        </SectionCard>

        {job ? (
          <SectionCard
            title="Active job"
            description={`${titleCase(job.job_type)} · ${job.stage}`}
            actions={<StatusBadge status={job.status} />}
          >
            <div className="space-y-2">
              <Progress value={job.progress} tone={job.status === "failed" ? "danger" : job.status === "succeeded" ? "success" : "primary"} />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{job.progress}% · attempt {job.attempts}/{job.max_attempts}</span>
                <span>{fmtRelative(job.created_at)}</span>
              </div>
              {job.error ? <p className="rounded-md bg-destructive/5 px-2 py-1 text-[11px] text-destructive">{job.error}</p> : null}
              <Button variant="outline" size="sm" asChild>
                <Link href={`/pipelines?job=${job.id}`}>
                  <Workflow /> Open job logs
                </Link>
              </Button>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title="Recent runs" description="Latest experiments for this project.">
          {runs?.items.length ? (
            <div className="space-y-2">
              {runs.items.map((run: TrainingRun) => {
                const primary = primaryMetricName(taskType);
                const value = typeof run.metrics?.[primary] === "number" ? Number(run.metrics[primary]) : null;
                return (
                  <Link
                    key={run.id}
                    href={`/experiments?run=${run.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs hover:bg-muted/30"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{run.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {titleCase(run.algorithm)} · {fmtDate(run.created_at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block tabular-nums">{fmtMetric(value, 4)}</span>
                      <StatusBadge status={run.status} />
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No runs yet" description="Start the first training job using the form." />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
