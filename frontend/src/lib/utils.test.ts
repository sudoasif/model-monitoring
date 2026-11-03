import { describe, expect, it } from "vitest";

import {
  cn,
  errorMessage,
  fmtBytes,
  fmtDuration,
  fmtMetric,
  fmtMs,
  fmtNumber,
  fmtPercent,
  higherIsBetter,
  metricLabel,
  primaryMetricLabel,
  primaryMetricName,
  severityTone,
  statusTone,
  titleCase,
  truncateMiddle,
} from "@/lib/utils";

describe("formatting helpers", () => {
  it("formats labels and numbers with explicit empty states", () => {
    expect(titleCase("roc_auc")).toBe("Roc Auc");
    expect(titleCase("pending-approval")).toBe("Pending Approval");
    expect(titleCase(null)).toBe("—");
    expect(fmtNumber(1234.56, 1)).toBe("1,234.6");
    expect(fmtNumber(undefined)).toBe("—");
    expect(fmtPercent(0.834, 1)).toBe("83.4%");
    expect(fmtPercent(null)).toBe("—");
    expect(fmtMetric(0.91234)).toBe("0.912");
    expect(fmtMetric(1500)).toBe("1,500");
    expect(fmtMetric(Number.NaN)).toBe("—");
  });

  it("formats latencies, sizes, and durations", () => {
    expect(fmtMs(4.26)).toBe("4.3 ms");
    expect(fmtMs(450)).toBe("450 ms");
    expect(fmtMs(2500)).toBe("2.50 s");
    expect(fmtMs(null)).toBe("—");
    expect(fmtBytes(900)).toBe("900 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtDuration(12.34)).toBe("12.3s");
    expect(fmtDuration(75)).toBe("1m 15s");
    expect(fmtDuration(3720)).toBe("1h 2m");
    expect(fmtDuration(undefined)).toBe("—");
  });

  it("truncates long identifiers in the middle", () => {
    expect(truncateMiddle("short")).toBe("short");
    expect(truncateMiddle("0123456789abcdefghijklmnop", 6, 4)).toBe("012345…mnop");
    expect(truncateMiddle("")).toBe("—");
  });

  it("normalizes unknown errors", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ nope: true })).toMatch(/went wrong/i);
  });
});

describe("metric and status policy", () => {
  it("maps statuses to semantic tones", () => {
    expect(statusTone("approved")).toBe("success");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("acknowledged")).toBe("info");
    expect(statusTone("archived")).toBe("muted");
    expect(statusTone("something-new")).toBe("default");
  });

  it("maps severities without treating high as success", () => {
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("high")).toBe("warning");
    expect(severityTone("low")).toBe("info");
    expect(severityTone("none")).toBe("success");
    expect(severityTone(null)).toBe("muted");
  });

  it("uses task-aware primary metrics and directions", () => {
    expect(primaryMetricName("regression")).toBe("rmse");
    expect(primaryMetricName("classification")).toBe("roc_auc");
    expect(primaryMetricLabel("regression")).toBe("RMSE");
    expect(primaryMetricLabel("classification")).toBe("ROC AUC");
    expect(higherIsBetter("roc_auc")).toBe(true);
    expect(higherIsBetter("f1_macro")).toBe(true);
    expect(higherIsBetter("rmse")).toBe(false);
    expect(higherIsBetter("mae")).toBe(false);
    expect(metricLabel("r2")).toBe("R²");
    expect(metricLabel("custom_metric")).toBe("Custom Metric");
  });

  it("merges conflicting utility classes", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
