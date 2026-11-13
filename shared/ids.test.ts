import { expect, test } from "vitest";
import { AWARD_MARKETS, SOURCE_IDS, TEAM_METRICS } from "./ids.ts";

test("identifier lists have no duplicates", () => {
  for (const list of [SOURCE_IDS, TEAM_METRICS, AWARD_MARKETS]) {
    expect(new Set(list).size).toBe(list.length);
  }
});
