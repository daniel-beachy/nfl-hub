import { z } from "zod";

// The parts of ESPN's undocumented scoreboard and summary responses that Live relies on
// (plan 9.2). Everything else in the payload is ignored and stripped.
//
// Two levels of strictness:
// - The frame of a response (which game, which two teams, its state) is required. Without
//   it the whole response is dropped and the last good one stays on screen.
// - List items (plays, drives, events, win-probability points) are checked one by one. A
//   single odd item is left out and counted in `dropped`, so one strange play cannot blank
//   a game. Optional blocks (box score, situation) that fail are treated as absent.
//
// `parseSummary` and `parseScoreboard` return the same shape they accept, trimmed, so
// their output is also what the test fixtures store (`npm run live-fixture`).

const teamRef = z.object({ id: z.string() });
const state = z.enum(["pre", "in", "post"]);

const spot = z.object({
  down: z.number().optional(),
  distance: z.number().optional(),
  yardLine: z.number().optional(),
  yardsToEndzone: z.number().optional(),
  shortDownDistanceText: z.string().optional(),
  possessionText: z.string().optional(),
  team: teamRef.optional(),
});

const play = z.object({
  id: z.string(),
  type: z.object({ id: z.string(), text: z.string(), abbreviation: z.string().optional() }).optional(),
  text: z.string().optional(),
  homeScore: z.number(),
  awayScore: z.number(),
  period: z.object({ number: z.number() }),
  clock: z.object({ displayValue: z.string() }),
  scoringPlay: z.boolean().optional(),
  scoringType: z.object({ name: z.string(), abbreviation: z.string().optional() }).optional(),
  /** When the play happened in the real world; what the spoiler delay cuts on (plan 9.3). */
  wallclock: z.string().optional(),
  isPenalty: z.boolean().optional(),
  isTurnover: z.boolean().optional(),
  statYardage: z.number().optional(),
  start: spot.optional(),
  end: spot.optional(),
});
export type EspnPlay = z.infer<typeof play>;

const driveFrame = z.object({
  id: z.string(),
  team: teamRef.optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  displayResult: z.string().optional(),
  isScore: z.boolean().optional(),
  yards: z.number().optional(),
  offensivePlays: z.number().optional(),
  plays: z.array(z.unknown()).catch([]),
});
export type EspnDrive = Omit<z.infer<typeof driveFrame>, "plays"> & { plays: EspnPlay[] };

const wpPoint = z.object({ playId: z.string(), homeWinPercentage: z.number().min(0).max(1) });

const boxscore = z.object({
  teams: z
    .array(
      z.object({
        team: teamRef,
        statistics: z.array(z.object({ name: z.string(), displayValue: z.string(), label: z.string().optional() })).catch([]),
      }),
    )
    .catch([]),
  players: z
    .array(
      z.object({
        team: teamRef,
        statistics: z
          .array(
            z.object({
              name: z.string(),
              keys: z.array(z.string()).optional(),
              labels: z.array(z.string()),
              athletes: z.array(
                z.object({
                  athlete: z.object({ id: z.string(), displayName: z.string(), jersey: z.string().optional() }),
                  stats: z.array(z.string()),
                }),
              ),
            }),
          )
          .catch([]),
      }),
    )
    .catch([]),
});
export type EspnBoxscore = z.infer<typeof boxscore>;

const competitor = z.object({ homeAway: z.enum(["home", "away"]), team: teamRef, score: z.string().optional() });

const summaryFrame = z.object({
  header: z.object({
    id: z.string(),
    season: z.object({ year: z.number(), type: z.number().optional() }).optional(),
    week: z.number().optional(),
    competitions: z
      .array(
        z.object({
          date: z.string(),
          competitors: z.array(competitor).length(2),
          status: z.object({ type: z.object({ state, detail: z.string().optional(), shortDetail: z.string().optional() }) }),
        }),
      )
      .min(1),
  }),
  // Absent before kickoff. During a game the drive in progress is in `current` and may
  // also be the last entry of `previous`; the normalizer merges them by id.
  drives: z.object({ previous: z.array(z.unknown()).catch([]), current: z.unknown().optional() }).optional().catch(undefined),
  winprobability: z.array(z.unknown()).catch([]),
  boxscore: boxscore.optional().catch(undefined),
});

export type EspnSummary = Omit<z.infer<typeof summaryFrame>, "drives" | "winprobability"> & {
  drives?: { previous: EspnDrive[]; current?: EspnDrive };
  winprobability: z.infer<typeof wpPoint>[];
};

export type Parsed<T> = { ok: true; value: T; dropped: number } | { ok: false; error: string };

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "does not match";
}

/** Keeps the items that match, counts the rest. */
function keep<T>(items: unknown[], schema: z.ZodType<T>, count: { dropped: number }): T[] {
  const out: T[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else count.dropped++;
  }
  return out;
}

function parseDrive(raw: unknown, count: { dropped: number }): EspnDrive | null {
  const frame = driveFrame.safeParse(raw);
  if (!frame.success) {
    count.dropped++;
    return null;
  }
  return { ...frame.data, plays: keep(frame.data.plays, play, count) };
}

export function parseSummary(raw: unknown): Parsed<EspnSummary> {
  const frame = summaryFrame.safeParse(raw);
  if (!frame.success) return { ok: false, error: describe(frame.error) };
  const count = { dropped: 0 };
  const { drives, winprobability, ...rest } = frame.data;
  const value: EspnSummary = { ...rest, winprobability: keep(winprobability, wpPoint, count) };
  if (drives) {
    const previous = drives.previous.map((d) => parseDrive(d, count)).filter((d) => d !== null);
    const current = drives.current === undefined ? null : parseDrive(drives.current, count);
    value.drives = current ? { previous, current } : { previous };
  }
  return { ok: true, value, dropped: count.dropped };
}

// None of `situation` could be checked against a game in progress when this was written
// (2026-11-16, no game on), so every field is optional and a mismatch only loses the
// situation line, never the game.
const situation = z.object({
  down: z.number().optional(),
  distance: z.number().optional(),
  yardLine: z.number().optional(),
  shortDownDistanceText: z.string().optional(),
  possessionText: z.string().optional(),
  isRedZone: z.boolean().optional(),
  possession: z.string().optional(),
  lastPlay: z
    .object({ text: z.string().optional(), probability: z.object({ homeWinPercentage: z.number().min(0).max(1) }).optional() })
    .optional()
    .catch(undefined),
});

const event = z.object({
  id: z.string(),
  date: z.string(),
  competitions: z
    .array(
      z.object({
        competitors: z.array(competitor).length(2),
        status: z.object({
          displayClock: z.string().optional(),
          period: z.number().optional(),
          type: z.object({ state, shortDetail: z.string().optional() }),
        }),
        situation: situation.nullish().catch(undefined),
      }),
    )
    .min(1),
});
export type EspnEvent = z.infer<typeof event>;

const scoreboardFrame = z.object({
  season: z.object({ year: z.number(), type: z.number().optional() }).optional().catch(undefined),
  week: z.object({ number: z.number() }).optional().catch(undefined),
  events: z.array(z.unknown()),
});
export type EspnScoreboard = Omit<z.infer<typeof scoreboardFrame>, "events"> & { events: EspnEvent[] };

export function parseScoreboard(raw: unknown): Parsed<EspnScoreboard> {
  const frame = scoreboardFrame.safeParse(raw);
  if (!frame.success) return { ok: false, error: describe(frame.error) };
  const count = { dropped: 0 };
  return { ok: true, value: { ...frame.data, events: keep(frame.data.events, event, count) }, dropped: count.dropped };
}
