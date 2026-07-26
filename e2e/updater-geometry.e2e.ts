import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

type Box = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

async function boxes(button: Locator, icon: Locator): Promise<[Box, Box]> {
  const [buttonBox, iconBox] = await Promise.all([
    button.boundingBox(),
    icon.boundingBox(),
  ]);
  expect(buttonBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  return [buttonBox!, iconBox!];
}

function center(box: Box) {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function expectIconAtCircleCenter(buttonBox: Box, iconBox: Box) {
  const iconCenter = center(iconBox);
  const circleCenter = {
    x:
      buttonBox.width <= buttonBox.height + 2
        ? buttonBox.x + buttonBox.width / 2
        : buttonBox.x + buttonBox.height / 2,
    y: buttonBox.y + buttonBox.height / 2,
  };
  const tolerance = Math.max(2, buttonBox.height * 0.08);
  expect(Math.abs(iconCenter.x - circleCenter.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(iconCenter.y - circleCenter.y)).toBeLessThanOrEqual(tolerance);
}

test("centers the updater icon in its circle through hover and focus transitions", async ({
  page,
}) => {
  await page.goto("/?preview=updater");
  await expect(
    page.locator('[data-preview-fixture="updater-geometry"]'),
  ).toBeVisible();
  const button = page.getByRole("button", {
    name: "Update Symphony to vpreview",
  });
  const icon = button.locator(".update-button-icon");
  await expect(button).toBeVisible();

  let [buttonBox, iconBox] = await boxes(button, icon);
  expect(Math.abs(buttonBox.width - buttonBox.height)).toBeLessThanOrEqual(1);
  expectIconAtCircleCenter(buttonBox, iconBox);

  await button.hover();
  await expect
    .poll(async () => (await button.boundingBox())?.width ?? 0)
    .toBeGreaterThan(71);
  [buttonBox, iconBox] = await boxes(button, icon);
  expectIconAtCircleCenter(buttonBox, iconBox);

  await page.mouse.move(300, 300);
  await expect
    .poll(async () => (await button.boundingBox())?.width ?? Infinity)
    .toBeLessThan(20);
  [buttonBox, iconBox] = await boxes(button, icon);
  expectIconAtCircleCenter(buttonBox, iconBox);

  await button.focus();
  await expect
    .poll(async () => (await button.boundingBox())?.width ?? 0)
    .toBeGreaterThan(71);
  [buttonBox, iconBox] = await boxes(button, icon);
  expectIconAtCircleCenter(buttonBox, iconBox);

  await button.evaluate((element) => element.blur());
  await expect
    .poll(async () => (await button.boundingBox())?.width ?? Infinity)
    .toBeLessThan(20);
  [buttonBox, iconBox] = await boxes(button, icon);
  expect(Math.abs(buttonBox.width - buttonBox.height)).toBeLessThanOrEqual(1);
  expectIconAtCircleCenter(buttonBox, iconBox);
});
