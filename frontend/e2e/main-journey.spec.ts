import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("owner can register, train, approve, deploy, score and monitor a model", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.com`;
  const password = "E2ePassword123!";
  const projectName = `E2E Churn ${stamp}`;

  await test.step("register a new workspace", async () => {
    await page.goto("/register");
    await page.getByLabel("Full name").fill("E2E Owner");
    await page.getByLabel("Work email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByLabel("Workspace name").fill("E2E Workspace");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
  });

  let projectId = "";
  await test.step("create a classification project", async () => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Project name").fill(projectName);
    await dialog.getByLabel("Task type").selectOption("classification");
    await dialog.getByLabel("Target column").fill("is_churned");
    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/, { timeout: 30_000 });
    projectId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(projectId).not.toBe("");
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  });

  await test.step("create a real synthetic sample dataset", async () => {
    await page.getByRole("tab", { name: "Datasets" }).click();
    await page.getByRole("button", { name: "Sample data", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Sample dataset")).toHaveValue("churn-classification");
    await dialog.getByRole("button", { name: "Create sample" }).click();
    await expect(page.getByText(/Baseline sample created/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Customer Churn").first()).toBeVisible();
  });

  await test.step("train a real model and wait for completion", async () => {
    await page.getByRole("tab", { name: "Training" }).click();
    const start = page.getByRole("button", { name: "Start training" });
    await expect(start).toBeEnabled({ timeout: 30_000 });
    await start.click();
    await expect(page.getByText(/Training completed\. Review the run/)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText("Active job")).toBeVisible();
  });

  await test.step("approve the registered version", async () => {
    await page.goto(`/registry?project=${projectId}`);
    await expect(page.getByRole("button", { name: "Review" }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Review" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Awaiting human approval")).toBeVisible();
    await dialog.getByRole("tab", { name: "Governance" }).click();
    await dialog.getByLabel("Approval note").fill("E2E review of held-out metrics and model card.");
    await dialog.getByRole("button", { name: "Approve version" }).click();
    await expect(page.getByText(/Model version approved/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Approved", { exact: true }).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

  let deploymentId = "";
  await test.step("deploy the approved version", async () => {
    await page.goto("/deployments");
    await page.getByRole("button", { name: "New deployment" }).click();
    const dialog = page.getByRole("dialog");
    const projectSelect = dialog.getByLabel("Project filter");
    await expect(projectSelect.locator("option", { hasText: projectName })).toHaveCount(1, { timeout: 30_000 });
    await projectSelect.selectOption({ label: projectName });

    const selects = dialog.locator("select");
    await expect(selects.nth(1).locator("option")).toHaveCount(2, { timeout: 30_000 });
    await selects.nth(1).selectOption({ index: 1 });
    await expect(selects.nth(2).locator("option")).toHaveCount(2, { timeout: 30_000 });
    await selects.nth(2).selectOption({ index: 1 });
    await dialog.getByPlaceholder("Fraud scoring · production").fill("E2E production endpoint");
    await dialog.getByRole("button", { name: "Deploy model" }).click();

    await expect(dialog.getByRole("heading", { name: "Deployment created" })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/^mlp_[A-Za-z0-9_-]+$/).first()).toBeVisible();
    await dialog.getByRole("link", { name: /Open deployment/ }).click();
    await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]+$/, { timeout: 30_000 });
    deploymentId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(deploymentId).not.toBe("");
    await expect(page.getByRole("heading", { name: "E2E production endpoint" })).toBeVisible();
  });

  await test.step("score a request in the playground", async () => {
    await page.getByRole("tab", { name: "Playground" }).click();
    await expect(page.getByText("Request builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Prediction", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^request [0-9a-f-]+$/)).toBeVisible();
  });

  await test.step("verify real telemetry reaches monitoring", async () => {
    await page.goto(`/monitoring?deployment=${deploymentId}`);
    await expect(page.getByRole("heading", { name: "Monitoring" })).toBeVisible();
    await expect(page.getByText("Requests", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("p95 latency", { exact: true })).toBeVisible();
    await expect(page.getByText("Prediction distribution", { exact: true })).toBeVisible();
    await expect(page.getByText("Production", { exact: true }).first()).toBeVisible();
  });

  await test.step("verify the model is visible in the registry and deployments list", async () => {
    await page.goto(`/registry?project=${projectId}`);
    await expect(page.getByRole("table").getByText("Approved", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.goto("/deployments");
    await expect(page.getByText("E2E production endpoint")).toBeVisible();
    await expect(page.getByRole("table").getByText("Active", { exact: true }).first()).toBeVisible();
  });
});
