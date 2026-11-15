import { useEffect } from "react";
import { readableColor } from "../../../shared/colors.ts";
import { getTeam, type TeamId } from "../../../shared/teams.ts";
import { usePrefs, type Prefs } from "../lib/prefs.ts";

export type Theme = Prefs["theme"];

/** The --surface token of each theme (tokens.css); team colors are made readable on it. */
export const SURFACE: Record<Theme, string> = { dark: "14181e", light: "ffffff" };

/**
 * Teams drawn in a color other than their primary, so that no two division rivals look
 * alike on a chart (QA S17). Mostly the team's own alternate. Still passed through
 * `readableColor`, so each is adjusted for the theme.
 */
const CHART_COLOR: Partial<Record<TeamId, string>> = {
  NE: "c60c30", // navy like Buffalo's blue
  DAL: "b0b7bc", // navy like the Giants' blue
  SEA: "69be28", // navy like the Rams' blue
  PHI: "046a38", // midnight green reads as the Giants' blue on light; this is their kelly green
  SF: "b3995d", // red like Arizona
  TB: "ff7900", // red like Atlanta
  CHI: "e64100", // navy like Detroit's blue
  DEN: "fc4c02", // navy like the Chargers' blue
};

const cache = new Map<string, string>();

/**
 * The color to draw a team in: its own color where that is readable on the theme's
 * surface, otherwise its alternate or a lightened or darkened version. Always use this,
 * never `team.color` directly (several teams are black or navy).
 */
export function teamColor(id: TeamId, theme: Theme): string {
  const key = `${id}:${theme}`;
  let color = cache.get(key);
  if (!color) {
    const team = getTeam(id);
    color = `#${readableColor(CHART_COLOR[id] ?? team.color, team.altColor, SURFACE[theme])}`;
    cache.set(key, color);
  }
  return color;
}

/** Keeps <html> in step with the preferences: the theme and the favorite team's color. */
export function useApplyTheme(): void {
  const { theme, favoriteTeam } = usePrefs();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (favoriteTeam) root.style.setProperty("--team", teamColor(favoriteTeam, theme));
    else root.style.removeProperty("--team");
  }, [theme, favoriteTeam]);
}

/** The current theme and a team-color lookup bound to it, for charts. */
export function useTeamColors(): { theme: Theme; colorOf: (id: TeamId) => string } {
  const { theme } = usePrefs();
  return { theme, colorOf: (id) => teamColor(id, theme) };
}
