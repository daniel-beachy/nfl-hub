import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { serveFixtures } from "./data.ts";

// M1-9 done-when: the status page matches status.json, row for row.

const status = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/data/status.json"), "utf8")) as {
  sources: { id: string; status: string; error: { kind: string } | null; issue: number | null }[];
  stages: { id: string; status: string }[];
};

test("every source and stage in status.json has a row with its status", async ({ page }) => {
  page.on("pageerror", (err) => {
    throw err;
  });
  await serveFixtures(page, (path, json) => {
    // Give one source an open issue so the link is checked too (structure only, not a value shown as data).
    if (path === "status.json") (json as typeof status).sources[0]!.issue = 99;
    return json;
  });
  await page.goto("./#/status");
  await expect(page.getByRole("heading", { level: 1, name: "Data status" })).toBeVisible();
  for (const s of status.sources) {
    const row = page.locator(`[data-source="${s.id}"]`);
    await expect(row).toContainText(s.status);
    if (s.error) await expect(row).toContainText(s.error.kind);
  }
  for (const s of status.stages) await expect(page.locator(`[data-stage="${s.id}"]`)).toContainText(s.status);
  await expect(page.locator("[data-source]")).toHaveCount(status.sources.length);
  await expect(page.locator("[data-stage]")).toHaveCount(status.stages.length);
  await expect(page.locator(`[data-source="${status.sources[0]!.id}"]`).getByRole("link", { name: "Issue #99" })).toHaveAttribute("href", /\/issues\/99$/);
  // The footer link reaches it from anywhere.
  await page.goto("./#/season");
  await page.getByRole("link", { name: "Data status" }).click();
  await expect(page).toHaveURL(/#\/status$/);
});
