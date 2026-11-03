import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function fmtPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtMetric(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1000) return fmtNumber(value, 0);
  return value.toFixed(digits);
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

export function fmtBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

export function fmtDate(value: string | null | undefined, withTime = true): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsInUnit] of ranges) {
    if (Math.abs(seconds) >= secondsInUnit || unit === "second") {
      return formatter.format(Math.round(seconds / secondsInUnit), unit);
    }
  }
  return "—";
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export type Tone = "default" | "primary" | "success" | "warning" | "danger" | "info" | "muted";

export function statusTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "succeeded":
    case "success":
    case "passed":
    case "approved":
    case "active":
    case "healthy":
    case "ok":
    case "sufficient":
    case "completed":
    case "production":
    case "resolved":
      return "success";
    case "running":
    case "queued":
    case "pending":
    case "investigating":
    case "warning":
    case "warnings":
    case "needs_review":
    case "insufficient_labels":
    case "degraded":
      return "warning";
    case "failed":
    case "error":
    case "rejected":
    case "critical":
    case "unhealthy":
    case "cancelled":
    case "degraded_performance":
      return "danger";
    case "acknowledged":
    case "mitigated":
      return "info";
    case "archived":
    case "paused":
    case "none":
    case "draft":
      return "muted";
    default:
      return "default";
  }
}

export function severityTone(severity: string | null | undefined): Tone {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "warning":
      return "warning";
    case "medium":
      return "warning";
    case "info":
    case "low":
      return "info";
    case "none":
      return "success";
    default:
      return "muted";
  }
}

export function primaryMetricName(taskType: string | null | undefined): string {
  return taskType === "regression" ? "rmse" : "roc_auc";
}

export function primaryMetricLabel(taskType: string | null | undefined): string {
  return taskType === "regression" ? "RMSE" : "ROC AUC";
}

export function higherIsBetter(metric: string): boolean {
  return !["rmse", "mae", "log_loss", "mse"].includes(metric);
}

export function metricOrder(taskType: string | null | undefined): string[] {
  return taskType === "regression"
    ? ["r2", "rmse", "mae", "sample_count"]
    : ["accuracy", "f1_macro", "precision_macro", "recall_macro", "roc_auc", "log_loss"];
}

export function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    roc_auc: "ROC AUC",
    f1_macro: "F1 (macro)",
    precision_macro: "Precision",
    recall_macro: "Recall",
    log_loss: "Log loss",
    accuracy: "Accuracy",
    rmse: "RMSE",
    mae: "MAE",
    r2: "R²",
    mse: "MSE",
    sample_count: "Samples",
    train_roc_auc: "Train ROC AUC",
  };
  return labels[metric] ?? titleCase(metric);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}

export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
