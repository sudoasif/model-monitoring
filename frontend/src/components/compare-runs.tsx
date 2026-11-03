"use client";

import * as React from "react";
import { Trophy } from "lucide-react";

import { Badge, ErrorState, LoadingBlock, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { CompareResult } from "@/lib/types";
import { errorMessage, fmtMetric, metricLabel } from "@/lib/utils";

export function CompareRunsDialog({
  runIds,
  open,
  onOpenChange,
}: {
  runIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = React.useState<CompareResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || runIds.length < 2) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<CompareResult>("/runs/compare", { method: "POST", body: { run_ids: runIds } })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Run comparison</DialogTitle>
          <DialogDescription>
            Baseline is the first selected run. Best run is selected only by the primary held-out metric; it is not automatically promoted.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading ? <LoadingBlock label="Comparing runs…" /> : null}
          {error ? <ErrorState message={error} /> : null}
          {data ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge tone="primary">{data.project_name}</Badge>
                <span>
                  Primary: <strong className="text-foreground">{metricLabel(data.primary_metric)}</strong> ·{" "}
                  {data.higher_is_better ? "higher is better" : "lower is better"}
                </span>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Run</TH>
                      <TH>Status</TH>
                      {data.metric_names.map((metric) => (
                        <TH key={metric}>{metricLabel(metric)}</TH>
                      ))}
                      <TH>Δ vs baseline ({metricLabel(data.primary_metric)})</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.runs.map((run) => {
                      const isBest = run.id === data.best_run_id;
                      const delta = data.comparisons[run.id]?.[data.primary_metric];
                      return (
                        <TR key={run.id} className={isBest ? "bg-success/5" : undefined}>
                          <TD className="min-w-44">
                            <div className="flex items-center gap-1.5 font-medium">
                              {isBest ? <Trophy className="size-3 text-success" /> : null}
                              <span className="max-w-48 truncate">{run.name}</span>
                            </div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {run.algorithm} · {run.git_commit || "unversioned"}
                            </div>
                          </TD>
                          <TD>{run.status}</TD>
                          {data.metric_names.map((metric) => (
                            <TD key={metric} className="tabular-nums">
                              {fmtMetric(typeof run.metrics?.[metric] === "number" ? Number(run.metrics[metric]) : null, 4)}
                            </TD>
                          ))}
                          <TD
                            className={
                              delta === null || delta === undefined
                                ? "text-muted-foreground"
                                : (delta > 0) === data.higher_is_better
                                  ? "font-medium text-success"
                                  : "font-medium text-destructive"
                            }
                          >
                            {delta === null || delta === undefined
                              ? "—"
                              : `${delta > 0 ? "+" : ""}${fmtMetric(delta, 4)}`}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Metrics come from each run&apos;s untouched held-out test split. Cross-run comparisons are only meaningful when
                the dataset version and evaluation protocol match. Review the dataset lineage before selecting a model.
              </p>
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
