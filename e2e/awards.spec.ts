import { expect, test } from "@playwright/test";
import { serveFixtures } from "./data.ts";

// M1-7: award charts over awards[market][source].candidates, with the same source-tab rules.

const AWARDS = ["MVP", "Offensive Player of the Year", "Defensive Player of the Year", "Offensive Rookie of the Year", "Defensive Rookie of the Year", "Coach of the Year", "Comeback Player of the Year"];

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => {
    throw err;
  });
  await serveFixtures(page);
});

test("every award chart renders for 2026 and a source switch keeps the isolated player", async ({ page }) => {
  await page.goto("./#/season?season=2026");
  await page.getByRole("group", { name: "Season view" }).getByRole("button", { name: "Awards" }).click();
  await expect(page).toHaveURL(/#\/season\/awards\?season=2026$/);
  for (const title of AWARDS) {
    const card = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) }) });
    await expect(card, title).toHaveCount(1);
    expect(await card.locator("svg g[data-line]").count(), title).toBeGreaterThan(1);
  }
  await expect(page.getByText(/not available|no numbers/i)).toHaveCount(0);

  const mvp = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: /^MVP/ }) });
  const first = mvp.getByRole("group", { name: /Tap to isolate/ }).getByRole("button").first();
  const name = await first.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim());
  expect(name.length).toBeGreaterThan(2);
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  const tabs = mvp.getByRole("tablist").getByRole("tab");
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(mvp.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-pressed", "true");
});

test("seasons without award odds have no Awards view", async ({ page }) => {
  await page.goto("./#/season?season=2022");
  await expect(page.getByRole("heading", { level: 2, name: /^Win the Super Bowl/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Awards" })).toHaveCount(0);
  await page.goto("./#/season/awards?season=2022");
  await expect(page).toHaveURL(/#\/season\?season=2022$/);
});
