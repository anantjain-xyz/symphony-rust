import { expect, test } from "@playwright/test";

test("saved dark theme paints dark before the React module loads", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("symphony-theme", "dark"));

  let moduleRequested = false;

  await page.route("**/assets/index-*.js", async (route) => {
    moduleRequested = true;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "",
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(moduleRequested).toBe(true);

  await expect
    .poll(() =>
      page.evaluate(() => ({
        classIsDark: document.documentElement.classList.contains("dark"),
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        background: getComputedStyle(document.documentElement).backgroundColor,
      })),
    )
    .toEqual({
      classIsDark: true,
      theme: "dark",
      colorScheme: "dark",
      background: "rgb(9, 9, 11)",
    });

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("saved-dark-first-frame.png"),
  });
  expect(screenshot.byteLength).toBeGreaterThan(0);
});

test("theme toggle updates both rendered color schemes", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("symphony-theme", "light"));
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("light-browser-preview.png"),
  });

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe("dark");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("dark-after-toggle.png"),
  });
});
