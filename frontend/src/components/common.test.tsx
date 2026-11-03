import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SearchField,
  SectionCard,
  SeverityBadge,
  SimulatedBadge,
  StatusBadge,
  TaskBadge,
} from "@/components/common";
import { EmptyState, ErrorState, Pagination, Progress } from "@/components/ui";

describe("status badges", () => {
  it("renders human-readable statuses with semantic styling", () => {
    render(<StatusBadge status="insufficient_labels" />);
    const badge = screen.getByText("Insufficient Labels");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("text-warning-foreground");
  });

  it("accepts an explicit label without losing the status tone", () => {
    render(<StatusBadge status="succeeded" label="Completed" />);
    const badge = screen.getByText("Completed");
    expect(badge).toHaveClass("text-success");
  });

  it("only marks data as simulated when the flag is true", () => {
    const { rerender } = render(<SimulatedBadge simulated={false} />);
    expect(screen.queryByText("Simulated")).not.toBeInTheDocument();

    rerender(<SimulatedBadge simulated />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("renders severity and task labels", () => {
    render(
      <div>
        <SeverityBadge severity="critical" />
        <TaskBadge taskType="regression" />
        <TaskBadge taskType="classification" />
      </div>,
    );
    expect(screen.getByText("Critical")).toHaveClass("text-destructive");
    expect(screen.getByText("Regression")).toBeInTheDocument();
    expect(screen.getByText("Classification")).toBeInTheDocument();
  });
});

describe("shared layout components", () => {
  it("renders a section card with title, description, footer, and content", () => {
    render(
      <SectionCard
        title="Model registry"
        description="Approved versions only"
        footer="Audited changes"
        actions={<button type="button">Refresh</button>}
      >
        <p>Version 3</p>
      </SectionCard>,
    );
    expect(screen.getByText("Model registry")).toBeInTheDocument();
    expect(screen.getByText("Approved versions only")).toBeInTheDocument();
    expect(screen.getByText("Version 3")).toBeInTheDocument();
    expect(screen.getByText("Audited changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("propagates search input changes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SearchField value="" onChange={onChange} placeholder="Search runs" />);
    await user.type(screen.getByRole("textbox", { name: "Search runs" }), "drift");
    expect(onChange).toHaveBeenCalledTimes(5);
    expect(onChange).toHaveBeenLastCalledWith("t");
  });

  it("shows an actionable empty state", () => {
    render(
      <EmptyState
        title="No deployments"
        description="Deploy an approved model to start serving traffic."
        action={<button type="button">New deployment</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No deployments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New deployment" })).toBeInTheDocument();
  });

  it("exposes an error state as an alert with retry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState message="Request timed out." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Request timed out.");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("pagination and progress", () => {
  it("reports the visible range and disables previous on the first page", () => {
    render(<Pagination total={120} limit={25} offset={0} onChange={() => undefined} />);
    expect(screen.getByText("1–25 of 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("advances and rewinds by the page size", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Pagination total={120} limit={25} offset={25} onChange={onChange} />,
    );
    expect(screen.getByText("26–50 of 120")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onChange).toHaveBeenCalledWith(50);

    rerender(<Pagination total={120} limit={25} offset={25} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("disables next on the final page and handles empty totals", () => {
    const { rerender } = render(
      <Pagination total={40} limit={25} offset={25} onChange={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByText("26–40 of 40")).toBeInTheDocument();

    rerender(<Pagination total={0} limit={25} offset={0} onChange={() => undefined} />);
    expect(screen.getByText("0–0 of 0")).toBeInTheDocument();
  });

  it("clamps progress values for accessible rendering", () => {
    const { rerender } = render(<Progress value={150} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<Progress value={-10} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});
