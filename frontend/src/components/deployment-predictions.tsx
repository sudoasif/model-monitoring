"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, SearchX, Tag } from "lucide-react";
import { toast } from "sonner";

import { SearchField, SectionCard, SimulatedBadge, StatusBadge } from "@/components/common";
import { PerformanceSection } from "@/components/performance-section";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Pagination,
  Select,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
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
import { useDebouncedValue, usePredictionSchema, usePredictions } from "@/lib/hooks";
import type { Deployment, LabelSubmissionResult, PredictionRow } from "@/lib/types";
import { errorMessage, fmtDate, fmtMs, fmtNumber, fmtPercent } from "@/lib/utils";

function LabelDialog({
  deployment,
  row,
  open,
  onOpenChange,
}: {
  deployment: Deployment;
  row: PredictionRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: schema } = usePredictionSchema(deployment.id);
  const [label, setLabel] = React.useState("");
  const classLabels = schema?.schema.class_labels ?? [];
  const taskType = schema?.schema.task_type ?? "classification";

  React.useEffect(() => {
    if (open) setLabel("");
  }, [open, row?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      api<LabelSubmissionResult>("/labels", {
        method: "POST",
        body: {
          deployment_id: deployment.id,
          source: "api",
          labels: [{ prediction_id: row?.id, label, simulated: false }],
        },
      }),
    onSuccess: (result) => {
      if (result.created) {
        toast.success("Ground-truth label recorded. Performance was re-evaluated.");
        void queryClient.invalidateQueries({ queryKey: ["predictions", deployment.id] });
        void queryClient.invalidateQueries({ queryKey: ["performance", deployment.id] });
        void queryClient.invalidateQueries({ queryKey: ["label-status", deployment.id] });
        void queryClient.invalidateQueries({ queryKey: ["performance-trend", deployment.id] });
        void queryClient.invalidateQueries({ queryKey: ["performance-reports", deployment.id] });
        void queryClient.invalidateQueries({ queryKey: ["deployment-monitoring", deployment.id] });
        onOpenChange(false);
      } else {
        toast.error(result.errors[0]?.error ?? "The label could not be recorded.");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Submit ground-truth label</DialogTitle>
          <DialogDescription>
            Labels are append-only. Corrections are not applied automatically, and simulated labels are tracked separately.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {row ? (
            <div className="rounded-lg border bg-muted/20 p-3 text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Prediction</span>
                <span className="font-medium">{row.prediction ?? "—"}</span>
              </div>
              <div className="mt-1 flex justify-between gap-3">
                <span className="text-muted-foreground">Request</span>
                <span className="font-mono text-[10px]">{row.request_id}</span>
              </div>
              <div className="mt-1 flex justify-between gap-3">
                <span className="text-muted-foreground">Scored at</span>
                <span>{fmtDate(row.timestamp)}</span>
              </div>
            </div>
          ) : null}
          <Field label="True label" required hint={taskType === "classification" ? "Must match the model class schema" : "Finite number"}>
            {taskType === "classification" && classLabels.length ? (
              <Select value={label} onChange={(event) => setLabel(event.target.value)}>
                <option value="">Select a class…</option>
                {classLabels.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                type={taskType === "regression" ? "number" : "text"}
                step="any"
                placeholder={taskType === "regression" ? "e.g. 425000" : "True label"}
              />
            )}
          </Field>
          {taskType === "classification" && !classLabels.length ? (
            <p className="text-xs text-destructive">
              No class schema was recorded for this model, so labels cannot be validated. This is an explicit error rather than a
              guessed label.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!row || !label.trim() || mutation.isPending}
          >
            <Tag /> {mutation.isPending ? "Submitting…" : "Submit label"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeploymentPredictionsPanel({ deployment }: { deployment: Deployment }) {
  const [status, setStatus] = React.useState("");
  const [simulated, setSimulated] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search);
  const [offset, setOffset] = React.useState(0);
  const [labelRow, setLabelRow] = React.useState<PredictionRow | null>(null);
  const limit = 25;

  const { data, isLoading, error, refetch } = usePredictions(deployment.id, {
    status: status || undefined,
    simulated,
    q: debounced || undefined,
    limit,
    offset,
  });
  const items = data?.items ?? [];
  const successCount = items.filter((row) => row.status === "success").length;
  const errorCount = items.filter((row) => row.status === "error").length;
  const labelledCount = items.filter((row) => row.ground_truth !== null).length;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Prediction events"
        description="Raw inputs are not stored by default. Request IDs, latency, status, prediction, confidence, and labels are shown."
        contentClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="Search request, prediction, error…" />
          <Select
            value={status}
            onChange={(event) => { setStatus(event.target.value); setOffset(0); }}
            className="h-8 max-w-36 text-xs"
            aria-label="Prediction status"
          >
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </Select>
          <Select
            value={simulated}
            onChange={(event) => { setSimulated(event.target.value); setOffset(0); }}
            className="h-8 max-w-40 text-xs"
            aria-label="Traffic source"
          >
            <option value="all">All traffic</option>
            <option value="production">Production only</option>
            <option value="simulated">Simulated only</option>
          </Select>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <Badge tone="muted">{fmtNumber(successCount)} success</Badge>
            <Badge tone={errorCount ? "danger" : "muted"}>{fmtNumber(errorCount)} errors</Badge>
            <Badge tone="muted">{fmtNumber(labelledCount)} labelled</Badge>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No prediction events"
            description="Send a request from the Playground, call the API, or start explicitly labelled simulated traffic."
            className="border-0"
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Scored at</TH>
                  <TH>Request</TH>
                  <TH>Prediction</TH>
                  <TH>Confidence</TH>
                  <TH>Latency</TH>
                  <TH>Status</TH>
                  <TH>Ground truth</TH>
                  <TH className="text-right">Label</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((row) => (
                  <TR key={row.id}>
                    <TD className="whitespace-nowrap text-[11px] text-muted-foreground">{fmtDate(row.timestamp)}</TD>
                    <TD className="max-w-48">
                      <span className="block truncate font-mono text-[10px]">{row.request_id}</span>
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        {row.is_batch ? "batch" : "single"}
                        <SimulatedBadge simulated={row.simulated} />
                      </span>
                    </TD>
                    <TD className="text-xs font-medium">{row.prediction ?? "—"}</TD>
                    <TD className="text-xs tabular-nums">{row.confidence === null ? "—" : fmtPercent(row.confidence, 2)}</TD>
                    <TD className="text-xs tabular-nums">{fmtMs(row.latency_ms)}</TD>
                    <TD>
                      <StatusBadge status={row.status} />
                      {row.error_type ? <span className="mt-1 block text-[10px] text-destructive">{row.error_type}</span> : null}
                    </TD>
                    <TD>
                      {row.ground_truth !== null ? (
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">{row.ground_truth}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {fmtDate(row.label_received_at)}
                            {row.label_simulated ? " · simulated" : ""}
                          </span>
                        </div>
                      ) : (
                        <Badge tone="warning">Unlabelled</Badge>
                      )}
                    </TD>
                    <TD className="text-right">
                      {row.status === "success" && row.ground_truth === null ? (
                        <Button variant="outline" size="sm" onClick={() => setLabelRow(row)}>
                          <Tag /> Add label
                        </Button>
                      ) : row.ground_truth !== null ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-success">
                          <CheckCircle2 className="size-3.5" /> Recorded
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </SectionCard>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          Labels power delayed performance monitoring. Without enough labels the API reports an explicit{" "}
          <span className="font-medium text-foreground">insufficient_labels</span> state rather than estimating accuracy from unlabelled
          predictions.
        </span>
      </div>

      <PerformanceSection deploymentId={deployment.id} days={7} />

      <LabelDialog deployment={deployment} row={labelRow} open={Boolean(labelRow)} onOpenChange={(open) => !open && setLabelRow(null)} />
    </div>
  );
}
