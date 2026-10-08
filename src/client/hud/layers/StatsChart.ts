import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { isLocalMode } from "../../LocalMode";
import {
  formatStat,
  PlayerSeries,
  recordStatsHistory,
  resetStatsHistory,
  SAMPLE_EVERY_TURNS,
  STAT_KEYS,
  StatKey,
  statPeak,
  statsHistory,
} from "../../StatsHistory";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/**
 * The corner chart: how this match has been going, as a line.
 *
 * Samples are taken by this element (it is a Controller, so it ticks with the
 * game) rather than by a separate controller, because the two things that need
 * the game — reading the players and re-rendering — are the same tick, and
 * splitting them would put a third file between them for no gain.
 *
 * Deliberately bounded to a few players per sample. A singleplayer game can
 * have 400 bots, and recording them all every second would be a megabytes-per-
 * game array nobody could draw: what is kept is every human plus whoever is
 * actually winning, which is the only opponent line worth looking at.
 */
@customElement("stats-chart")
export class StatsChart extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private metric: StatKey = "tiles";
  @state() private open = true;
  /** Re-render only when a sample was actually taken. */
  private lastSampledTurn = -1;

  // Override to prevent shadow DOM creation: this sits in the fixed HUD, which
  // every other layer renders into the light DOM.
  createRenderRoot() {
    return this;
  }

  init(): void {
    resetStatsHistory();
    this.lastSampledTurn = -1;
    this.open = true;
    this.metric = "tiles";
  }

  tick(): void {
    if (!isLocalMode()) return;
    const turn = this.game.ticks();
    if (turn === this.lastSampledTurn) return;
    if (turn % SAMPLE_EVERY_TURNS !== 0) return;
    this.lastSampledTurn = turn;

    const all = this.game.players().map((p) => ({
      clientID: p.clientID(),
      name: p.displayName(),
      mine: p.isMe(),
      alive: p.isAlive(),
      human: p.type() === PlayerType.Human,
      tiles: p.numTilesOwned(),
      troops: p.troops(),
      gold: Number(p.gold()),
    }));

    // Humans always; plus the one player currently holding the most ground, so
    // the chart can show who is actually winning against the AI. Bounded by
    // construction: at most (humans + 1) series exist.
    const humans = all.filter((e) => e.human);
    const leader = all.reduce<(typeof all)[number] | null>(
      (best, e) => (best === null || e.tiles > best.tiles ? e : best),
      null,
    );
    const keep = new Set(humans.map((e) => e.clientID));
    if (leader?.clientID !== null && leader !== null) keep.add(leader.clientID);

    recordStatsHistory(
      turn,
      all.filter((e) => e.clientID !== null && keep.has(e.clientID)),
    );
    this.requestUpdate();
  }

  private seriesFor(): PlayerSeries[] {
    const { players } = statsHistory();
    // Lead with the local player's line; whoever else is recorded follows.
    return [...players].sort((a, b) => Number(b.mine) - Number(a.mine));
  }

  private setMetric(key: StatKey): void {
    this.metric = key;
    this.requestUpdate();
  }

  render(): TemplateResult | typeof nothing {
    if (!isLocalMode()) return nothing;
    const series = this.seriesFor();
    if (series.length === 0) return nothing;

    const mine = series.find((p) => p.mine) ?? series[0];
    const points = mine.samples.map((s) => s[this.metric]);
    const peak = statPeak(mine, this.metric);

    return html`
      <div
        class="w-[220px] rounded-xl border border-white/10 bg-gray-900/85 backdrop-blur-sm shadow-lg overflow-hidden text-white"
      >
        <div class="flex items-center gap-1 px-2 pt-1.5">
          ${STAT_KEYS.map(
            (key) => html`
              <button
                class="flex-1 rounded-md px-1 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${key ===
                this.metric
                  ? "bg-sky-500/30 text-sky-200"
                  : "text-white/50 hover:bg-white/10"}"
                @click=${() => this.setMetric(key)}
              >
                ${translateText(`stats_chart.${key}`) || key}
              </button>
            `,
          )}
          <button
            class="ml-1 px-1.5 py-1 text-[10px] text-white/40 hover:text-white/80"
            title=${translateText("stats_chart.collapse") || "Collapse"}
            @click=${() => {
              this.open = !this.open;
              this.requestUpdate();
            }}
          >
            ${this.open ? "–" : "+"}
          </button>
        </div>

        <div class="flex items-baseline gap-2 px-2.5 pb-1">
          <span class="text-[10px] uppercase tracking-wider text-white/40"
            >${translateText("stats_chart.peak") || "Peak"}</span
          >
          <span class="text-base font-bold tabular-nums text-sky-300">
            ${formatStat(this.metric, peak)}
          </span>
          <span class="ml-auto text-[10px] tabular-nums text-white/40">
            ${formatStat(this.metric, points[points.length - 1] ?? 0)}
          </span>
        </div>

        ${this.open ? this.renderChart(points) : nothing}
        ${series.length > 1 && this.open
          ? html`<div class="px-2.5 pb-2 text-[10px] text-white/45 truncate">
              ${series
                .slice(0, 4)
                .map(
                  (p) =>
                    `${p.mine ? "★ " : ""}${p.name}: ${formatStat(this.metric, statPeak(p, this.metric))}`,
                )
                .join("  ·  ")}
            </div>`
          : nothing}
      </div>
    `;
  }

  /**
   * The line itself, as an SVG polyline in a 0-100 box.
   *
   * `preserveAspectRatio="none"` is what makes the numbers pure percentages:
   * the box stretches to whatever width the panel gives it, so x and y are both
   * "how far along" and "how much of the peak", with no pixel maths and no
   * re-render on resize.
   */
  private renderChart(points: number[]): TemplateResult {
    const max = Math.max(1, ...points);
    const n = points.length;
    const coords = points.map((v, i) => {
      const x = n <= 1 ? 50 : (i / (n - 1)) * 100;
      const y = 100 - (v / max) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const last = coords[coords.length - 1] ?? "50,100";
    const [lx, ly] = last.split(",");

    return html`
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        class="block h-16 w-full"
        aria-label=${translateText("stats_chart.title") || "Game history"}
      >
        <line
          x1="0"
          y1="100"
          x2="100"
          y2="100"
          stroke="rgba(255,255,255,0.12)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
        ${n > 1
          ? html`<polyline
              points=${coords.join(" ")}
              fill="none"
              stroke="#38bdf8"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linejoin="round"
            />`
          : nothing}
        <circle
          cx=${lx}
          cy=${ly}
          r="3"
          fill="#7dd3fc"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    `;
  }
}
