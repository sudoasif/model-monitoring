"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  FlaskConical,
  Info,
  Layers,
  Play,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { CopyButton, DeploymentSelect, ProjectSelect, SectionCard, StatusBadge } from "@/components/common";
import { FeatureImportanceChart } from "@/components/charts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { api } from "@/lib/api";
import {
  useDeploymentOptions,
  useGlobalExplanation,
  usePredictionSchema,
} from "@/lib/hooks";
import type { DatasetField, Deployment, LocalExplanation } from "@/lib/types";
import { errorMessage, fmtDate, fmtMetric, fmtNumber, fmtPercent, safeJson, titleCase } from "@/lib/utils";

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

function WarningList({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="space-y-1 rounded-lg border border-warning/35 bg-warning/10 p-3">
      {warnings.map((warning) => (
        <div key={warning} className="flex items-start gap-2 text-xs leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{warning}</span>
        </div>
      ))}
    </div>
  );
}

function LocalExplanationPanel({ deployment }: { deployment: Deployment }) {
  const { data: schema, isLoading, error, refetch } = usePredictionSchema(deployment.id);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [explanation, setExplanation] = React.useState<LocalExplanation | null>(null);

  const fields = React.useMemo(() => schema?.schema.fields ?? [], [schema]);

  React.useEffect(() => {
    if (schema) {
      setValues(initialValues(schema.schema.fields, schema.features));
      setExplanation(null);
    }
  }, [schema]);

  const mutation = useMutation({
    mutationFn: () => {
      const features: Record<string, unknown> = {};
      for (const field of fields) features[field.name] = coerce(field, values[field.name] ?? "");
      return api<LocalExplanation>(`/deployments/${deployment.id}/explain`, {
        method: "POST",
        body: { features, top_n: 15 },
      });
    },
    onSuccess: (payload) => setExplanation(payload),
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  if (isLoading) return <LoadingBlock label="Loading the explanation contract…" />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;
  if (!schema) return null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <SectionCard
        title="Explain one prediction"
        description="The same preprocessing pipeline used for serving is applied before SHAP attribution."
        actions={
          <Button variant="outline" size="sm" onClick={() => setValues(initialValues(fields, schema.features))}>
            Reset sample
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <Field key={field.name} label={field.name} hint={field.kind}>
                {field.kind === "boolean" ? (
                  <Select
                    value={values[field.name] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  >
                    <option value="">null</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </Select>
                ) : (
                  <Input
                    type={field.kind === "numeric" ? "number" : "text"}
                    step="any"
                    value={values[field.name] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            <Sparkles /> {mutation.isPending ? "Computing SHAP values…" : "Explain prediction"}
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            SHAP may be unavailable for some model families or transformed feature spaces. Unsupported cases return an explicit warning or
            error rather than fabricated attributions.
          </p>
        </div>
      </SectionCard>

      <div className="space-y-4">
        {!explanation ? (
          <EmptyState
            icon={BrainCircuit}
            title="No local explanation yet"
            description="Submit a feature record to compute additive SHAP contributions for that prediction."
            className="min-h-72"
          />
        ) : (
          <>
            <SectionCard
              title="Local attribution"
              description={`${explanation.method} · model v${explanation.model_version} · prediction ${String(explanation.prediction)}`}
              actions={<Badge tone="muted">{explanation.all_feature_count} features</Badge>}
            >
              <div className="space-y-3">
                <WarningList warnings={explanation.warnings} />
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <span>Base value <span className="font-medium text-foreground">{fmtMetric(explanation.base_value, 4)}</span></span>
                  {explanation.probabilities ? (
                    <span>
                      Probabilities:{" "}
                      {Object.entries(explanation.probabilities)
                        .map(([label, value]) => `${label} ${fmtPercent(value, 1)}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
                <FeatureImportanceChart
                  items={explanation.contributions as unknown as Array<Record<string, unknown>>}
                  height={300}
                  valueKey="contribution"
                  colorKey="direction"
                />
                <div className="max-h-72 overflow-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Feature</TH>
                        <TH>Input value</TH>
                        <TH>Contribution</TH>
                        <TH>Direction</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {explanation.contributions.map((item) => (
                        <TR key={item.feature}>
                          <TD className="font-mono text-[10px]">{item.feature}</TD>
                          <TD className="max-w-40 truncate text-[11px]">{String(item.value ?? "—")}</TD>
                          <TD className={`text-[11px] tabular-nums ${item.contribution >= 0 ? "text-success" : "text-destructive"}`}>
                            {item.contribution >= 0 ? "+" : ""}
                            {fmtMetric(item.contribution, 4)}
                          </TD>
                          <TD><Badge tone={item.contribution >= 0 ? "success" : "danger"}>{titleCase(item.direction)}</Badge></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
            </SectionCard>
            <SectionCard
              title="Input used"
              description="The exact record submitted for this explanation."
              actions={<CopyButton value={safeJson(explanation.input)} label="Copy JSON" />}
              contentClassName="pt-2"
            >
              <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[10px] leading-relaxed">
                {safeJson(explanation.input)}
              </pre>
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}

function ExplainabilityContent() {
  const searchParams = useSearchParams();
  const [projectId, setProjectId] = React.useState(searchParams.get("project") ?? "");
  const [deploymentId, setDeploymentId] = React.useState(searchParams.get("deployment") ?? "");
  const { data: deploymentData } = useDeploymentOptions(projectId || null);
  const deployments = React.useMemo(() => deploymentData?.items ?? [], [deploymentData]);

  React.useEffect(() => {
    if (!deployments.length) {
      if (deploymentId) setDeploymentId("");
      return;
    }
    if (!deploymentId || !deployments.some((item) => item.id === deploymentId)) {
      setDeploymentId(deployments[0].id);
    }
  }, [deployments, deploymentId]);

  const deployment = deployments.find((item) => item.id === deploymentId) ?? null;
  const { data: global, isLoading, error, refetch } = useGlobalExplanation(deploymentId || null, 20);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Understand"
        title="Explainability"
        description="Global and local SHAP explanations generated from the deployed model and its recorded preprocessing pipeline."
        actions={
          deployment ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/deployments/${deployment.id}`}>
                <ArrowRight /> Deployment
              </Link>
            </Button>
          ) : null
        }
      />

      <SectionCard contentClassName="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectSelect value={projectId} onChange={(value) => { setProjectId(value); setDeploymentId(""); }} allowAll />
          <DeploymentSelect value={deploymentId} onChange={setDeploymentId} projectId={projectId || null} />
          {deployment ? <Badge tone="muted">{deployment.model_name} v{deployment.model_version}</Badge> : null}
          {global?.cached ? <Badge tone="info">cached explanation</Badge> : null}
          {deployment ? <StatusBadge status={deployment.status} className="ml-auto" /> : null}
        </div>
      </SectionCard>

      {!deploymentId ? (
        <EmptyState
          icon={BrainCircuit}
          title="No deployment selected"
          description="Choose a deployment to explain its model. Explanations are computed from the reference dataset used for that deployment."
          action={<Button asChild size="sm"><Link href="/deployments">Open deployments</Link></Button>}
        />
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
      ) : !global || !deployment ? (
        <EmptyState icon={BrainCircuit} title="No explanation available" description="The model may not support SHAP or no reference data is available." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SectionCard className="p-4" contentClassName="pt-0">
              <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Method</span><Layers className="size-4 text-primary" /></div>
              <div className="mt-1 text-sm font-semibold">{global.method}</div>
              <p className="text-[11px] text-muted-foreground">{titleCase(global.task_type)} model</p>
            </SectionCard>
            <SectionCard className="p-4" contentClassName="pt-0">
              <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Reference rows</span><FlaskConical className="size-4 text-chart-2" /></div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtNumber(global.reference.rows_used)}</div>
              <p className="text-[11px] text-muted-foreground">{fmtNumber(global.reference.rows_available)} available · v{global.reference.dataset_version}</p>
            </SectionCard>
            <SectionCard className="p-4" contentClassName="pt-0">
              <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Features explained</span><BrainCircuit className="size-4 text-primary" /></div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtNumber(global.all_feature_count)}</div>
              <p className="text-[11px] text-muted-foreground">{global.global_importance.length} in this view</p>
            </SectionCard>
            <SectionCard className="p-4" contentClassName="pt-0">
              <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Generated</span><CheckCircle2 className="size-4 text-success" /></div>
              <div className="mt-1 text-sm font-semibold">{fmtDate(global.generated_at)}</div>
              <p className="text-[11px] text-muted-foreground">{global.cached ? "served from cache" : "computed for this request"}</p>
            </SectionCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <SectionCard
              title="Global feature importance"
              description="Mean absolute SHAP value across the reference sample. Positive mean SHAP pushes toward the positive output."
            >
              <FeatureImportanceChart items={global.global_importance as unknown as Array<Record<string, unknown>>} height={360} />
            </SectionCard>
            <div className="space-y-4">
              <SectionCard title="Reference & method" contentClassName="pt-2">
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Deployment</dt><dd className="font-medium">{global.deployment_name}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Model</dt><dd>{global.model_name} v{global.model_version}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Target</dt><dd className="font-mono text-[11px]">{global.target_column}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Sample size</dt><dd className="tabular-nums">{fmtNumber(global.sample_size)}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Dataset</dt><dd>{global.reference.dataset_name} v{global.reference.dataset_version}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Class labels</dt><dd>{global.class_labels.length ? global.class_labels.join(", ") : "—"}</dd></div>
                </dl>
              </SectionCard>
              <SectionCard title="Caveats" contentClassName="pt-2">
                <WarningList warnings={global.warnings} />
                <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <p className="flex items-start gap-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> SHAP explains model output, not causality.</p>
                  <p className="flex items-start gap-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> Correlated features can share credit; use domain review before acting.</p>
                  <p className="flex items-start gap-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> Explanations reflect the approved artifact currently deployed.</p>
                </div>
              </SectionCard>
            </div>
          </div>

          <SectionCard title="Feature attribution detail" description="Top features with share and direction." contentClassName="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Feature</TH>
                  <TH>Kind</TH>
                  <TH>Mean |SHAP|</TH>
                  <TH>Mean SHAP</TH>
                  <TH>Share</TH>
                  <TH>Direction</TH>
                </TR>
              </THead>
              <TBody>
                {global.global_importance.map((item) => (
                  <TR key={item.feature}>
                    <TD className="font-mono text-[11px]">{item.feature}</TD>
                    <TD><Badge tone="muted">{titleCase(item.kind)}</Badge></TD>
                    <TD className="text-xs tabular-nums">{fmtMetric(item.mean_abs_shap, 4)}</TD>
                    <TD className={`text-xs tabular-nums ${item.mean_shap >= 0 ? "text-success" : "text-destructive"}`}>
                      {item.mean_shap >= 0 ? "+" : ""}
                      {fmtMetric(item.mean_shap, 4)}
                    </TD>
                    <TD className="text-xs tabular-nums">{fmtPercent(item.share, 1)}</TD>
                    <TD><Badge tone={item.direction === "positive" ? "success" : item.direction === "negative" ? "danger" : "muted"}>{titleCase(item.direction)}</Badge></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </SectionCard>

          <LocalExplanationPanel deployment={deployment} />

          <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <Play className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span>
              Global explanations use the reference dataset recorded at deployment time. Local explanations use the exact submitted record.
              When a model or transformer does not support SHAP, the API returns an explicit error or warning rather than an invented chart.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default function ExplainabilityPage() {
  return (
    <React.Suspense fallback={<LoadingBlock label="Loading explainability…" />}>
      <ExplainabilityContent />
    </React.Suspense>
  );
}
