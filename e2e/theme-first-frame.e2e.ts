import { expect, test } from "@playwright/test";

test("saved dark theme paints dark before the React module loads", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("symphony-theme", "dark"));

  let releaseModule!: () => void;
  const moduleReleased = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  let markModuleRequested!: () => void;
  const moduleRequested = new Promise<void>((resolve) => {
    markModuleRequested = resolve;
  });

  await page.route("**/src/main.tsx", async (route) => {
    markModuleRequested();
    await moduleReleased;
    await route.continue();
  });

  const navigation = page.goto("/", { waitUntil: "domcontentloaded" });
  await moduleRequested;

  try {
    await expect
      .poll(() =>
        page.evaluate(() => ({
          classIsDark: document.documentElement.classList.contains("dark"),
          theme: document.documentElement.dataset.theme,
          colorScheme: document.documentElement.style.colorScheme,
        })),
      )
      .toEqual({ classIsDark: true, theme: "dark", colorScheme: "dark" });

    const screenshot = await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("saved-dark-first-frame.png"),
    });
    expect(screenshot.byteLength).toBeGreaterThan(0);
  } finally {
    releaseModule();
    await navigation;
  }
});
