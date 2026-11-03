"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Download,
  Eye,
  FileSpreadsheet,
  FlaskConical,
  History,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyHint, SectionCard } from "@/components/common";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
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
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, apiDownload, downloadBlob } from "@/lib/api";
import { useDatasets, useDemoStatus } from "@/lib/hooks";
import type { Dataset, DatasetPreview, DatasetVersion, TaskType } from "@/lib/types";
import { errorMessage, fmtBytes, fmtDate, fmtNumber, fmtPercent, fmtRelative, truncateMiddle } from "@/lib/utils";

function UploadDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [isReference, setIsReference] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setFile(null);
      setName("");
      setDescription("");
      setNotes("");
      setIsReference(false);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a CSV file first.");
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      form.append("description", description.trim());
      form.append("notes", notes.trim());
      form.append("is_reference", String(isReference));
      return api<DatasetVersion>(`/projects/${projectId}/datasets/upload`, { method: "POST", body: form });
    },
    onSuccess: (version) => {
      toast.success(`Dataset uploaded: ${fmtNumber(version.row_count)} rows × ${version.column_count} columns.`);
      void queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload CSV dataset</DialogTitle>
          <DialogDescription>
            Files are validated for type, size, encoding, row/column limits and target presence. Uploaded files are never executed.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogBody className="space-y-3">
            <Field label="CSV file" required htmlFor="dataset-file" hint="Max 50 MB">
              <Input
                id="dataset-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  if (selected && !name) setName(selected.name.replace(/\.csv$/i, "").slice(0, 160));
                }}
                required
              />
            </Field>
            <Field label="Dataset name" htmlFor="dataset-name" hint="Leave blank to use the filename">
              <Input
                id="dataset-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={160}
                placeholder="Customer churn baseline"
              />
            </Field>
            <Field label="Description" htmlFor="dataset-description">
              <Textarea
                id="dataset-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="Source, collection period, known caveats…"
              />
            </Field>
            <Field label="Version notes" htmlFor="dataset-notes">
              <Input
                id="dataset-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
                placeholder="Why this version exists"
              />
            </Field>
            <Checkbox
              checked={isReference}
              onChange={(event) => setIsReference(event.target.checked)}
              label="Use as the reference dataset for drift monitoring"
            />
            <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              PII-like columns are profiled but excluded from model features and monitoring capture. The target column is never
              used as an input feature.
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !file}>
              {mutation.isPending ? "Uploading…" : "Upload dataset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SampleDialog({
  projectId,
  taskType,
  open,
  onOpenChange,
}: {
  projectId: string;
  taskType: TaskType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: demo } = useDemoStatus();
  const options = (demo?.sample_datasets ?? []).filter((sample) => sample.task_type === taskType);
  const [sampleKey, setSampleKey] = React.useState("");
  const [shifted, setShifted] = React.useState(false);
  const [name, setName] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setSampleKey(options[0]?.key ?? "");
      setShifted(false);
      setName("");
    }
  }, [open, options]);

  const mutation = useMutation({
    mutationFn: () =>
      api<DatasetVersion>(`/projects/${projectId}/datasets/sample`, {
        method: "POST",
        body: {
          sample_key: sampleKey,
          shifted,
          is_reference: !shifted,
          name: name.trim() || null,
        },
      }),
    onSuccess: (version) => {
      toast.success(
        `${shifted ? "Shifted" : "Baseline"} sample created · ${fmtNumber(version.row_count)} rows. Synthetic demo data is labeled in the dataset notes.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create sample dataset</DialogTitle>
          <DialogDescription>
            Built-in synthetic datasets for {taskType} projects. The shifted variant is useful for demonstrating drift detection.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {options.length === 0 ? (
            <EmptyHint>No sample dataset is available for this task type.</EmptyHint>
          ) : (
            <>
              <Field label="Sample dataset" required htmlFor="sample-key">
                <Select id="sample-key" value={sampleKey} onChange={(event) => setSampleKey(event.target.value)}>
                  {options.map((sample) => (
                    <option key={sample.key} value={sample.key}>
                      {sample.name} · target: {sample.target_column}
                    </option>
                  ))}
                </Select>
              </Field>
              {options.find((sample) => sample.key === sampleKey) ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {options.find((sample) => sample.key === sampleKey)?.description}
                </p>
              ) : null}
              <Field label="Dataset name" htmlFor="sample-name" hint="Optional">
                <Input id="sample-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
              </Field>
              <div className="space-y-2 rounded-lg border p-3">
                <Checkbox
                  checked={shifted}
                  onChange={(event) => setShifted(event.target.checked)}
                  label="Generate the distribution-shifted variant"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Shifted data is synthetic and intended for drift tests. It is never treated as production evidence.
                </p>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !sampleKey}>
            {mutation.isPending ? "Creating…" : "Create sample"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({
  version,
  open,
  onOpenChange,
}: {
  version: DatasetVersion | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dataset-preview", version?.id],
    queryFn: () => api<DatasetPreview>(`/datasets/${version?.id}/preview?limit=25`),
    enabled: Boolean(open && version?.id),
  });

  const profile = version?.profile;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {version ? `${version.dataset_name} · v${version.version}` : "Dataset preview"}
          </DialogTitle>
          <DialogDescription>
            Raw values are shown for inspection only. PII-like columns are excluded from model features and monitoring capture.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {version ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Rows", fmtNumber(version.row_count)],
                ["Columns", fmtNumber(version.column_count)],
                ["Size", fmtBytes(version.size_bytes)],
                ["Missing cells", fmtNumber(profile?.missing_cells ?? 0)],
                ["Missing rate", fmtPercent(profile?.missing_rate ?? 0, 2)],
                ["Duplicate rows", fmtNumber(profile?.duplicate_rows ?? 0)],
                ["Reference", version.is_reference ? "Yes" : "No"],
                ["Uploaded", fmtRelative(version.created_at)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                  <div className="mt-0.5 text-xs font-semibold">{value}</div>
                </div>
              ))}
            </div>
          ) : null}

          <SectionCard title="Schema & profile" description="Column roles are inferred from name, dtype and cardinality.">
            <div className="max-h-64 overflow-auto rounded-lg border">
              <Table>
                <THead>
                  <TR>
                    <TH>Column</TH>
                    <TH>Kind</TH>
                    <TH>Role</TH>
                    <TH>Type</TH>
                    <TH>Missing</TH>
                    <TH>Unique</TH>
                    <TH>Examples</TH>
                  </TR>
                </THead>
                <TBody>
                  {(version?.schema ?? []).map((field) => (
                    <TR key={field.name}>
                      <TD className="font-mono text-[11px]">{field.name}</TD>
                      <TD>
                        <Badge tone={field.kind === "numeric" ? "info" : "muted"}>{field.kind}</Badge>
                      </TD>
                      <TD>
                        <Badge tone={field.role === "target" ? "warning" : field.role === "excluded" ? "danger" : "default"}>
                          {field.role}
                        </Badge>
                      </TD>
                      <TD className="text-[11px] text-muted-foreground">{field.dtype}</TD>
                      <TD className="tabular-nums">{fmtNumber(field.missing_count ?? 0)}</TD>
                      <TD className="tabular-nums">{fmtNumber(field.unique_count ?? 0)}</TD>
                      <TD className="max-w-48 truncate text-[11px] text-muted-foreground">
                        {Array.isArray(field.examples) ? field.examples.slice(0, 3).map(String).join(", ") : "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </SectionCard>

          <SectionCard title="Preview rows" description={data?.note}>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-7 w-full" />
                ))}
              </div>
            ) : null}
            {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
            {data ? (
              <div className="max-h-80 overflow-auto rounded-lg border">
                <Table>
                  <THead>
                    <TR>
                      {data.columns.map((column) => (
                        <TH key={column} className="whitespace-nowrap font-mono text-[10px]">
                          {column}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {data.rows.map((row, index) => (
                      <TR key={index}>
                        {data.columns.map((column) => (
                          <TD key={column} className="max-w-48 truncate font-mono text-[11px]">
                            {row[column] === null || row[column] === undefined ? "—" : String(row[column])}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}
            {data ? (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Showing {data.returned_rows} of {fmtNumber(data.total_rows)} rows.
              </p>
            ) : null}
          </SectionCard>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function VersionRow({
  projectId,
  version,
  isAdmin,
  onPreview,
}: {
  projectId: string;
  version: DatasetVersion;
  isAdmin: boolean;
  onPreview: (version: DatasetVersion) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
  };

  const setReference = async () => {
    setBusy(true);
    try {
      await api(`/datasets/${version.id}`, { method: "PATCH", body: { is_reference: true } });
      toast.success("Reference dataset updated.");
      invalidate();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await apiDownload(`/datasets/${version.id}/download`);
      downloadBlob(blob, filename);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${version.dataset_name} v${version.version}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/datasets/${version.id}`, { method: "DELETE" });
      toast.success("Dataset version deleted.");
      invalidate();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TR>
      <TD>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold">v{version.version}</span>
          {version.is_reference ? (
            <Badge tone="success">
              <Star className="size-3" /> Reference
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 max-w-64 truncate text-[10px] text-muted-foreground">{version.original_filename}</div>
      </TD>
      <TD className="whitespace-nowrap text-xs tabular-nums">
        {fmtNumber(version.row_count)} × {version.column_count}
      </TD>
      <TD className="whitespace-nowrap text-xs">{fmtBytes(version.size_bytes)}</TD>
      <TD className="whitespace-nowrap text-xs">{fmtPercent(version.profile?.missing_rate ?? 0, 2)}</TD>
      <TD className="whitespace-nowrap font-mono text-[10px] text-muted-foreground" title={version.content_hash}>
        {truncateMiddle(version.content_hash, 8, 6)}
      </TD>
      <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtRelative(version.created_at)}</TD>
      <TD>
        <div className="flex flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => onPreview(version)}>
            <Eye /> Preview
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void download()} disabled={busy}>
            <Download /> CSV
          </Button>
          {!version.is_reference ? (
            <Button variant="ghost" size="sm" onClick={() => void setReference()} disabled={busy}>
              <Star /> Reference
            </Button>
          ) : null}
          {isAdmin ? (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void remove()} disabled={busy}>
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </TD>
    </TR>
  );
}

export function DatasetsPanel({
  projectId,
  taskType,
  isAdmin,
}: {
  projectId: string;
  taskType: TaskType;
  isAdmin: boolean;
}) {
  const { data: datasets, isLoading, error, refetch } = useDatasets(projectId);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [sampleOpen, setSampleOpen] = React.useState(false);
  const [previewVersion, setPreviewVersion] = React.useState<DatasetVersion | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  const totalVersions = (datasets ?? []).reduce((sum, dataset) => sum + dataset.versions.length, 0);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Datasets"
        description={`${datasets?.length ?? 0} datasets · ${totalVersions} versions. Every version is content-hashed and immutable.`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setSampleOpen(true)}>
              <FlaskConical /> Sample data
            </Button>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload /> Upload CSV
            </Button>
          </>
        }
      >
        {isLoading ? <LoadingBlock label="Loading datasets…" /> : null}
        {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
        {!isLoading && !error && (datasets ?? []).length === 0 ? (
          <EmptyState
            title="No datasets yet"
            description="Upload a CSV or create one of the built-in synthetic sample datasets. The target column must exist in the file."
            icon={Database}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => setSampleOpen(true)}>
                  <FlaskConical /> Use sample data
                </Button>
                <Button onClick={() => setUploadOpen(true)}>
                  <Upload /> Upload CSV
                </Button>
              </div>
            }
          />
        ) : null}
        <div className="space-y-5">
          {(datasets ?? []).map((dataset: Dataset) => (
            <div key={dataset.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <FileSpreadsheet className="size-4 text-muted-foreground" />
                <h4 className="text-xs font-semibold">{dataset.name}</h4>
                <Badge tone="muted">{dataset.versions.length} version{dataset.versions.length === 1 ? "" : "s"}</Badge>
                <span className="text-[10px] text-muted-foreground">{dataset.description || "No description"}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">Created {fmtDate(dataset.created_at, false)}</span>
              </div>
              <div className="overflow-hidden rounded-lg border">
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Version</TH>
                        <TH>Shape</TH>
                        <TH>Size</TH>
                        <TH>Missing</TH>
                        <TH>SHA-256</TH>
                        <TH>Created</TH>
                        <TH className="text-right">Actions</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {dataset.versions.map((version) => (
                        <VersionRow
                          key={version.id}
                          projectId={projectId}
                          version={version}
                          isAdmin={isAdmin}
                          onPreview={(selected) => {
                            setPreviewVersion(selected);
                            setPreviewOpen(true);
                          }}
                        />
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="rounded-xl border border-dashed px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        <History className="mr-1 inline size-3" />
        Reference datasets are used as the drift baseline and as the source of model evaluation context. Changing the reference
        does not retrain existing models. Dataset versions referenced by a model or run cannot be deleted.
      </div>

      <UploadDialog projectId={projectId} open={uploadOpen} onOpenChange={setUploadOpen} />
      <SampleDialog projectId={projectId} taskType={taskType} open={sampleOpen} onOpenChange={setSampleOpen} />
      <PreviewDialog version={previewVersion} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}
