import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// M2-4 done-when: `?replay=` works in the browser. The finished game is the committed
// fixture (a real ESPN summary, SF 46 at DAL 40), answered in place of ESPN, so the whole
// path runs: fetch, validation, the feed's polling and the page.

const body = readFileSync(join(import.meta.dirname, "../app/src/lib/espn/fixtures/summary-401873063.json"), "utf8");
const plays = (JSON.parse(body) as { drives: { previous: { plays: { id: string; wallclock: string; homeScore: number; awayScore: number }[] }[] } }).drives.previous.flatMap((d) => d.plays);

async function open(page: Page, hash: string) {
  page.on("pageerror", (err) => {
    throw err;
  });
  let requests = 0;
  await page.route(/site\.api\.espn\.com/, (route) => {
    requests++;
    // Only the one summary may be asked for; a replay never polls ESPN.
    if (!route.request().url().includes("/summary?event=401873063")) return route.abort();
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body });
  });
  await page.goto(`./#/live${hash}`);
  return () => requests;
}

/** What the page shows right now, read in one go so it cannot change in between. */
const shown = (page: Page) =>
  page.evaluate(() => {
    const score = document.querySelector<HTMLElement>('[data-testid="score"]')!;
    return {
      score: score.querySelector("strong")!.textContent,
      state: score.dataset.state,
      last: score.dataset.lastPlay,
      first: document.querySelector<HTMLElement>("[data-play]")?.dataset.play ?? "",
      cutoff: Number(score.dataset.cutoff),
      text: document.querySelector("main")!.textContent ?? "",
    };
  });

test("a replayed game advances play by play with the score its plays imply", async ({ page }) => {
  const requests = await open(page, "/game/401873063?replay=401873063&speed=300&from=600");
  await expect(page.getByText("Replay at 300x")).toBeVisible();
  await expect(page.locator("[data-play]").first()).toBeVisible();
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) {
    const now = await shown(page);
    const at = plays.findIndex((p) => p.id === now.last);
    const play = plays[at]!;
    expect(now).toMatchObject({ score: `${play.awayScore}–${play.homeScore}`, state: "in", last: play.id, first: play.id });
    seen.push(at);
    // Wait for the game to move on.
    await expect(page.locator('[data-testid="score"]')).not.toHaveAttribute("data-last-play", now.last!);
  }
  expect(seen[0]).toBeGreaterThan(10);
  expect(seen[2]).toBeGreaterThan(seen[0]!);
  expect(requests()).toBe(1);
});

test("a replay reaches the final score, and the slate lists the game", async ({ page }) => {
  await open(page, "?replay=401873063&speed=100000");
  const tile = page.locator('[data-game="401873063"]');
  await expect(tile).toContainText("49ers at Cowboys");
  await expect(tile).toContainText("Final");
  await expect(tile).toContainText("46–40");
  await tile.click();
  await expect(page).toHaveURL(/#\/live\/game\/401873063\?replay=401873063&speed=100000$/);
  await expect(page.locator('[data-testid="score"]')).toHaveAttribute("data-state", "final");
  await expect(page.locator('[data-testid="score"] strong')).toHaveText("46–40");
  await expect(page.locator("[data-play]").first()).toContainText("END GAME");
  await page.getByRole("link", { name: "All games" }).click();
  await expect(tile).toBeVisible();
});

// M2-2 done-when: with a delay set, no element shows data newer than the delay.
test("with a delay, the page is exactly the game as it stood that long ago", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nfl-hub:prefs:v1", JSON.stringify({ liveDelaySeconds: 240, liveDelayOn: true })));
  await open(page, "/game/401873063?replay=401873063&speed=120&from=2400");
  await expect(page.getByTestId("delay")).toContainText("Delayed 240 s");
  await expect(page.locator("[data-play]").first()).toBeVisible();
  for (let i = 0; i < 4; i++) {
    const now = await shown(page);
    // The truth at the page's own cutoff, from the fixture.
    const visible = plays.filter((p) => Date.parse(p.wallclock) <= now.cutoff);
    const truth = visible.at(-1)!;
    expect(now).toMatchObject({ last: truth.id, first: truth.id, score: `${truth.awayScore}–${truth.homeScore}`, state: "in" });
    // The feed already holds later plays (240 game seconds of them); none is on the page.
    expect(plays.length).toBeGreaterThan(visible.length + 2);
    const ids = await page.locator("[data-play]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.play));
    const allowed = new Set(visible.map((p) => p.id));
    expect(ids.filter((id) => !allowed.has(id!) && Date.parse(plays.find((p) => p.id === id)!.wallclock) > now.cutoff + 2000)).toEqual([]);
    await expect(page.locator('[data-testid="score"]')).not.toHaveAttribute("data-last-play", now.last!);
  }

  // Sync to my TV: tap a play, and the delay becomes the one that makes it the newest shown.
  await page.getByRole("button", { name: "Sync to my TV" }).click();
  const target = page.locator("[data-sync-play]").nth(2);
  const id = await target.getAttribute("data-sync-play");
  await target.click();
  await expect(page.getByTestId("delay")).not.toContainText("Delayed 240 s");
  await expect(page.getByTestId("delay")).toContainText(/Delayed \d+ s/);
  const chosen = Number(await page.getByTestId("delay").getAttribute("data-delay"));
  const after = await shown(page);
  expect(plays.findIndex((p) => p.id === after.last)).toBeGreaterThanOrEqual(plays.findIndex((p) => p.id === id) - 1);
  await page.getByRole("button", { name: "5 seconds more delay" }).click();
  await expect(page.getByTestId("delay")).toHaveAttribute("data-delay", String(chosen + 5));
  // The choice is remembered; "Live" turns the delay off without forgetting it.
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByTestId("delay")).toContainText("Live, no delay");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("nfl-hub:prefs:v1")!))).toMatchObject({ liveDelaySeconds: chosen + 5, liveDelayOn: false });
});

test("a replay that cannot load says so", async ({ page }) => {
  await page.route(/site\.api\.espn\.com/, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }));
  await page.goto("./#/live?replay=1");
  await expect(page.getByText("This replay could not be loaded")).toBeVisible();
});
