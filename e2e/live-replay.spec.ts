import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// M2-4 done-when: `?replay=` works in the browser. The finished game is the committed
// fixture (a real ESPN summary, SF 46 at DAL 40), answered in place of ESPN, so the whole
// path runs: fetch, validation, the feed's polling and the page.

const body = readFileSync(join(import.meta.dirname, "../app/src/lib/espn/fixtures/summary-401873063.json"), "utf8");
const plays = (JSON.parse(body) as { drives: { previous: { plays: { id: string; homeScore: number; awayScore: number }[] }[] } }).drives.previous.flatMap((d) => d.plays);

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
    return { score: score.querySelector("strong")!.textContent, state: score.dataset.state, last: score.dataset.lastPlay, first: document.querySelector<HTMLElement>("[data-play]")?.dataset.play ?? "" };
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
    expect(now).toEqual({ score: `${play.awayScore}–${play.homeScore}`, state: "in", last: play.id, first: play.id });
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
  await expect(page.locator('[data-testid="score"]')).toHaveAttribute("data-state", "post");
  await expect(page.locator('[data-testid="score"] strong')).toHaveText("46–40");
  await expect(page.locator("[data-play]").first()).toContainText("END GAME");
  await page.getByRole("link", { name: "All games" }).click();
  await expect(tile).toBeVisible();
});

test("a replay that cannot load says so", async ({ page }) => {
  await page.route(/site\.api\.espn\.com/, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }));
  await page.goto("./#/live?replay=1");
  await expect(page.getByText("This replay could not be loaded")).toBeVisible();
});
