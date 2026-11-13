import { z } from "zod";
import { CONFERENCES, DIVISION_IDS } from "../../shared/ids.ts";
import { TEAM_IDS, teamsInConference, teamsInDivision, type TeamId } from "../../shared/teams.ts";
import type { Http } from "../lib/http.ts";
import { defineAdapter, type ParsedSource, type SourceAdapter } from "./types.ts";

// Helpers for tests only: a fake adapter and well-formed values to bend.

export const even = (teams: readonly TeamId[], total: number): Partial<Record<TeamId, number>> =>
  Object.fromEntries(teams.map((t) => [t, total / teams.length]));

/** A full, internally consistent set of raw values with `vig` extra probability per group. */
export function fullTeams(vig = 0): ParsedSource["teams"] {
  const perGroup = <G>(groups: readonly G[], members: (g: G) => { id: TeamId }[]) =>
    Object.assign({}, ...groups.map((g) => even(members(g).map((t) => t.id), 1 + vig))) as Partial<Record<TeamId, number>>;
  return {
    superBowl: even(TEAM_IDS, 1 + vig),
    conference: perGroup(CONFERENCES, teamsInConference),
    division: perGroup(DIVISION_IDS, teamsInDivision),
    playoffs: even(TEAM_IDS, 14),
    wins: even(TEAM_IDS, 272),
  };
}

export const parsed = (over: Partial<ParsedSource> = {}): ParsedSource => ({
  season: 2026, observedAt: null, teams: fullTeams(), awards: {}, issues: [], ...over,
});

/** An adapter whose fetch returns (or throws) whatever the test hands it. */
export function fakeAdapter(over: Partial<SourceAdapter> & { result?: () => ParsedSource | Promise<never> } = {}): SourceAdapter {
  const { result = () => parsed(), ...rest } = over;
  return {
    ...defineAdapter({
      id: "polymarket",
      name: "Fake",
      kind: "market",
      tier: "standard",
      expects: { teams: ["superBowl", "conference", "division", "playoffs"], awards: [] },
      payload: z.object({ value: z.custom<ParsedSource>((v) => typeof v === "object" && v !== null) }),
      fetch: async () => ({ value: await result() }),
      parse: (data) => data.value,
    }),
    ...rest,
  };
}

export const noHttp: Http = {
  getJson: async () => {
    throw new Error("tests must not use the network");
  },
};
