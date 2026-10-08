/**
 * A per-second history of what each player owned, for the in-game chart.
 *
 * Nothing like this existed: `LiveStatsController` samples at the same cadence
 * but SENDS the sample to a server (and only when the config opts in), and
 * `AllPlayersStats` is an end-of-game aggregate of peaks and buckets — neither
 * is a time series, and a chart needs points in order.
 *
 * Memory is bounded by the same thing that bounds any 10 Hz sampling of one
 * game: a 20-minute match is 1200 samples per player, each 4 numbers. Games
 * that long are the exception, and the whole thing is dropped when the next
 * game initialises its controller.
 */

/** Sample every N turns. Turns are 100 ms, so 10 is once a second. */
export const SAMPLE_EVERY_TURNS = 10;

export interface Sample {
  /** The turn the numbers were read on. */
  turn: number;
  tiles: number;
  troops: number;
  gold: number;
}

export interface PlayerSeries {
  clientID: string;
  name: string;
  /** True for the local player, which is the line the chart leads with. */
  mine: boolean;
  alive: boolean;
  samples: Sample[];
}

/** The three things worth watching, and how each is spelled in the UI. */
export type StatKey = "tiles" | "troops" | "gold";

export const STAT_KEYS: StatKey[] = ["tiles", "troops", "gold"];

let players: PlayerSeries[] = [];
let lastTurn = 0;

/** Drop everything: the next game must not inherit the last one's lines. */
export function resetStatsHistory(): void {
  players = [];
  lastTurn = 0;
}

/**
 * Read the players at `turn` and keep them, if enough turns have passed.
 *
 * Cheap enough to call every turn and return early: the check is one modulo,
 * and the snapshot loop only runs once a second.
 */
export function recordStatsHistory(
  turn: number,
  entries: {
    clientID: string | null;
    name: string;
    mine: boolean;
    alive: boolean;
    tiles: number;
    troops: number;
    gold: number;
  }[],
): void {
  lastTurn = turn;
  if (turn % SAMPLE_EVERY_TURNS !== 0) return;

  const seen = new Set<string>();
  for (const e of entries) {
    // A clientID can be null before the roster resolves; those entries have no
    // line to append to and no key to look one up by.
    if (e.clientID === null) continue;
    seen.add(e.clientID);
    let series = players.find((p) => p.clientID === e.clientID);
    if (series === undefined) {
      series = {
        clientID: e.clientID,
        name: e.name,
        mine: e.mine,
        alive: e.alive,
        samples: [],
      };
      players.push(series);
    }
    series.name = e.name;
    series.mine = series.mine || e.mine;
    series.alive = e.alive;
    series.samples.push({
      turn,
      tiles: e.tiles,
      troops: e.troops,
      gold: e.gold,
    });
  }
  // A player who vanished from the roster (kicked, disconnected out of the
  // view) keeps its history: a line that stops is information, unlike a line
  // that resurrects a ghost entry.
  void seen;
}

/** Everything the chart renders. */
export function statsHistory(): {
  turn: number;
  players: readonly PlayerSeries[];
} {
  return { turn: lastTurn, players };
}

/** The largest value a player reached in one metric, or 0 if it has none. */
export function statPeak(series: PlayerSeries, key: StatKey): number {
  let peak = 0;
  for (const s of series.samples) {
    if (s[key] > peak) peak = s[key];
  }
  return peak;
}

/**
 * Format one of the three metrics for display.
 *
 * Gold is read from a bigint in the engine and lands here as a Number, which
 * is exact well past the sums this game produces (a billion gold is 30 bits),
 * but it still needs grouping: an ungrouped `12345678` is unreadable in the
 * 40px of header the chart has.
 */
export function formatStat(key: StatKey, value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  return rounded.toLocaleString();
}
