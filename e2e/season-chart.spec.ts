import { expect, test, type Locator, type Page } from "@playwright/test";
import { serveFixtures } from "./data.ts";

// The test that matters most (plan 8.2, M1-6): switching a chart's source changes only
// its lines. Isolated teams, span, resolution, the tapped day and the page's scroll
// position all survive; the choice is remembered; a remembered source that has no data
// falls back to the first tab without a word. Dan's main complaint about the old tracker
// was exactly this, so it is checked in a real browser at phone and desktop widths.

const TITLE = "Win the Super Bowl";

function chartCard(page: Page, title = TITLE): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) }) });
}
const tabs = (card: Locator) => card.getByRole("tablist");
const selectedTab = (card: Locator) => tabs(card).getByRole("tab", { selected: true });
const chip = (card: Locator, team: string) => card.getByRole("group", { name: /Tap to isolate/ }).getByRole("button", { name: new RegExp(`^${team}(?![A-Z])`) });
const lineIds = (card: Locator) => card.locator("svg g[data-line]").evaluateAll((els) => els.map((e) => e.getAttribute("data-line")).sort());
const linePath = (card: Locator, id: string) => card.locator(`svg g[data-line="${id}"] path`).evaluateAll((els) => els.map((e) => e.getAttribute("d")).join(" "));
const pressed = (card: Locator, group: string, name: string) => card.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

async function open(page: Page) {
  await page.goto("./#/season?season=2026");
  await expect(selectedTab(chartCard(page))).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => {
    throw err;
  });
  await serveFixtures(page);
});

test("switching source keeps the view, is remembered, and falls back silently", async ({ page }, info) => {
  const touch = info.project.use.hasTouch === true;
  await open(page);
  const card = chartCard(page);

  // The default is the first tab, which is Consensus wherever markets have data.
  await expect(tabs(card).getByRole("tab").first()).toHaveAccessibleName("Consensus");
  await expect(selectedTab(card)).toHaveAccessibleName("Consensus");

  // Set up a view: two teams isolated, the last 8 weeks, daily points.
  await chip(card, "KC").click();
  await chip(card, "BUF").click();
  await pressed(card, "How far back", "8 wk").click();
  await pressed(card, "Resolution", "Daily").click();

  // On a phone, tap a day on the chart; the tooltip must survive the switch too. (With a
  // mouse the tooltip follows the pointer and goes away when it leaves, by design.)
  let tappedDay: string | null = null;
  if (touch) {
    await card.locator('svg rect[fill="transparent"]').tap();
    tappedDay = await card.getByRole("status").locator("div").first().textContent();
    expect(tappedDay).toBeTruthy();
  }

  // Scroll the page so the tab row sits near the top, then switch from there.
  await page.evaluate(() => window.scrollTo(0, 0));
  const tabTop = await tabs(card).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, tabTop - 120));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);

  const teamsBefore = await lineIds(card);
  const kcBefore = await linePath(card, "KC");
  // A phone switches by touch; a mouse click there would also move the mouse off the
  // chart, which clears a mouse hover on purpose.
  const espn = tabs(card).getByRole("tab", { name: "ESPN FPI" });
  await (touch ? espn.tap() : espn.click());

  // Only the data changed.
  await expect(selectedTab(card)).toHaveAccessibleName("ESPN FPI");
  await expect(card.getByRole("img")).toHaveAccessibleName(`${TITLE}, ESPN FPI`);
  expect(await linePath(card, "KC")).not.toBe(kcBefore);
  expect(await lineIds(card)).toEqual(teamsBefore);
  await expect(chip(card, "KC")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(card, "BUF")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(card, "SF")).toHaveAttribute("aria-pressed", "false");
  await expect(pressed(card, "How far back", "8 wk")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(card, "Resolution", "Daily")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  if (touch) await expect(card.getByRole("status").locator("div").first()).toHaveText(tappedDay!);

  // The choice is remembered across a reload (the view itself starts fresh).
  await page.reload();
  await expect(selectedTab(chartCard(page))).toHaveAccessibleName("ESPN FPI");

  // If the remembered source has no data, the chart shows the first tab, with no message.
  await page.unroute(/\/data\//);
  await serveFixtures(page, (path, json) => {
    const file = json as { metrics: { superBowl: Record<string, unknown> } };
    if (path.startsWith("season/")) delete file.metrics.superBowl["espn-fpi"];
    return file;
  });
  await page.reload();
  const after = chartCard(page);
  await expect(selectedTab(after)).toHaveAccessibleName("Consensus");
  await expect(tabs(after).getByRole("tab", { name: "ESPN FPI" })).toHaveCount(0);
  await expect(page.getByText(/not available/i)).toHaveCount(0);
  await expect(after.locator("svg g[data-line]")).toHaveCount(32);
});

test("the source info popover explains the chosen source", async ({ page }) => {
  await open(page);
  const card = chartCard(page);
  await card.getByRole("button", { name: "About Consensus" }).click();
  const popover = card.locator("[popover]");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Median of markets");
  await expect(popover).toContainText(/Last captured|Stale since/);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // It follows the tab: switch and it describes the new source.
  await tabs(card).getByRole("tab", { name: "Hub Model" }).click();
  await card.getByRole("button", { name: "About Hub Model" }).click();
  await expect(card.locator("[popover]")).toContainText("Elo ratings");
});

test("compare mode draws one line per source for the one isolated team", async ({ page }) => {
  await open(page);
  const card = chartCard(page);
  await expect(card.getByRole("button", { name: "Compare sources" })).toHaveCount(0);

  await chip(card, "KC").click();
  await card.getByRole("button", { name: "Compare sources" }).click();
  await expect(card.getByRole("heading", { level: 2 })).toContainText("KC across sources");
  const ids = await lineIds(card);
  expect(ids.length).toBeGreaterThan(1);
  for (const id of ids) expect(["consensus", "espn-fpi", "hub", "draftkings", "polymarket", "kalshi", "bovada"]).toContain(id);
  await expect(card.getByRole("img")).toHaveAccessibleName(`${TITLE}, KC across sources`);

  // Off again: back to team lines, KC still isolated.
  await card.getByRole("button", { name: "Compare sources" }).click();
  await expect(card.locator("svg g[data-line]")).toHaveCount(32);
  await expect(chip(card, "KC")).toHaveAttribute("aria-pressed", "true");

  // Isolating a second team quietly leaves compare mode.
  await card.getByRole("button", { name: "Compare sources" }).click();
  await chip(card, "BUF").click();
  await expect(card.getByRole("button", { name: "Compare sources" })).toHaveCount(0);
  await expect(card.locator("svg g[data-line]")).toHaveCount(32);
});

test("a remembered source at the end of the tab row is scrolled into view", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nfl-hub:prefs:v1", JSON.stringify({ sources: { superBowl: "bovada" } })));
  await open(page);
  const card = chartCard(page);
  await expect(selectedTab(card)).toHaveAccessibleName(/^Bovada/);
  await expect(selectedTab(card)).toBeInViewport({ ratio: 0.9 });
});
