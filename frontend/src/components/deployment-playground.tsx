"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  FlaskConical,
  Play,
  RotateCcw,
  Send,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { CopyButton, SectionCard, StatusBadge } from "@/components/common";
import { FeatureImportanceChart } from "@/components/charts";
import {
  Badge,
  Button,
  Checkbox,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from "@/components/ui";
import { API_BASE, api } from "@/lib/api";
import { usePredictionSchema } from "@/lib/hooks";
import type {
  BatchResult,
  DatasetField,
  Deployment,
  LocalExplanation,
  PredictionResult,
} from "@/lib/types";
import { errorMessage, fmtDate, fmtMetric, fmtMs, safeJson, titleCase } from "@/lib/utils";

function initialValues(fields: DatasetField[], features: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of fields) {
    const example = features[field.name] ?? field.example ?? field.examples?.[0];
    next[field.name] = example === null || example === undefined ? "" : String(example);
  }
  return next;
}

function coerce(field: DatasetField, raw: string): unknown {
  if (raw === "") return null;
  if (field.kind === "numeric") {
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  if (field.kind === "boolean") return raw === "true";
  return raw;
}

function ProbabilityList({ probabilities }: { probabilities: Record<string, number> | null | undefined }) {
  if (!probabilities) return null;
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2">
      {entries.map(([label, value]) => (
        <div key={label} className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium">{label}</span>
            <span className="tabular-nums text-muted-foreground">{(value * 100).toFixed(2)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PredictionResultCard({ result }: { result: PredictionResult }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success"><CheckCircle2 /> Scored</Badge>
        <Badge tone="muted">v{result.model_version}</Badge>
        <Badge tone="muted">{fmtMs(result.latency_ms)}</Badge>
        {result.simulated ? <Badge tone="warning">Simulated</Badge> : <Badge tone="info">Production</Badge>}
      </div>
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Prediction</div>
        <div className="mt-1 text-2xl font-semibold">{String(result.prediction)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {result.confidence !== undefined && result.confidence !== null ? <span>Confidence {(result.confidence * 100).toFixed(2)}%</span> : null}
          <span className="font-mono">request {result.request_id}</span>
          <span>{fmtDate(result.timestamp)}</span>
        </div>
      </div>
      {result.probabilities ? (
        <div>
          <div className="mb-2 text-[11px] font-medium">Probabilities</div>
          <ProbabilityList probabilities={result.probabilities} />
        </div>
      ) : null}
    </div>
  );
}

export function DeploymentPlaygroundPanel({ deployment }: { deployment: Deployment }) {
  const { data, isLoading, error, refetch } = usePredictionSchema(deployment.id);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [returnProbabilities, setReturnProbabilities] = React.useState(true);
  const [requestId, setRequestId] = React.useState("");
  const [single, setSingle] = React.useState<PredictionResult | null>(null);
  const [batch, setBatch] = React.useState<BatchResult | null>(null);
  const [batchText, setBatchText] = React.useState("");
  const [explanation, setExplanation] = React.useState<LocalExplanation | null>(null);
  const [mode, setMode] = React.useState<"single" | "batch">("single");

  const fields = React.useMemo(() => data?.schema.fields ?? [], [data]);
  const features = data?.features ?? {};

  React.useEffect(() => {
    if (!data) return;
    setValues(initialValues(data.schema.fields, data.features));
    setBatchText(JSON.stringify([data.features], null, 2));
  }, [data]);

  const buildFeatures = React.useCallback(() => {
    const record: Record<string, unknown> = {};
    for (const field of fields) {
      record[field.name] = coerce(field, values[field.name] ?? "");
    }
    return record;
  }, [fields, values]);

  const singleMutation = useMutation({
    mutationFn: () =>
      api<PredictionResult>(`/deployments/${deployment.id}/predict`, {
        method: "POST",
        body: {
          features: buildFeatures(),
          return_probabilities: returnProbabilities,
          request_id: requestId.trim() || undefined,
        },
      }),
    onSuccess: (payload) => {
      setSingle(payload);
      setExplanation(null);
      toast.success(`Scored in ${fmtMs(payload.latency_ms)}.`);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const batchMutation = useMutation({
    mutationFn: () => {
      let records: Record<string, unknown>[];
      try {
        const parsed = JSON.parse(batchText);
        if (!Array.isArray(parsed)) throw new Error("Batch body must be a JSON array of feature objects.");
        records = parsed as Record<string, unknown>[];
      } catch (parseError) {
        throw new Error(parseError instanceof Error ? parseError.message : "Invalid JSON batch body.");
      }
      return api<BatchResult>(`/deployments/${deployment.id}/predict/batch`, {
        method: "POST",
        body: { records, return_probabilities: returnProbabilities },
      });
    },
    onSuccess: (payload) => {
      setBatch(payload);
      toast.success(`Scored ${payload.count} records in ${fmtMs(payload.latency_ms)}.`);
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const explainMutation = useMutation({
    mutationFn: () =>
      api<LocalExplanation>(`/deployments/${deployment.id}/explain`, {
        method: "POST",
        body: { features: buildFeatures(), top_n: 15 },
      }),
    onSuccess: (payload) => setExplanation(payload),
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  if (isLoading) return <LoadingBlock label="Loading the prediction contract…" />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;
  if (!data) return null;

  const taskType = data.schema.task_type;
  const classLabels = data.schema.class_labels ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
      <div className="space-y-4">
        <SectionCard
          title="Request builder"
          description="Values are initialized from the training schema. Adjust them to test real scoring behavior."
          actions={
            <Button variant="outline" size="sm" onClick={() => setValues(initialValues(fields, features))}>
              <RotateCcw /> Reset sample
            </Button>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => setMode("single")}
                className={`rounded-md px-3 py-1 text-xs font-medium ${mode === "single" ? "bg-card shadow-xs" : "text-muted-foreground"}`}
              >
                Single
              </button>
              <button
                type="button"
                onClick={() => setMode("batch")}
                className={`rounded-md px-3 py-1 text-xs font-medium ${mode === "batch" ? "bg-card shadow-xs" : "text-muted-foreground"}`}
              >
                Batch
              </button>
            </div>
            <Badge tone="muted">{titleCase(taskType)}</Badge>
            <Badge tone="muted">{fields.length} features</Badge>
            {classLabels.length ? <Badge tone="muted">{classLabels.join(" / ")}</Badge> : null}
          </div>

          {mode === "single" ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((field) => (
                  <Field key={field.name} label={field.name} hint={field.kind} htmlFor={`feature-${field.name}`}>
                    {field.kind === "boolean" ? (
                      <Select
                        id={`feature-${field.name}`}
                        value={values[field.name] ?? ""}
                        onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                      >
                        <option value="">null</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </Select>
                    ) : (
                      <Input
                        id={`feature-${field.name}`}
                        type={field.kind === "numeric" ? "number" : "text"}
                        step="any"
                        value={values[field.name] ?? ""}
                        onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                        placeholder={field.nullable ? "null allowed" : "required"}
                      />
                    )}
                  </Field>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3 border-t pt-3">
                <Field label="Idempotency request ID" hint="optional" className="min-w-56 flex-1">
                  <Input
                    value={requestId}
                    onChange={(event) => setRequestId(event.target.value)}
                    placeholder="e.g. order-12345"
                    maxLength={64}
                    className="font-mono text-xs"
                  />
                </Field>
                <Checkbox
                  checked={returnProbabilities}
                  onChange={(event) => setReturnProbabilities(event.target.checked)}
                  label="Return probabilities"
                />
                <Button onClick={() => singleMutation.mutate()} disabled={singleMutation.isPending || deployment.status !== "active"}>
                  <Send /> {singleMutation.isPending ? "Scoring…" : "Send request"}
                </Button>
              </div>
              {deployment.status !== "active" ? (
                <p className="text-xs text-destructive">This deployment is paused. Activate it in Settings before sending requests.</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="JSON records" hint="1–1000 records; server limits apply">
                <Textarea
                  value={batchText}
                  onChange={(event) => setBatchText(event.target.value)}
                  className="min-h-64 font-mono text-[11px]"
                  spellCheck={false}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Checkbox
                  checked={returnProbabilities}
                  onChange={(event) => setReturnProbabilities(event.target.checked)}
                  label="Return probabilities"
                />
                <Button onClick={() => batchMutation.mutate()} disabled={batchMutation.isPending || deployment.status !== "active"}>
                  <Play /> {batchMutation.isPending ? "Scoring batch…" : "Run batch"}
                </Button>
              </div>
            </div>
          )}
        </SectionCard>

        {mode === "single" && single ? (
          <SectionCard
            title="Response"
            description="Every request is persisted with a request ID, timestamp, latency, and error status."
            actions={
              <Button variant="outline" size="sm" onClick={() => explainMutation.mutate()} disabled={explainMutation.isPending}>
                <BrainCircuit /> {explainMutation.isPending ? "Explaining…" : "Explain this prediction"}
              </Button>
            }
          >
            <PredictionResultCard result={single} />
          </SectionCard>
        ) : null}

        {mode === "batch" && batch ? (
          <SectionCard title="Batch response" description={`${batch.count} records · ${fmtMs(batch.latency_ms)} total`} contentClassName="p-0">
            <div className="max-h-80 overflow-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Prediction</TH>
                    <TH>Confidence</TH>
                    <TH>Latency</TH>
                    <TH>Request</TH>
                  </TR>
                </THead>
                <TBody>
                  {batch.predictions.map((item, index) => (
                    <TR key={item.request_id}>
                      <TD className="text-xs text-muted-foreground">{index + 1}</TD>
                      <TD className="text-xs font-medium">{String(item.prediction)}</TD>
                      <TD className="text-xs tabular-nums">{item.confidence === null || item.confidence === undefined ? "—" : `${(item.confidence * 100).toFixed(1)}%`}</TD>
                      <TD className="text-xs tabular-nums">{fmtMs(item.latency_ms)}</TD>
                      <TD className="font-mono text-[10px] text-muted-foreground">{item.request_id}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </SectionCard>
        ) : null}

        {explanation ? (
          <SectionCard
            title="Local explanation"
            description={`${explanation.method} · prediction ${String(explanation.prediction)} · model v${explanation.model_version}`}
          >
            <div className="space-y-3">
              {explanation.warnings.length ? (
                <div className="space-y-1 rounded-lg border border-warning/35 bg-warning/10 p-3 text-xs">
                  {explanation.warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-[11px] font-medium">Top contributions</div>
                  <FeatureImportanceChart
                    items={explanation.contributions as unknown as Array<Record<string, unknown>>}
                    height={280}
                    valueKey="contribution"
                    colorKey="direction"
                  />
                </div>
                <div className="max-h-72 overflow-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Feature</TH>
                        <TH>Value</TH>
                        <TH>Contribution</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {explanation.contributions.map((item) => (
                        <TR key={item.feature}>
                          <TD className="font-mono text-[10px]">{item.feature}</TD>
                          <TD className="max-w-32 truncate text-[11px]">{String(item.value ?? "—")}</TD>
                          <TD className={`text-[11px] tabular-nums ${item.contribution >= 0 ? "text-success" : "text-destructive"}`}>
                            {item.contribution >= 0 ? "+" : ""}
                            {fmtMetric(item.contribution, 4)}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                <span>Base value {fmtMetric(explanation.base_value, 4)}</span>
                <span>{explanation.all_feature_count} total features</span>
                <span>Contributions are additive for this prediction only.</span>
              </div>
              {explanation.probabilities ? <ProbabilityList probabilities={explanation.probabilities} /> : null}
            </div>
          </SectionCard>
        ) : null}
      </div>

      <div className="space-y-4">
        <SectionCard title="API request" description="Use the deployment API key or a workspace bearer token." contentClassName="pt-2">
          <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[10px] leading-relaxed">
{`curl -X POST "${API_BASE}/deployments/${deployment.id}/predict" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: <your-deployment-key>" \\
  -d '${safeJson({
    features,
    return_probabilities: true,
  })}'`}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CopyButton
              value={`curl -X POST "${API_BASE}/deployments/${deployment.id}/predict" -H "Content-Type: application/json" -H "X-API-Key: <your-deployment-key>" -d '${safeJson({ features, return_probabilities: true })}'`}
              label="Copy cURL"
            />
            <Badge tone="muted">slug {deployment.slug}</Badge>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            The public slug route is <span className="font-mono">/api/predict/{deployment.slug}</span>. Both routes enforce API-key or
            bearer authentication, body-size limits, and per-minute rate limits.
          </p>
        </SectionCard>

        <SectionCard title="Contract" contentClassName="pt-2">
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Task type</dt>
              <dd>{titleCase(taskType)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Target</dt>
              <dd className="font-mono text-[11px]">{data.schema.target_column ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Positive class</dt>
              <dd>{data.schema.positive_class ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Class labels</dt>
              <dd>{classLabels.length ? classLabels.join(", ") : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Deployment status</dt>
              <dd><StatusBadge status={deployment.status} /></dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Try a real scenario" contentClassName="pt-2">
          <div className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <p className="flex items-start gap-2">
              <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" />
              Use Settings → Simulated traffic to generate labelled demo requests. Simulated events are marked and never mixed with
              production metrics without the filter.
            </p>
            <p className="flex items-start gap-2">
              <Terminal className="mt-0.5 size-3.5 shrink-0 text-primary" />
              Every prediction is recorded with a request ID, latency, status, and optional ground truth. Errors are counted without
              storing raw inputs.
            </p>
            <p className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-primary" />
              After scoring, open Monitoring to inspect latency percentiles, prediction distribution, and drift evidence.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
