import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Answers every ./data/ request from e2e/fixtures/data, so the suite runs on real
// published files without the network. `edit` changes a file's JSON for one test
// (for example removing a source); a path with no fixture gets a 404, as on Pages.

const ROOT = join(import.meta.dirname, "fixtures", "data");

export type Edit = (path: string, json: unknown) => unknown;

export async function serveFixtures(page: Page, edit?: Edit): Promise<void> {
  await page.route(/\/data\//, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*?\/data\//, "");
    const file = join(ROOT, path);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(edit ? edit(path, json) : json) });
  });
}
