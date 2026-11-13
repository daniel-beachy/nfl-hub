// The nflverse files the hub uses (docs/PLAN.md 4 and 10.1, docs/SOURCES.md "nflverse").
// Each is a GitHub release asset of nflverse/nflverse-data. Parquet is read with hyparquet;
// every file checked so far (2026-11-13) is Snappy-compressed, which hyparquet reads natively.
//
// `required` columns are the ones later stages rely on. A missing required column fails the
// stage with the column names (nflverse renaming a column is the likely future breakage).
// Add to these lists when a stage starts reading a new column.

export interface Dataset {
  id: DatasetId;
  /** Release tag in nflverse/nflverse-data. */
  tag: string;
  /** Asset file name; per-season datasets get the season. */
  file: (season: number) => string;
  perSeason: boolean;
  required: readonly string[];
}

export const DATASET_IDS = ["pbp", "stats_player", "games", "players"] as const;
export type DatasetId = (typeof DATASET_IDS)[number];

const cols = (s: string) => s.trim().split(/\s+/);

export const DATASETS: Record<DatasetId, Dataset> = {
  pbp: {
    id: "pbp",
    tag: "pbp",
    file: (season) => `play_by_play_${season}.parquet`,
    perSeason: true,
    required: cols(`
      game_id play_id season week season_type posteam defteam home_team away_team
      down ydstogo yardline_100 half_seconds_remaining game_seconds_remaining
      play_type pass rush qb_dropback qb_scramble sack yards_gained
      epa ep wp wpa success cpoe air_yards yards_after_catch complete_pass interception touchdown
      pass_location run_location run_gap passer_player_id rusher_player_id receiver_player_id`),
  },
  // The weekly file. The old `player_stats` release is dead (last updated 2025-05).
  stats_player: {
    id: "stats_player",
    tag: "stats_player",
    file: (season) => `stats_player_week_${season}.parquet`,
    perSeason: true,
    required: cols(`
      player_id player_display_name position position_group headshot_url season week season_type team opponent_team
      completions attempts passing_yards passing_tds passing_interceptions sacks_suffered passing_epa
      carries rushing_yards rushing_tds rushing_epa
      receptions targets receiving_yards receiving_tds receiving_epa
      def_sacks def_interceptions`),
  },
  // Every game since 1999 with results, spreads and ESPN ids: the hub model's only input.
  games: {
    id: "games",
    tag: "schedules",
    file: () => "games.parquet",
    perSeason: false,
    required: cols(`
      game_id season game_type week gameday away_team away_score home_team home_score
      location result spread_line div_game espn`),
  },
  // Player ids across providers: gsis_id is canonical, espn_id joins ESPN and market data.
  players: {
    id: "players",
    tag: "players",
    file: () => "players.parquet",
    perSeason: false,
    required: cols(`gsis_id display_name espn_id position position_group headshot latest_team`),
  },
};
