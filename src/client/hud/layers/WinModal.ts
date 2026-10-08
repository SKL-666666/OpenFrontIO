import { GameType, RankedType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { Pattern } from "@openfront/shared/CosmeticSchemas";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  DESKTOP_TUTORIAL_VIDEO_URL,
  getGamesPlayed,
  homeHref,
  isInIframe,
  translateText,
  TUTORIAL_VIDEO_URL,
} from "../../../client/Utils";
import { getUserMe } from "../../Api";
import "../../components/CosmeticCard";
import { cosmeticSelectionLabel } from "../../components/CosmeticPresentation";
import "../../components/PurchaseButton";
import "../../components/SteamWishlist";
import { Controller } from "../../Controller";
import {
  fetchCosmetics,
  purchaseCosmetic,
  resolveCosmetics,
} from "../../Cosmetics";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import { isDesktopShell } from "../../DesktopShell";
import { isLocalMode } from "../../LocalMode";
import { downloadGameRecord, getLastGameRecord } from "../../LocalReplay";
import { Platform } from "../../Platform";
// Static, not a dynamic import: ReplayEntry is already reached statically from
// Main, JoinLobbyModal and ReplayViewer, so loading it on click would not move
// it out of this chunk — only add a tick of asynchrony to the button.
import { openReplayViewer } from "../../replay/ReplayEntry";
import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { steamSDK } from "../../SteamSDK";
import { SendWinnerEvent } from "../../Transport";
import { GameView } from "../../view";

@customElement("win-modal")
export class WinModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private hasShownDeathModal = false;

  @state()
  isVisible = false;

  @state()
  private isWin = false;

  @state()
  private isRankedGame = false;

  @state()
  private patternContent: TemplateResult | null = null;

  /**
   * "Play again" is offered only for a local singleplayer game: it replays the
   * stored start info, so it needs one to exist, and it makes no sense for a
   * LAN room (the host decides when the next one is) or a match.
   */
  @state()
  private canRestart = false;

  /**
   * "Watch it back" / "Save it", offered once a record of this game exists.
   *
   * Set after the winner event rather than when the dialog opens, because the
   * record is assembled as a consequence of that event — asking for it before
   * would always find nothing.
   */
  @state()
  private canArchive = false;

  private _title: string;

  private rand = Math.random();

  // Override to prevent shadow DOM creation
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
  }

  render() {
    return html`
      <div
        class="${this.isVisible
          ? "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800/70 p-4 md:p-6 shrink-0 rounded-lg z-[10010] shadow-2xl backdrop-blur-xs text-white w-[min(90vw,700px)] max-w-[90%] max-h-[90dvh] overflow-hidden flex flex-col"
          : "hidden"}"
      >
        <h2 class="m-0 mb-4 text-[26px] text-center text-white shrink-0">
          ${this._title || ""}
        </h2>
        <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
          ${this.innerHtml()}
        </div>
        <!--
          Local-build actions. They sit in their own row because the existing
          row already runs to three buttons when a ranked game offers a requeue,
          and five across is unusable on the phone-width dialog this is sized
          for. Shown only when they have something to act on: a room has no
          record (each peer could only archive its own view), and a game that
          has not ended has nothing to replay.
        -->
        ${this.canRestart || this.canArchive
          ? html`<div class="mt-4 flex flex-wrap gap-2.5 shrink-0">
              ${this.canRestart
                ? html`
                    <o-button
                      variant="secondary"
                      width="block"
                      class="flex-1"
                      translationKey="win_modal.play_again"
                      @click=${this._handleRestart}
                    ></o-button>
                  `
                : null}
              ${this.canArchive
                ? html`
                    <o-button
                      variant="secondary"
                      width="block"
                      class="flex-1"
                      translationKey="win_modal.replay"
                      @click=${this._handleReplay}
                    ></o-button>
                    <o-button
                      variant="secondary"
                      width="block"
                      class="flex-1"
                      translationKey="win_modal.save"
                      @click=${this._handleSave}
                    ></o-button>
                  `
                : null}
            </div>`
          : null}
        <div class="mt-4 flex justify-between gap-2.5 shrink-0">
          <o-button
            variant="primary"
            width="block"
            class="flex-1"
            translationKey="win_modal.exit"
            @click=${this._handleExit}
          ></o-button>
          ${this.isRankedGame
            ? html`
                <o-button
                  variant="primary"
                  width="block"
                  class="flex-1"
                  translationKey="win_modal.requeue"
                  @click=${this._handleRequeue}
                ></o-button>
              `
            : null}
          <o-button
            variant="primary"
            width="block"
            class="flex-1"
            .title=${this.game?.myPlayer()?.isAlive()
              ? translateText("win_modal.keep")
              : translateText("win_modal.spectate")}
            @click=${this.hide}
          ></o-button>
        </div>
      </div>
    `;
  }

  innerHtml() {
    // The Steam desktop build has nothing to wishlist — fall through to the
    // other promos so the box is never empty.
    const canWishlist = !steamSDK.isOnSteam();

    if (isInIframe()) {
      return canWishlist ? this.steamWishlist() : this.discordDisplay();
    }

    if (!this.isWin && getGamesPlayed() < 3) {
      return this.renderYoutubeTutorial();
    }
    if (this.rand < 0.25 && canWishlist) {
      return this.steamWishlist();
    } else if (this.rand < 0.5) {
      return this.discordDisplay();
    } else {
      return this.renderPatternButton();
    }
  }

  renderYoutubeTutorial() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.youtube_tutorial")}
        </h3>
        <!-- 56.25% = 9:16 -->
        <div class="relative w-full pb-[56.25%]">
          ${Platform.isElectron
            ? html`<video
                class="absolute top-0 left-0 w-full h-full rounded-sm"
                src="${this.isVisible ? DESKTOP_TUTORIAL_VIDEO_URL : ""}"
                controls
                preload="metadata"
              ></video>`
            : html`<iframe
                class="absolute top-0 left-0 w-full h-full rounded-sm"
                src="${this.isVisible ? TUTORIAL_VIDEO_URL : ""}"
                title="YouTube video player"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen
              ></iframe>`}
        </div>
      </div>
    `;
  }

  renderPatternButton() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.support_openfront")}
        </h3>
        ${isDesktopShell()
          ? null
          : html`<p class="text-white mb-3">
              ${translateText("win_modal.territory_pattern")}
            </p>`}
        <div
          class="mx-auto w-full overflow-x-auto overflow-y-visible rounded-sm"
        >
          <div
            class="flex min-w-max items-start justify-center gap-4 px-1 py-1"
          >
            ${this.patternContent}
          </div>
        </div>
      </div>
    `;
  }

  async loadPatternContent() {
    const me = await getUserMe();
    const cosmetics = await fetchCosmetics();

    const purchasable = resolveCosmetics(cosmetics, me, null).filter(
      (r) => r.type === "pattern" && r.relationship === "purchasable",
    );

    if (purchasable.length === 0) {
      this.patternContent = html``;
      return;
    }

    // Shuffle the array and take patterns. Will always be 3 wide to allow scrolling
    const shuffled = [...purchasable].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(3, shuffled.length));

    this.patternContent = html`
      <div class="flex gap-4 flex-nowrap justify-start items-start">
        ${selected.map((resolved) => {
          // Only patterns were selected above.
          const pattern = resolved.cosmetic as Pattern | null;
          return html`
            <div data-win-cosmetic-promo class="flex w-40 flex-col gap-2">
              <cosmetic-card
                .resolved=${resolved}
                .interactive=${false}
              ></cosmetic-card>
              <purchase-button
                .priceHard=${pattern?.priceHard ?? null}
                .priceSoft=${pattern?.priceSoft ?? null}
                .rarity=${pattern?.rarity ?? "common"}
                .itemName=${cosmeticSelectionLabel(resolved)}
                .onPurchaseHard=${() => purchaseCosmetic(resolved, "hard")}
                .onPurchaseSoft=${() => purchaseCosmetic(resolved, "soft")}
              ></purchase-button>
            </div>
          `;
        })}
      </div>
    `;
  }

  steamWishlist(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("steam_wishlist.buy_on_steam")}
        </h3>
        <steam-wishlist
          campaign="win_modal"
          .active=${this.isVisible}
        ></steam-wishlist>
      </div>
    `;
  }

  discordDisplay(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.join_discord")}
        </h3>
        <p class="text-white mb-3">
          ${translateText("win_modal.discord_description")}
        </p>
        <a
          href="https://discord.com/invite/openfront"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block px-6 py-3 bg-indigo-600 text-white rounded-sm font-semibold transition-all duration-200 hover:bg-indigo-700 hover:-translate-y-px no-underline"
        >
          ${translateText("win_modal.join_server")}
        </a>
      </div>
    `;
  }

  async show() {
    crazyGamesSDK.gameplayStop();
    this.isRankedGame =
      this.game.config().gameConfig().rankedType !== undefined;
    // Set before the cosmetic fetch below: that path can return early, and
    // these two are read from the render that follows either way.
    //
    // canArchive is checked only now because the record is a consequence of
    // the winner event that precedes every call to show() — on a death dialog
    // nothing has ended yet and there is correctly nothing to save.
    this.canRestart =
      isLocalMode() &&
      this.game.config().gameConfig().gameType === GameType.Singleplayer;
    this.canArchive = isLocalMode() && getLastGameRecord() !== null;
    this.isVisible = true;
    this.requestUpdate();
    try {
      await this.loadPatternContent();
    } catch (error) {
      console.warn("Failed to load win modal cosmetics", error);
      return;
    }
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  private _handleExit() {
    this.hide();
    window.location.href = homeHref();
  }

  private _handleRequeue() {
    this.hide();
    // Requeue for the same mode; Main owns the mechanism (currently a
    // reload with the requeue param, which reopens the queue after the
    // page teardown).
    document.dispatchEvent(
      new CustomEvent("matchmaking-requeue", {
        detail: {
          mode:
            this.game.config().gameConfig().rankedType === RankedType.TwoVTwo
              ? ("2v2" as const)
              : ("1v1" as const),
        },
      }),
    );
  }

  /**
   * Start the same singleplayer game over.
   *
   * Typed structurally rather than imported: `SinglePlayerModal` pulls in the
   * whole menu, which pulls in Main, which owns the `join-lobby` path it
   * dispatches back into — importing it here would close a cycle through this
   * very file. The element is a singleton in index.html, so the query is the
   * whole lookup.
   */
  private _handleRestart(): void {
    this.hide();
    const modal = document.querySelector("single-player-modal") as unknown as {
      restartLastGame?: () => Promise<boolean>;
    } | null;
    const restart = modal?.restartLastGame;
    if (restart === undefined) {
      console.warn("local: no singleplayer modal to restart from");
      return;
    }
    void restart.call(modal).then((started) => {
      if (!started) console.warn("local: nothing to restart");
    });
  }

  /**
   * Open this game in the replay viewer.
   *
   * `openReplayViewer` hands the record over in-process, so nothing is fetched:
   * the viewer is fed by the same object the win screen just read.
   */
  private _handleReplay(): void {
    const record = getLastGameRecord();
    this.hide();
    if (record === null) {
      console.warn("local: no record to replay");
      return;
    }
    if (!openReplayViewer(record.info.gameID, record)) {
      console.warn("local: replay viewer unavailable");
    }
  }

  /** Write the record to disk as a `.json` the viewer can open later. */
  private _handleSave(): void {
    const record = getLastGameRecord();
    if (record === null) {
      console.warn("local: no record to save");
      return;
    }
    downloadGameRecord(record);
  }

  init() {
    // The modal element is a singleton across the whole page, but a game is
    // not: without this, a restart in place would carry the previous game's
    // death modal and victory flag into the next one and show it immediately.
    this.hasShownDeathModal = false;
    this.isVisible = false;
    this.isWin = false;
    this.canRestart = false;
    this.canArchive = false;
    this._title = "";
  }

  tick() {
    const myPlayer = this.game.myPlayer();
    if (
      !this.hasShownDeathModal &&
      myPlayer &&
      !myPlayer.isAlive() &&
      !this.game.inSpawnPhase() &&
      myPlayer.hasSpawned()
    ) {
      this.hasShownDeathModal = true;
      this._title = translateText("win_modal.died");
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
      this.show();
    }
    const updates = this.game.updatesSinceLastTick();
    const winUpdates = updates?.[GameUpdateType.Win] ?? [];
    winUpdates.forEach((wu) => {
      if (wu.winner === undefined) {
        // Match cancelled (e.g. a ranked 2v2 that didn't fill or fully
        // spawn): the game ends with no winner. Still vote the result to the
        // server so the record is archived winnerless (never ranked).
        this.eventBus.emit(new SendWinnerEvent(undefined, wu.allPlayersStats));
        this._title = translateText("win_modal.match_cancelled");
        this.isWin = false;
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "team") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        if (wu.winner[1] === this.game.myPlayer()?.team()) {
          this._title = translateText("win_modal.your_team");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_team", {
            team: wu.winner[1],
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "nation") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        this._title = translateText("win_modal.nation_won", {
          nation: wu.winner[1],
        });
        this.isWin = false;
        this.playEndOfGameSound();
        this.show();
      } else {
        const winner = this.game.playerByClientID(wu.winner[1]);
        if (!winner?.isPlayer()) return;
        const winnerClient = winner.clientID();
        if (winnerClient !== null) {
          this.eventBus.emit(
            new SendWinnerEvent(["player", winnerClient], wu.allPlayersStats),
          );
        }
        if (
          winnerClient !== null &&
          winnerClient === this.game.myPlayer()?.clientID()
        ) {
          this._title = translateText("win_modal.you_won");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_won", {
            player: winner.displayName(),
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      }
    });
  }

  private playEndOfGameSound(): void {
    if (this.isWin) {
      this.eventBus.emit(new PlaySoundEffectEvent("victory"));
    } else if (!this.hasShownDeathModal && this.game.myPlayer()?.hasSpawned()) {
      // Spawned check: spectators and replay viewers shouldn't get a
      // personal defeat sting. The cue also already played if the player
      // died earlier (hasShownDeathModal).
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
    }
  }
}
