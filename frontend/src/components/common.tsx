"use client";

import * as React from "react";
import { Check, Copy, FlaskConical, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select } from "@/components/ui";
import { useDeployments, useProjectOptions } from "@/lib/hooks";
import { cn, fmtNumber, severityTone, statusTone, titleCase } from "@/lib/utils";

export function StatusBadge({ status, label, className }: { status: string | null | undefined; label?: string; className?: string }) {
  return (
    <Badge tone={statusTone(status)} className={className}>
      {label ?? titleCase(status || "unknown")}
    </Badge>
  );
}

export function SeverityBadge({ severity, className }: { severity: string | null | undefined; className?: string }) {
  return (
    <Badge tone={severityTone(severity)} className={className}>
      {titleCase(severity || "none")}
    </Badge>
  );
}

export function SimulatedBadge({ simulated, className }: { simulated: boolean | null | undefined; className?: string }) {
  if (!simulated) return null;
  return (
    <Badge tone="warning" className={cn("gap-1", className)}>
      <FlaskConical className="size-3" /> Simulated
    </Badge>
  );
}

export function TaskBadge({ taskType }: { taskType: string | null | undefined }) {
  return (
    <Badge tone={taskType === "regression" ? "info" : "primary"}>
      {taskType === "regression" ? "Regression" : "Classification"}
    </Badge>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
  footer,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  footer?: React.ReactNode;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      {title || description || actions ? (
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <CardTitle>{title}</CardTitle> : null}
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn("pt-1", contentClassName)}>{children}</CardContent>
      {footer ? <div className="border-t px-5 py-3 text-xs text-muted-foreground">{footer}</div> : null}
    </Card>
  );
}

export function DetailRow({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-start gap-3 py-1.5 text-xs", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{children}</dd>
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Copied to clipboard.");
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Clipboard access was blocked by the browser.");
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-44 flex-1 sm:max-w-xs", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-xs"
        aria-label={placeholder}
      />
    </div>
  );
}

export function ProjectSelect({
  value,
  onChange,
  allowAll = false,
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  allowAll?: boolean;
  className?: string;
  id?: string;
}) {
  const { data, isLoading } = useProjectOptions();
  return (
    <Select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-8 max-w-64 text-xs", className)}
      aria-label="Project filter"
    >
      {allowAll ? <option value="">{isLoading ? "Loading projects…" : "All projects"}</option> : null}
      {!allowAll && !value ? <option value="">Select a project…</option> : null}
      {(data?.items ?? []).map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </Select>
  );
}

export function DeploymentSelect({
  value,
  onChange,
  projectId,
  allowAll = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  projectId?: string | null;
  allowAll?: boolean;
  className?: string;
}) {
  const { data, isLoading } = useDeployments({ project_id: projectId || undefined, limit: 100 });
  return (
    <Select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-8 max-w-64 text-xs", className)}
      aria-label="Deployment filter"
    >
      {allowAll ? <option value="">{isLoading ? "Loading deployments…" : "All deployments"}</option> : null}
      {!allowAll && !value ? <option value="">Select a deployment…</option> : null}
      {(data?.items ?? []).map((deployment) => (
        <option key={deployment.id} value={deployment.id}>
          {deployment.name} · v{deployment.model_version}
        </option>
      ))}
    </Select>
  );
}

export function MetricInline({ label, value, digits = 3 }: { label: string; value: unknown; digits?: number }) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{numeric ? fmtNumber(value, digits) : "—"}</div>
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
