import { expect, test } from "@playwright/test";
import { serveFixtures } from "./data.ts";

// M1-7 done-when: every Outlook chart in plan 8.1 renders for 2026 and 2022, with lines
// and source tabs, and never an empty chart or a "not available" message.

const TITLES = [
  "Win the Super Bowl",
  "Make the Super Bowl: AFC",
  "Make the Super Bowl: NFC",
  ...["AFC", "NFC"].flatMap((c) => ["East", "North", "South", "West"].map((d) => `${c} ${d}`)),
  "Make the playoffs: AFC",
  "Make the playoffs: NFC",
  "Projected wins",
  "Earn the 1 seed: AFC",
  "Earn the 1 seed: NFC",
];

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => {
    throw err;
  });
  await serveFixtures(page);
});

for (const season of [2026, 2022]) {
  test(`every Outlook chart renders for ${season}`, async ({ page }) => {
    await page.goto(`./#/season?season=${season}`);
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveValue(String(season));
    for (const title of TITLES) {
      const card = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) }) });
      await expect(card, title).toHaveCount(1);
      await expect(card.getByRole("tab", { selected: true }), title).toHaveCount(1);
      expect(await card.locator("svg g[data-line]").count(), title).toBeGreaterThan(1);
    }
    await expect(page.getByText(/not available|no numbers/i)).toHaveCount(0);
    const note = page.getByText(/Hub Model only/);
    await expect(note).toHaveCount(season < 2026 ? 1 : 0);
    if (season < 2026) await expect(page.getByRole("tab", { selected: true }).first()).toHaveAccessibleName("Hub Model");
  });
}

test("the season selector switches season and keeps it in the URL", async ({ page }) => {
  await page.goto("./#/season?season=2026");
  await page.getByRole("combobox", { name: "Season" }).selectOption("2022");
  await expect(page).toHaveURL(/season=2022/);
  await expect(page.getByText(/Hub Model only/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Season" })).toHaveValue("2022");
});

for (const season of [2026, 2022]) {
  test(`standings list all 32 teams with hub odds for ${season}`, async ({ page }) => {
    await page.goto(`./#/season?season=${season}`);
    await page.getByRole("group", { name: "Season view" }).getByRole("button", { name: "Standings" }).click();
    await expect(page).toHaveURL(new RegExp(`#/season/standings\\?season=${season}$`));
    await expect(page.locator("tr[data-team]")).toHaveCount(32);
    await expect(page.getByText(/Hub Model as of/)).toBeVisible();
    await expect(page.locator('tr[data-team="KC"] td').first()).toHaveText(/^\d+\.\d$/);
  });
}

for (const season of [2026, 2022]) {
  test(`leaders show every category and a season race for ${season}`, async ({ page }) => {
    await page.goto(`./#/season/leaders?season=${season}`);
    await expect(page.locator("ol[data-category]")).toHaveCount(12);
    await expect(page.locator('ol[data-category="passingYards"] li')).toHaveCount(10);
    const race = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Season race" }) });
    await expect(race.locator("svg g[data-line]")).toHaveCount(10);
    await race.getByRole("combobox", { name: "Stat" }).selectOption("sacks");
    await expect(race.getByRole("img")).toHaveAccessibleName(/^Sacks/);
  });
}
