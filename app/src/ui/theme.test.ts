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

// Rough "would Dan mix these two lines up": distance in RGB. Above 55 the hues differ plainly (the closest pair is the Colts' navy and the Jaguars' teal on light).
const distance = (a: string, b: string) => Math.hypot(...[1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));

describe("division rivals", () => {
  it.each(["dark", "light"] as const)("are told apart on the %s theme", async (theme) => {
    const { DIVISION_IDS } = await import("../../../shared/ids.ts");
    const { teamsInDivision } = await import("../../../shared/teams.ts");
    for (const d of DIVISION_IDS) {
      const teams = teamsInDivision(d);
      for (const a of teams) for (const b of teams) if (a.id < b.id) expect(distance(teamColor(a.id, theme), teamColor(b.id, theme)), `${a.id} v ${b.id} on ${theme}`).toBeGreaterThan(55);
    }
  });
});
