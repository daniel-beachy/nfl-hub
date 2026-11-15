import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, MIN_CONTRAST } from "../../../shared/colors.ts";
import { TEAM_IDS } from "../../../shared/teams.ts";
import { SURFACE, teamColor } from "./theme.ts";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("theme", () => {
  it("SURFACE mirrors the --surface tokens", () => {
    const surfaces = [...tokens.matchAll(/--surface:\s*#([0-9a-f]{6})/g)].map((m) => m[1]);
    expect(surfaces).toEqual([SURFACE.dark, SURFACE.light]);
  });
  it("every team is readable on both themes", () => {
    for (const theme of ["dark", "light"] as const)
      for (const id of TEAM_IDS)
        expect(contrast(teamColor(id, theme).slice(1), SURFACE[theme]), `${id} on ${theme}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});
