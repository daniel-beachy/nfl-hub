import { z } from "zod";
import type { TeamMetric } from "../../shared/ids.ts";
import { teamFromEspnId } from "../../shared/teams.ts";
import { defineAdapter, type ParsedSource } from "./types.ts";

// ESPN Football Power Index: ESPN's own season forecast. See docs/SOURCES.md.
// One request returns all 32 teams, each with a list of named stats.

const payload = z.object({
  items: z.array(
    z.object({
      team: z.object({ $ref: z.string() }),
      season: z.number(),
      lastUpdated: z.string(),
      // `value` is missing for stats ESPN has not computed yet.
      predictives: z.array(z.object({ name: z.string(), value: z.number().optional() })),
    }),
  ),
});

/** Our metric -> ESPN stat name. Probabilities arrive as percentages. */
const STATS: Record<Exclude<TeamMetric, "seed1">, { name: string; scale: number }> = {
  superBowl: { name: "probwintitle", scale: 0.01 },
  conference: { name: "probmaketitlegame", scale: 0.01 }, // reaching the title game = winning the conference
  division: { name: "probwindiv", scale: 0.01 },
  playoffs: { name: "probmakeplayoffs", scale: 0.01 },
  wins: { name: "projectedw", scale: 1 },
};

export const espnFpi = defineAdapter({
  id: "espn-fpi",
  name: "ESPN FPI",
  kind: "forecast",
  tier: "standard",
  expects: { teams: ["superBowl", "conference", "division", "playoffs", "wins"], awards: [] },
  payload,

  fetch: ({ http, season }) =>
    http.getJson(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex?limit=50`),

  parse(data) {
    const out: ParsedSource = { season: data.items[0]?.season ?? null, observedAt: null, teams: {}, awards: {}, issues: [] };
    let latest = 0;
    for (const item of data.items) {
      const espnId = /\/teams\/(\d+)/.exec(item.team.$ref)?.[1];
      const team = espnId ? teamFromEspnId(espnId) : undefined;
      if (!team) {
        out.issues.push({ kind: "unknown-name", message: `Unknown ESPN team reference ${item.team.$ref}`, httpStatus: null });
        continue;
      }
      const stats = new Map(item.predictives.map((p) => [p.name, p.value]));
      for (const [metric, stat] of Object.entries(STATS) as [TeamMetric, { name: string; scale: number }][]) {
        const value = stats.get(stat.name);
        if (value !== undefined) (out.teams[metric] ??= {})[team.id] = value * stat.scale;
      }
      const updated = Date.parse(item.lastUpdated);
      if (updated > latest) latest = updated;
    }
    if (latest > 0) out.observedAt = new Date(latest).toISOString();
    return out;
  },
});
