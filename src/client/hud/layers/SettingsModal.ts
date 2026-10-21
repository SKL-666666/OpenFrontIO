import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { crazyGamesSDK } from "src/client/CrazyGamesSDK";
import {
  PauseGameIntentEvent,
  SendGodActionIntentEvent,
  SendUpdateGameConfigIntentEvent,
} from "src/client/Transport";
import { Controller } from "../../Controller";
import {
  AlternateViewEvent,
  ToggleRenderDebugGuiEvent,
} from "../../InputHandler";
import type { GodBrush, UIState } from "../../UIState";
import type { UserSettingModal } from "../../UserSettingModal";
import { homeHref, translateText } from "../../Utils";
import type { GameView } from "../../view";
const exitIcon = assetUrl("images/ExitIconWhite.svg");
const settingsIcon = assetUrl("images/SettingIconWhite.svg");
const treeIcon = assetUrl("images/TreeIconWhite.svg");

export class ShowSettingsModalEvent {
  constructor(
    public readonly isVisible: boolean = true,
    public readonly shouldPause: boolean = false,
    public readonly isPaused: boolean = false,
  ) {}
}

/**
 * The in-game menu.
 *
 * It holds what is session state or a game action — the alternate (terrain)
 * view, the debug GUI, exiting — plus a link into the settings modal. Every
 * `UserSettings`-backed row it used to duplicate, the advanced graphics
 * options included, now lives in `UserSettingModal`, which this opens through
 * the non-inline `#game-settings` instance so both entry points render the
 * same UI.
 */
@customElement("settings-modal")
export class SettingsModal extends LitElement implements Controller {
  public eventBus: EventBus;

  @state()
  private isVisible: boolean = false;

  @state()
  private alternateView: boolean = false;

  @query(".modal-overlay")
  private modalOverlay!: HTMLElement;

  @property({ type: Boolean })
  shouldPause = false;

  @property({ type: Boolean })
  wasPausedWhenOpened = false;

  /** Set by the game renderer; absent in the standalone replay viewer. */
  public game?: GameView;

  /** Shared client state; the god brush is armed through it. */
  public uiState?: UIState;

  // God mode ("world laws"). The client does not receive config updates back
  // from the engine, so the modal keeps its own mirror of the toggles, seeded
  // once from the game's starting config.
  @state() private godInfiniteGold = false;
  @state() private godInfiniteTroops = false;
  @state() private godInstantBuild = false;
  @state() private godDisableNukes = false;
  @state() private godHardDifficulty = false;
  private godSeeded = false;

  init() {
    this.eventBus.on(ShowSettingsModalEvent, (event) => {
      this.isVisible = event.isVisible;
      this.shouldPause = event.shouldPause;
      this.wasPausedWhenOpened = event.isPaused;
      this.pauseGame(true);
    });
  }

  protected updated(): void {
    if (this.isVisible) this.seedGodMode();
  }

  private seedGodMode() {
    if (this.godSeeded || this.game === undefined) return;
    this.godSeeded = true;
    const cfg = this.game.config().gameConfig();
    this.godInfiniteGold = cfg.infiniteGold ?? false;
    this.godInfiniteTroops = cfg.infiniteTroops ?? false;
    this.godInstantBuild = cfg.instantBuild ?? false;
    this.godHardDifficulty = cfg.difficulty === Difficulty.Hard;
    this.godDisableNukes = (cfg.disabledUnits ?? []).includes(
      UnitType.AtomBomb,
    );
  }

  private sendGodPatch(config: Partial<GameConfig>) {
    this.eventBus.emit(new SendUpdateGameConfigIntentEvent(config));
  }

  private onGodInfiniteGold = () => {
    this.godInfiniteGold = !this.godInfiniteGold;
    this.sendGodPatch({ infiniteGold: this.godInfiniteGold });
  };

  private onGodInfiniteTroops = () => {
    this.godInfiniteTroops = !this.godInfiniteTroops;
    this.sendGodPatch({ infiniteTroops: this.godInfiniteTroops });
  };

  private onGodInstantBuild = () => {
    this.godInstantBuild = !this.godInstantBuild;
    this.sendGodPatch({ instantBuild: this.godInstantBuild });
  };

  private onGodDisableNukes = () => {
    this.godDisableNukes = !this.godDisableNukes;
    this.sendGodPatch({
      disabledUnits: this.godDisableNukes
        ? [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV]
        : [],
    });
  };

  private onGodHardDifficulty = () => {
    this.godHardDifficulty = !this.godHardDifficulty;
    this.sendGodPatch({
      difficulty: this.godHardDifficulty ? Difficulty.Hard : Difficulty.Medium,
    });
  };

  private onGodGold = (smallID: number) => {
    this.eventBus.emit(
      new SendGodActionIntentEvent("gold", smallID, 1_000_000),
    );
  };

  private onGodTroops = (smallID: number) => {
    this.eventBus.emit(new SendGodActionIntentEvent("troops", smallID, 1_000));
  };

  private onGodConquer = (smallID: number) => {
    this.eventBus.emit(new SendGodActionIntentEvent("conquer", smallID));
  };

  // Tile brushes arm a mode that paints the map on the next click. Arming
  // closes the menu so the click reaches the map.
  private onGodBrush = (
    action: GodBrush["action"],
    unit?: GodBrush["unit"],
  ) => {
    if (this.uiState === undefined) return;
    this.uiState.godBrush =
      this.uiState.godBrush?.action === action &&
      this.uiState.godBrush?.unit === unit
        ? null // clicking the armed brush again disarms it
        : { action, unit };
    this.closeModal();
  };

  private renderGodBrushButton(
    labelKey: string,
    action: GodBrush["action"],
    unit?: GodBrush["unit"],
  ) {
    const armed =
      this.uiState?.godBrush?.action === action &&
      this.uiState?.godBrush?.unit === unit;
    return html`
      <button
        class="px-2 py-1 text-xs rounded-sm ${armed
          ? "bg-amber-500 text-slate-900"
          : "bg-violet-600/30 hover:bg-violet-600/50 text-violet-200"}"
        @click=${() => this.onGodBrush(action, unit)}
      >
        ${translateText(labelKey)}
      </button>
    `;
  }

  private static readonly GOD_BUILD_UNITS: {
    unit: GodBrush["unit"];
    key: string;
  }[] = [
    { unit: UnitType.City, key: "unit_type.city" },
    { unit: UnitType.Port, key: "unit_type.port" },
    { unit: UnitType.DefensePost, key: "unit_type.defense_post" },
    { unit: UnitType.MissileSilo, key: "unit_type.missile_silo" },
    { unit: UnitType.SAMLauncher, key: "unit_type.sam_launcher" },
    { unit: UnitType.Factory, key: "unit_type.factory" },
  ];

  private renderGodBrushes() {
    return html`
      <div class="px-3 pt-2 text-xs text-slate-500">
        ${translateText("user_setting.god_brush_desc")}
      </div>
      <div class="flex flex-wrap gap-2 px-3 py-2">
        ${this.renderGodBrushButton("user_setting.god_brush_water", "water")}
        ${this.renderGodBrushButton("user_setting.god_brush_land", "land")}
        ${this.renderGodBrushButton("user_setting.god_brush_give", "give")}
        ${this.renderGodBrushButton("user_setting.god_brush_erase", "erase")}
      </div>
      <div class="px-3 text-xs text-slate-500">
        ${translateText("user_setting.god_brush_build")}
      </div>
      <div class="flex flex-wrap gap-2 px-3 py-2">
        ${SettingsModal.GOD_BUILD_UNITS.map(({ unit, key }) =>
          this.renderGodBrushButton(key, "build", unit),
        )}
      </div>
    `;
  }

  private static readonly GOD_TARGET_LIMIT = 8;

  private renderGodPlayers() {
    const mySmallID = this.game?.myPlayer()?.smallID() ?? null;
    const players = (this.game?.players() ?? [])
      .filter((p) => p.isAlive() && p.smallID() !== mySmallID)
      .sort((a, b) => b.troops() - a.troops())
      .slice(0, SettingsModal.GOD_TARGET_LIMIT);

    if (players.length === 0) {
      return html`<div class="px-3 py-1 text-xs text-slate-500">
        ${translateText("user_setting.god_no_targets")}
      </div>`;
    }

    return html`
      <div class="px-3 py-1 text-xs text-slate-500">
        ${translateText("user_setting.god_players_desc")}
      </div>
      ${players.map((p) => {
        const id = p.smallID();
        return html`
          <div
            class="flex items-center gap-2 px-3 py-2 hover:bg-slate-700 rounded-sm"
          >
            <div class="flex-1 text-white text-sm truncate">
              ${p.displayName()}
            </div>
            <button
              class="px-2 py-1 text-xs rounded-sm bg-amber-600/30 hover:bg-amber-600/50 text-amber-200"
              @click=${() => this.onGodGold(id)}
            >
              ${translateText("user_setting.god_gold")}
            </button>
            <button
              class="px-2 py-1 text-xs rounded-sm bg-sky-600/30 hover:bg-sky-600/50 text-sky-200"
              @click=${() => this.onGodTroops(id)}
            >
              ${translateText("user_setting.god_troops")}
            </button>
            <button
              class="px-2 py-1 text-xs rounded-sm bg-red-600/30 hover:bg-red-600/50 text-red-200"
              @click=${() => this.onGodConquer(id)}
            >
              ${translateText("user_setting.god_conquer")}
            </button>
          </div>
        `;
      })}
    `;
  }

  private renderGodToggle(labelKey: string, on: boolean, onClick: () => void) {
    return html`
      <button
        class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
        @click="${onClick}"
      >
        <div class="flex-1">
          <div class="font-medium">${translateText(labelKey)}</div>
        </div>
        <div class="text-sm ${on ? "text-emerald-400" : "text-slate-400"}">
          ${on
            ? translateText("user_setting.on")
            : translateText("user_setting.off")}
        </div>
      </button>
    `;
  }

  private renderGodModeSection() {
    return html`
      <div class="border-t border-slate-600 pt-3 mt-4">
        <div
          class="px-3 py-1 text-xs font-semibold text-amber-400 uppercase tracking-wider"
        >
          ${translateText("user_setting.god_mode_title")}
        </div>
        <div class="px-3 pb-1 text-xs text-slate-500">
          ${translateText("user_setting.god_mode_desc")}
        </div>
        ${this.renderGodToggle(
          "user_setting.god_infinite_gold",
          this.godInfiniteGold,
          this.onGodInfiniteGold,
        )}
        ${this.renderGodToggle(
          "user_setting.god_infinite_troops",
          this.godInfiniteTroops,
          this.onGodInfiniteTroops,
        )}
        ${this.renderGodToggle(
          "user_setting.god_instant_build",
          this.godInstantBuild,
          this.onGodInstantBuild,
        )}
        ${this.renderGodToggle(
          "user_setting.god_disable_nukes",
          this.godDisableNukes,
          this.onGodDisableNukes,
        )}
        ${this.renderGodToggle(
          "user_setting.god_hard_difficulty",
          this.godHardDifficulty,
          this.onGodHardDifficulty,
        )}
        <div class="border-t border-slate-700 mt-2 pt-2">
          ${this.renderGodPlayers()}
        </div>
        <div class="border-t border-slate-700 mt-2 pt-2">
          ${this.renderGodBrushes()}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("click", this.handleOutsideClick, true);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  disconnectedCallback() {
    window.removeEventListener("click", this.handleOutsideClick, true);
    window.removeEventListener("keydown", this.handleKeyDown);
    super.disconnectedCallback();
  }

  private handleOutsideClick = (event: MouseEvent) => {
    if (
      this.isVisible &&
      this.modalOverlay &&
      event.target === this.modalOverlay
    ) {
      this.closeModal();
    }
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (this.isVisible && event.key === "Escape") {
      this.closeModal();
    }
  };

  /** Whether the menu is showing. */
  get open(): boolean {
    return this.isVisible;
  }

  public openModal() {
    this.isVisible = true;
    this.requestUpdate();
  }

  public closeModal({ keepPause = false }: { keepPause?: boolean } = {}) {
    this.isVisible = false;
    this.requestUpdate();
    if (!keepPause) this.pauseGame(false);
  }

  private pauseGame(pause: boolean) {
    // CrazyGames: report gameplay as stopped whenever the settings menu is open,
    // and resumed when it closes — unless the game was already paused when opened.
    if (pause) {
      crazyGamesSDK.gameplayStop();
    } else if (!this.wasPausedWhenOpened) {
      crazyGamesSDK.gameplayStart();
    }

    // Only pause the simulation itself when we own the pause (singleplayer or
    // lobby creator).
    if (this.shouldPause && !this.wasPausedWhenOpened) {
      this.eventBus.emit(new PauseGameIntentEvent(pause));
    }
  }

  private onTerrainButtonClick() {
    this.alternateView = !this.alternateView;
    this.eventBus.emit(new AlternateViewEvent(this.alternateView));
    this.requestUpdate();
  }

  private onOpenSettingsButtonClick() {
    // index.html hides the page's inline <user-setting id="page-settings">
    // during a match, so the HUD addresses its own non-inline instance by id.
    const gameSettings = document.getElementById(
      "game-settings",
    ) as UserSettingModal | null;
    if (gameSettings === null || typeof gameSettings.open !== "function") {
      // Leave this menu open: closing it would strand the player with neither
      // the settings modal nor a menu.
      console.warn("In-game settings modal (#game-settings) not found");
      return;
    }
    // Keep the pause. Nothing releases it until this menu itself closes, and
    // UserSettingModal knows nothing about pausing — it only calls onReturn.
    this.closeModal({ keepPause: true });
    gameSettings.open({
      tab: "gameplay",
      // Reopen directly rather than re-emitting ShowSettingsModalEvent: init()
      // runs pauseGame(true) on every event, which would emit a second
      // PauseGameIntentEvent(true).
      onReturn: () => this.openModal(),
    });
  }

  private onRenderDebugGuiButtonClick() {
    this.eventBus.emit(new ToggleRenderDebugGuiEvent());
    this.closeModal();
  }

  private onExitButtonClick() {
    // redirect to the home page
    window.location.href = homeHref();
  }

  render() {
    if (!this.isVisible) {
      return null;
    }

    return html`
      <div
        class="modal-overlay fixed inset-0 bg-black/60 backdrop-blur-xs z-2000 flex items-center justify-center p-4"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div
          class="bg-slate-800 border border-slate-600 rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto"
        >
          <div
            class="flex items-center justify-between p-4 border-b border-slate-600"
          >
            <div class="flex items-center gap-2">
              <img
                src=${settingsIcon}
                alt=""
                width="24"
                height="24"
                class="align-middle"
              />
              <h2 class="text-xl font-semibold text-white">
                ${translateText("user_setting.game_menu_title")}
              </h2>
            </div>
            <button
              class="text-slate-400 hover:text-white text-2xl font-bold leading-none"
              @click=${this.closeModal}
            >
              ×
            </button>
          </div>

          <div class="p-4 flex flex-col gap-3">
            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              data-open-settings
              @click="${this.onOpenSettingsButtonClick}"
            >
              <img src=${settingsIcon} alt="" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.open_settings_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.open_settings_desc")}
                </div>
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onTerrainButtonClick}"
            >
              <img src=${treeIcon} alt="" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.toggle_terrain")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.toggle_view_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.alternateView
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <div class="border-t border-slate-600 pt-3 mt-4">
              <div
                class="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider"
              >
                ${translateText("user_setting.development_only")}
              </div>

              <button
                class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
                @click="${this.onRenderDebugGuiButtonClick}"
              >
                <img src=${settingsIcon} alt="" width="20" height="20" />
                <div class="flex-1">
                  <div class="font-medium">
                    ${translateText("user_setting.render_debug_gui")}
                  </div>
                  <div class="text-sm text-slate-400">
                    ${translateText("user_setting.render_debug_gui_desc")}
                  </div>
                </div>
              </button>
            </div>

            ${this.renderGodModeSection()}

            <div class="border-t border-slate-600 pt-3 mt-4">
              <button
                class="flex gap-3 items-center w-full text-left p-3 hover:bg-red-600/20 rounded-sm text-red-400 transition-colors"
                @click="${this.onExitButtonClick}"
              >
                <img src=${exitIcon} alt="" width="20" height="20" />
                <div class="flex-1">
                  <div class="font-medium">
                    ${translateText("user_setting.exit_game_label")}
                  </div>
                  <div class="text-sm text-slate-400">
                    ${translateText("user_setting.exit_game_info")}
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
