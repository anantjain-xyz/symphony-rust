import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}.png`) });
}

test("walks preview loading and every lazy view", async ({ page }, testInfo) => {
  let releasePreview!: () => void;
  let previewRequested!: () => void;
  const previewGate = new Promise<void>((resolve) => (releasePreview = resolve));
  const previewRequest = new Promise<void>((resolve) => (previewRequested = resolve));
  await page.route(/\/assets\/runtime-[^/]+\.js$/, async (route) => {
    previewRequested();
    await previewGate;
    await route.continue();
  });

  await test.step("preview-route:overview", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await previewRequest;
    await expect(page.getByRole("status")).toContainText("Loading preview…");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await capture(page, testInfo, "01-preview-loading");

    releasePreview();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "02-overview");
  });

  let releaseRuns!: () => void;
  let runsRequested!: () => void;
  const runsGate = new Promise<void>((resolve) => (releaseRuns = resolve));
  const runsRequest = new Promise<void>((resolve) => (runsRequested = resolve));
  await page.route(/\/assets\/RunsView-[^/]+\.js$/, async (route) => {
    runsRequested();
    await runsGate;
    await route.continue();
  });
  await test.step("preview-route:runs", async () => {
    await page.getByRole("button", { name: "Runs" }).dispatchEvent("click");
    await runsRequest;
    await expect(page.getByText("Loading Runs…")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await capture(page, testInfo, "03-runs-cold-loading");

    releaseRuns();
    await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
    await capture(page, testInfo, "04-runs");
  });

  const graphChunkPattern = /\/assets\/DependencyGraphPanel-[^/]+\.js$/;
  let graphRequestCount = 0;
  await test.step("preview-route:issues", async () => {
    const issuesButton = page.getByRole("button", { name: "Issues" });
    const issuesResponse = page.waitForResponse(/\/assets\/IssuesView-[^/]+\.js$/);
    await issuesButton.focus();
    await issuesResponse;
    await page.getByRole("button", { name: "Issues" }).click();
    await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible();
    page.on("request", (request) => {
      if (graphChunkPattern.test(request.url())) graphRequestCount += 1;
    });
    expect(graphRequestCount).toBe(0);
    await capture(page, testInfo, "05-issues-preloaded-by-focus");
  });

  await test.step("preview-route:dependencies", async () => {
    const dependenciesButton = page.getByRole("tab", { name: "Dependencies" });
    let releaseGraph!: () => void;
    let graphRequested!: () => void;
    const graphGate = new Promise<void>((resolve) => (releaseGraph = resolve));
    const graphRequest = new Promise<void>((resolve) => (graphRequested = resolve));
    await page.route(graphChunkPattern, async (route) => {
      graphRequested();
      await graphGate;
      await route.continue();
    });
    await dependenciesButton.focus();
    await graphRequest;
    await dependenciesButton.hover();
    expect(graphRequestCount).toBe(1);
    await page.getByRole("tab", { name: "Dependencies" }).click();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-busy", "true");
    await capture(page, testInfo, "06-dependency-graph-loading");

    await page.getByRole("tab", { name: "List" }).click();
    await expect(page.getByRole("heading", { name: "Watched issues" })).toBeVisible();
    await dependenciesButton.click();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-busy", "true");
    releaseGraph();
    await expect(
      page.getByRole("group", { name: /Dependency graph with \d+ nodes/ }),
    ).toBeVisible();
    expect(graphRequestCount).toBe(1);
    await capture(page, testInfo, "07-dependency-graph");
  });

  await test.step("preview-route:retro", async () => {
    await page.getByRole("button", { name: "Retro" }).click();
    await expect(page.getByRole("heading", { name: "Retro", exact: true })).toBeVisible();
    await capture(page, testInfo, "08-retro");
  });

  await test.step("preview-route:settings", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "09-settings");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await capture(page, testInfo, "10-overview-mobile");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Retro" }).hover();
  await capture(page, testInfo, "11-navigation-hover");
});

test("keeps the shell visible when a lazy chunk fails", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.route(/\/assets\/RetroView-[^/]+\.js$/, (route) =>
    route.abort("failed"),
  );

  await page.getByRole("button", { name: "Retro" }).dispatchEvent("click");
  await expect(page.getByRole("alert")).toContainText("Unable to load Retro");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await capture(page, testInfo, "12-retro-chunk-error");
});
