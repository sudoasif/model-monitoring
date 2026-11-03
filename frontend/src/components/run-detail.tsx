"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, GitCommitHorizontal, Layers, Timer } from "lucide-react";

import { DetailRow, SectionCard, StatusBadge } from "@/components/common";
import { Badge, CodeBlock, EmptyState, ErrorState, LoadingBlock, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRun, useRunArtifacts } from "@/lib/hooks";
import type { Metrics, TrainingRun } from "@/lib/types";
import {
  errorMessage,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtMetric,
  fmtNumber,
  metricLabel,
  metricOrder,
  primaryMetricName,
  titleCase,
} from "@/lib/utils";

function numericMetrics(metrics: Metrics | null | undefined): Array<[string, number]> {
  if (!metrics) return [];
  return Object.entries(metrics)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .filter(([key]) => !key.startsWith("train_"));
}

export function RunDetailDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: run, isLoading, error, refetch } = useRun(open ? runId : null);
  const { data: artifacts } = useRunArtifacts(open ? runId : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{run?.name ?? "Training run"}</DialogTitle>
          <DialogDescription>
            Real MLflow-tracked run with validation metrics, lineage and downloadable artifacts.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isLoading ? <LoadingBlock label="Loading run…" /> : null}
          {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
          {run ? <RunDetailContent run={run} artifacts={artifacts} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function RunDetailContent({
  run,
  artifacts,
}: {
  run: TrainingRun;
  artifacts?: ReturnType<typeof useRunArtifacts>["data"];
}) {
  const orderedMetrics = React.useMemo(() => {
    const values = numericMetrics(run.metrics);
    const preferred = metricOrder(run.params?.task_type as string | undefined);
    return values.sort((a, b) => {
      const ai = preferred.indexOf(a[0]);
      const bi = preferred.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [run.metrics, run.params]);
  const perClass = (run.metrics?.per_class ?? null) as Record<string, { support?: number; precision?: number; recall?: number }> | null;
  const confusion = Array.isArray(run.metrics?.confusion_matrix) ? (run.metrics.confusion_matrix as number[][]) : null;
  const classLabels = Array.isArray(run.metrics?.class_labels) ? (run.metrics.class_labels as unknown as string[]) : [];
  const primary = primaryMetricName((run.params?.task_type as string | undefined) ?? (run.metrics?.roc_auc !== undefined ? "classification" : "regression"));
  const trainValue = typeof run.train_metrics?.[primary] === "number" ? Number(run.train_metrics[primary]) : null;
  const validationValue = typeof run.metrics?.[primary] === "number" ? Number(run.metrics[primary]) : null;
  const gap = trainValue !== null && validationValue !== null ? Math.abs(trainValue - validationValue) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} />
        <Badge tone="muted">{titleCase(run.algorithm)}</Badge>
        <Badge tone="info">{run.experiment_name || "Default"}</Badge>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          <Timer className="size-3" /> {fmtDuration(run.duration_seconds)}
        </span>
      </div>

      {run.message ? (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-relaxed">{run.message}</div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {orderedMetrics.slice(0, 8).map(([key, value]) => (
          <div key={key} className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{metricLabel(key)}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{fmtMetric(value, key === "sample_count" ? 0 : 4)}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Validation vs training" description="The held-out test set is never used for tuning or selection." contentClassName="pt-2">
          <dl>
            <DetailRow label="Held-out samples">{fmtNumber(run.metrics?.sample_count as number | undefined)}</DetailRow>
            <DetailRow label="Primary metric">{metricLabel(primary)}</DetailRow>
            <DetailRow label="Validation">{fmtMetric(validationValue, 4)}</DetailRow>
            <DetailRow label="Training">{fmtMetric(trainValue, 4)}</DetailRow>
            <DetailRow label="Generalization gap">{gap === null ? "—" : fmtMetric(gap, 4)}</DetailRow>
            <DetailRow label="Git commit">
              <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                <GitCommitHorizontal className="size-3" /> {run.git_commit || "unversioned"}
              </span>
            </DetailRow>
            <DetailRow label="Started">{fmtDate(run.started_at)}</DetailRow>
            <DetailRow label="Finished">{fmtDate(run.finished_at)}</DetailRow>
          </dl>
        </SectionCard>

        <SectionCard title="Lineage" description="Dataset, model version and MLflow references." contentClassName="pt-2">
          <dl>
            <DetailRow label="Project">
              <Link href={`/projects/${run.project_id}`} className="text-primary hover:underline">
                {run.project_name}
              </Link>
            </DetailRow>
            <DetailRow label="Dataset">
              {run.dataset_name ? `${run.dataset_name} · v${run.dataset_version}` : "—"}
            </DetailRow>
            <DetailRow label="Registered model">
              {run.registered_model_id ? (
                <Link href={`/registry?project=${run.project_id}&model=${run.registered_model_id}`} className="text-primary hover:underline">
                  {run.model_version_number ? `Version ${run.model_version_number}` : "Registered model"}
                </Link>
              ) : (
                "Not registered"
              )}
            </DetailRow>
            <DetailRow label="MLflow run">
              <span className="font-mono text-[11px]">{run.mlflow_run_id || "not tracked"}</span>
            </DetailRow>
            <DetailRow label="MLflow UI">
              {artifacts?.run_link ? (
                <a href={artifacts.run_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Open run <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">Link unavailable</span>
              )}
            </DetailRow>
          </dl>
          {run.params ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">Hyperparameters & configuration</summary>
              <CodeBlock className="mt-2">{JSON.stringify(run.params, null, 2)}</CodeBlock>
            </details>
          ) : null}
        </SectionCard>
      </div>

      {confusion ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Confusion matrix" description="Rows are actual classes; columns are predicted classes.">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Actual \\ Predicted</TH>
                    {confusion[0]?.map((_, index) => (
                      <TH key={index}>{String(classLabels[index] ?? index)}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {confusion.map((row, rowIndex) => (
                    <TR key={rowIndex}>
                      <TD className="font-medium">{String(classLabels[rowIndex] ?? rowIndex)}</TD>
                      {row.map((cell, cellIndex) => (
                        <TD key={cellIndex} className="tabular-nums">
                          {fmtNumber(cell)}
                        </TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </SectionCard>
          <SectionCard title="Per-class metrics" description="Precision and recall on the untouched held-out test set.">
            {perClass ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Class</TH>
                    <TH>Support</TH>
                    <TH>Precision</TH>
                    <TH>Recall</TH>
                  </TR>
                </THead>
                <TBody>
                  {Object.entries(perClass).map(([label, values]) => (
                    <TR key={label}>
                      <TD className="font-medium">{label}</TD>
                      <TD>{fmtNumber(values.support)}</TD>
                      <TD>{fmtMetric(values.precision, 3)}</TD>
                      <TD>{fmtMetric(values.recall, 3)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-xs text-muted-foreground">Per-class metrics are not available for this task.</p>
            )}
          </SectionCard>
        </div>
      ) : null}

      {Array.isArray(run.candidate_results) && run.candidate_results.length ? (
        <SectionCard title="Candidate comparison" description="Selection used validation folds; final metrics above are from the held-out test set.">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Algorithm</TH>
                  <TH>Tuned</TH>
                  <TH>Selection metric</TH>
                  <TH>Selection score</TH>
                  <TH>Duration</TH>
                </TR>
              </THead>
              <TBody>
                {run.candidate_results.map((candidate, index) => (
                  <TR key={`${String(candidate.algorithm)}-${index}`}>
                    <TD className="font-medium">{String(candidate.label ?? candidate.algorithm)}</TD>
                    <TD>{candidate.tuned ? "Yes" : "No"}</TD>
                    <TD>{metricLabel(String(candidate.selection_metric ?? ""))}</TD>
                    <TD className="tabular-nums">{fmtMetric(Number(candidate.selection_score), 4)}</TD>
                    <TD>{fmtDuration(Number(candidate.duration_seconds))}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Artifacts" description="Files logged to MLflow for this run.">
        {artifacts?.warning ? <p className="mb-2 text-xs text-warning">{artifacts.warning}</p> : null}
        {artifacts?.artifacts?.length ? (
          <div className="divide-y rounded-lg border">
            {artifacts.artifacts.map((artifact) => (
              <div key={artifact.path} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Layers className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-[11px]">{artifact.path}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {artifact.is_dir ? "directory" : fmtBytes(artifact.file_size ?? null)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No artifacts listed" description={artifacts?.warning ?? "MLflow did not return artifacts for this run."} />
        )}
      </SectionCard>
    </div>
  );
}
