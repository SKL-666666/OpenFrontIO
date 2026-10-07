import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { TeamCountConfig } from "@openfront/engine-api/Schemas";
import { DoomsdayClockSpeed } from "@openfront/engine-lib/game/DoomsdayClock";
import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/baseComponents/Button";
import { BaseModal } from "./components/BaseModal";
import "./components/GameConfigSettings";
import { modalHeader } from "./components/ui/ModalHeader";
import { getPlayerCosmetics } from "./Cosmetics";
import {
  generateRoomCode,
  normalizeRoomCode,
  ROOM_CODE_LENGTH,
  roomToGameID,
} from "./local/LocalHub";
import type { LocalRoomConfig } from "./local/LocalPeer";
import {
  activeLocalPeer,
  LOCAL_ROOM_UPDATE,
  type LocalRoomSnapshot,
} from "./local/LocalRoomState";
import { JoinLobbyEvent } from "./Main";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";
import {
  getRandomMapType,
  sliderToNationsConfig,
} from "./utilities/GameConfigHelpers";
import { translateText } from "./Utils";

type Step = "choose" | "host" | "join" | "waiting";

const DEFAULT_BOTS = 60;

/**
 * Fallback copy for every string in this dialog.
 *
 * Each one is a translateText() key with a plain-English fallback, so a missing
 * translation renders as readable text instead of a raw key. Kept as constants
 * because `translateText(k) || "..."` inline, repeated across the template, is
 * how a typo in one copy of a string survives review.
 */
const HINT_TABS_ONLY =
  "Empty relay: other tabs of this browser. For other machines, start npm run lan on the host and put its address here.";
const HINT_INTRO =
  "Play with people on this machine, or on your network. No game server and no account: every player simulates the game in their own browser.";

const TITLE_LOCAL_ROOM = "Local multiplayer";
const TITLE_CREATE_ROOM = "Create a room";
const TITLE_JOIN_ROOM = "Join a room";
const LABEL_CODE = "Room code";
const LABEL_RELAY = "LAN relay (optional)";
const MSG_BAD_RELAY = "The relay address must be a ws:// or wss:// URL";
const MSG_BAD_CODE = `A room code is ${ROOM_CODE_LENGTH} characters.`;
const RELAY_PLACEHOLDER = "ws://192.168.1.10:8790/lan";
const CODE_PLACEHOLDER = "ABCDEFGH";

const TITLE_WAITING = "Waiting for players";
const LABEL_CODE_TO_SHARE = "Give this code to the others";

const LABEL_YOU_ARE_GUEST = "Waiting for the host to start";

const MSG_ROOM_GONE = "This room is no longer available.";

/**
 * A multiplayer room with no server behind it.
 *
 * One of two things the local build offers instead of the online lobby flow,
 * and the only page in the client that knows a room is a thing you can be in
 * before the game starts: there is no server to broadcast a lobby to, so the
 * roster here is the relay's, read through the host's own peer.
 *
 * The three steps are deliberately separate screens rather than one form: the
 * map and difficulty only matter to whoever creates the room, and asking a
 * guest to fill them in would be asking for input that gets thrown away (the
 * relay broadcasts the host's config, so a guest's map choice is never used).
 */
@customElement("local-room-modal")
export class LocalRoomModal extends BaseModal {
  protected routerName = "local-room";

  @state() private step: Step = "choose";
  @state() private roomCode = "";
  @state() private relayUrl = "";
  @state() private busy = false;
  @state() private error = "";
  /** Room state while waiting, refreshed off every LOCAL_ROOM_UPDATE. */
  @state() private snapshot: LocalRoomSnapshot | null = null;
  /** True once join-lobby has been dispatched and the room is not yet over. */
  private inRoom = false;

  // Host-side game settings. The defaults are a small, quick game: a local room
  // is usually a handful of people at one desk (or one wifi) waiting for each
  // other, not a 400-bot world to grind.
  @state() private selectedMap: GameMapType = GameMapType.World;
  @state() private useRandomMap = false;
  @state() private selectedDifficulty: Difficulty = Difficulty.Medium;
  @state() private gameMode: GameMode = GameMode.FFA;
  @state() private teamCount: TeamCountConfig = 2;
  @state() private bots: number = DEFAULT_BOTS;
  @state() private nations = 0;
  @state() private defaultNationCount = 0;
  @state() private compactMap = false;
  @state() private instantBuild = false;
  @state() private randomSpawn = false;
  @state() private infiniteGold = false;
  @state() private infiniteTroops = false;
  @state() private waterNukes = false;
  @state() private doomsdayClock = false;
  @state() private doomsdayClockSpeed: DoomsdayClockSpeed = "normal";

  private mapLoader = terrainMapFileLoader;

  connectedCallback() {
    super.connectedCallback();
    // Main reopens this dialog for a room named in the URL hash (see
    // handleLocalRoomHash), and a cold load has no click to hang the code off.
    this.addEventListener("prefill-room-code", ((
      e: CustomEvent<{ code: string }>,
    ) => {
      this.roomCode = e.detail.code;
      this.step = "join";
    }) as EventListener);
    document.addEventListener(LOCAL_ROOM_UPDATE, this.handleRoomUpdate);
    void this.loadNationCount();
  }

  disconnectedCallback() {
    document.removeEventListener(LOCAL_ROOM_UPDATE, this.handleRoomUpdate);
    super.disconnectedCallback();
  }

  /**
   * Pull the room's state whenever the peer announces a change.
   *
   * Pulled rather than carried in the event: the roster is small, the source is
   * a single object, and a payload from a superseded room would otherwise show
   * a roster the current one has moved on from.
   */
  private handleRoomUpdate = () => {
    this.snapshot = activeLocalPeer()?.snapshot() ?? null;
    // The game starting ends this screen even if nothing else closes it:
    // Main's prestart handler does, but a failure in between must not leave a
    // waiting panel over a game nobody can be invited to any more.
    if (this.snapshot !== null && !this.snapshot.inLobby) this.close();
  };

  /**
   * The waiting room: the code to share, the roster, and (host only) Start.
   *
   * Everything the players have to agree on is visible here because the moment
   * the host presses Start it all freezes: the roster is copied into the game's
   * players array and the map into its config, and no later change reaches the
   * running simulation.
   */
  private renderWaiting(): TemplateResult {
    const snapshot = this.snapshot;
    const isHost = activeLocalPeer()?.relayServer !== null;
    if (snapshot === null) {
      // Between dispatching join-lobby and the first lobby broadcast: the room
      // exists but has not answered yet.
      return html`<div class="flex flex-col items-center gap-4 p-6">
        ${this.renderLoadingSpinner(
          translateText("common.loading") || "Joining room...",
        )}
      </div>`;
    }
    return html`
      <div class="flex flex-col gap-5 p-6">
        <div
          class="flex flex-col gap-1 rounded-xl border border-white/10 bg-black/30 p-4"
        >
          <span class="text-xs font-bold uppercase tracking-wider text-white/50"
            >${translateText("local_room.code_to_share") ||
            LABEL_CODE_TO_SHARE}</span
          >
          <button
            class="text-left font-mono text-4xl tracking-[0.3em] text-blue-300 hover:text-blue-200 uppercase"
            title=${translateText("common.copy") || "Copy"}
            @click=${() => void this.copyCode()}
          >
            ${this.roomCode}
          </button>
          <span class="text-xs text-white/40">${snapshot.transport}</span>
        </div>

        <ul class="flex flex-col gap-2">
          ${snapshot.roster.map(
            (c) =>
              html`<li
                class="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90"
              >
                <span class="font-semibold">${c.username}</span>
                ${c.clanTag
                  ? html`<span class="text-xs text-white/40"
                      >[${c.clanTag}]</span
                    >`
                  : null}
                ${c.spectator
                  ? html`<span class="text-xs text-white/40">spectating</span>`
                  : null}
              </li>`,
          )}
        </ul>

        <p class="text-xs text-white/50">
          ${translateText("local_room.seats", {
            count: snapshot.seatCount,
          }) || `${snapshot.seatCount} in the room`}
        </p>

        ${isHost
          ? html`
              <o-button
                variant="primary"
                width="block"
                size="lg"
                translationKey=${"local_room.start"}
                @click=${this.startRoom}
              ></o-button>
            `
          : html`<p
              class="text-center text-sm text-white/50 animate-pulse"
              role="status"
            >
              ${translateText("local_room.waiting_host") || LABEL_YOU_ARE_GUEST}
            </p>`}
      </div>
    `;
  }

  private async copyCode() {
    try {
      await navigator.clipboard.writeText(this.roomCode);
    } catch {
      // file:// or no clipboard permission: the code is already on screen in a
      // mono face and can be selected by hand.
    }
  }

  private startRoom = () => {
    const peer = activeLocalPeer();
    if (peer === null) {
      this.error = translateText("local_room.room_gone") || MSG_ROOM_GONE;
      return;
    }
    peer.requestLaunch();
  };

  protected onOpen() {
    this.error = "";
  }

  private async loadNationCount() {
    const map = this.selectedMap;
    try {
      const manifest = await this.mapLoader.getMapData(map).manifest();
      if (this.selectedMap !== map) return;
      this.defaultNationCount = manifest.nations.length;
      this.nations = this.compactMap
        ? Math.max(0, Math.floor(manifest.nations.length * 0.25))
        : manifest.nations.length;
    } catch {
      // A missing manifest is not worth a message here: the difficulty control
      // is the only thing that reads the count, and it simply stays on the
      // default.
    }
  }

  protected renderHeaderSlot(): TemplateResult {
    return modalHeader({
      title:
        this.step === "host"
          ? translateText("local_room.host_title") || TITLE_CREATE_ROOM
          : this.step === "join"
            ? translateText("local_room.join_title") || TITLE_JOIN_ROOM
            : this.step === "waiting"
              ? translateText("local_room.waiting") || TITLE_WAITING
              : translateText("local_room.title") || TITLE_LOCAL_ROOM,
      // In a room there is no "back" to an earlier screen: leaving is a
      // decision about the room itself, and confirmBeforeClose is what owns it.
      onBack: () =>
        this.step === "waiting" ? void this.close() : this.goHome(),
      ariaLabel: translateText("common.back"),
    });
  }

  private goHome() {
    this.step = "choose";
    this.error = "";
  }

  private renderError(): TemplateResult | null {
    if (this.error === "") return null;
    return html`<p
      class="mx-6 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
    >
      ${this.error}
    </p>`;
  }

  /**
   * The relay address, or null for the tab relay alone.
   *
   * Blank is a perfectly good answer (the tab relay needs nothing) so this is
   * only an error when the field has something in it that is not a URL.
   */
  private relayTarget(): string | null {
    const raw = this.relayUrl.trim();
    if (raw === "") return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error(`unsupported scheme ${url.protocol}`);
      }
      return url.toString();
    } catch (e) {
      // ES2020 target: no { cause } on Error yet (see the same note in
      // src/server/Privilege.ts). The raw value is echoed in the message so
      // nothing about the failure is lost.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${translateText("local_room.bad_relay_url") || MSG_BAD_RELAY}: ${raw}`,
      );
    }
  }

  private renderChoose(): TemplateResult {
    return html`
      <div class="flex flex-col gap-4 p-6">
        <p class="text-sm text-white/70">
          ${translateText("local_room.intro") || HINT_INTRO}
        </p>
        <o-button
          variant="primary"
          width="block"
          size="lg"
          translationKey=${"local_room.create"}
          @click=${() => {
            this.step = "host";
            this.error = "";
          }}
        ></o-button>
        <o-button
          variant="secondary"
          width="block"
          size="lg"
          translationKey=${"local_room.join"}
          @click=${() => {
            this.step = "join";
            this.error = "";
          }}
        ></o-button>
        <p class="text-xs text-white/40">${HINT_TABS_ONLY}</p>
      </div>
    `;
  }

  private renderJoin(): TemplateResult {
    const code = normalizeRoomCode(this.roomCode);
    return html`
      <div class="flex flex-col gap-4 p-6">
        <label class="flex flex-col gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-white/60"
            >${translateText("local_room.code") || LABEL_CODE}</span
          >
          <input
            id="local-room-code"
            class="rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-2xl uppercase tracking-[0.3em] text-white outline-none focus:border-blue-400"
            maxlength=${ROOM_CODE_LENGTH + 4}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            .value=${this.roomCode}
            @input=${(e: Event) => {
              this.roomCode = (e.target as HTMLInputElement).value;
              this.error = "";
            }}
            placeholder=${CODE_PLACEHOLDER}
          />
        </label>
        ${this.renderRelayField()} ${this.renderError()}
        <o-button
          variant="primary"
          width="block"
          size="lg"
          translationKey=${"local_room.enter"}
          .disable=${this.busy || code === null}
          @click=${this.joinRoom}
        ></o-button>
      </div>
    `;
  }

  private renderRelayField(): TemplateResult {
    return html`
      <label class="flex flex-col gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-white/60"
          >${translateText("local_room.relay") || LABEL_RELAY}</span
        >
        <input
          id="local-room-relay"
          class="rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-sm text-white outline-none focus:border-blue-400"
          autocomplete="off"
          spellcheck="false"
          .value=${this.relayUrl}
          @input=${(e: Event) => {
            this.relayUrl = (e.target as HTMLInputElement).value;
            this.error = "";
          }}
          placeholder=${RELAY_PLACEHOLDER}
        />
        <span class="text-xs text-white/40">
          ${translateText("local_room.relay_hint") || HINT_TABS_ONLY}
        </span>
      </label>
    `;
  }

  private renderHost(): TemplateResult {
    return html`
      <div class="flex flex-col h-full">
        <div
          class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 pt-4 pb-6 mr-1 mx-auto w-full max-w-5xl"
        >
          <game-config-settings
            class="block"
            .sectionGapClass=${"space-y-6"}
            .settings=${{
              map: {
                selected: this.selectedMap,
                useRandom: this.useRandomMap,
              },
              difficulty: {
                selected: this.selectedDifficulty,
                disabled: this.nations === 0,
              },
              gameMode: { selected: this.gameMode },
              teamCount: { selected: this.teamCount },
              options: {
                titleKey: "game_settings.options",
                bots: {
                  value: this.bots,
                  labelKey: "game_settings.bots",
                  disabledKey: "common.disabled",
                },
                nations: {
                  value: this.nations,
                  defaultValue: this.defaultNationCount,
                  labelKey: "game_settings.nations",
                  disabledKey: "common.disabled",
                },
                toggles: [
                  {
                    labelKey: "game_settings.instant_build",
                    checked: this.instantBuild,
                  },
                  {
                    labelKey: "game_settings.random_spawn",
                    checked: this.randomSpawn,
                  },
                  {
                    labelKey: "game_settings.infinite_gold",
                    checked: this.infiniteGold,
                  },
                  {
                    labelKey: "game_settings.infinite_troops",
                    checked: this.infiniteTroops,
                  },
                  {
                    labelKey: "game_settings.compact_map",
                    checked: this.compactMap,
                  },
                  {
                    labelKey: "game_settings.water_nukes",
                    checked: this.waterNukes,
                  },
                  {
                    labelKey: "game_settings.doomsday_clock",
                    checked: this.doomsdayClock,
                    doomsdayClockSpeed: this.doomsdayClockSpeed,
                  },
                ],
                inputCards: [],
              },
              unitTypes: {
                titleKey: "game_settings.disable_units",
                disabledUnits: [],
              },
            }}
            @map-selected=${(e: Event) => {
              this.selectedMap = (
                e as CustomEvent<{ map: GameMapType }>
              ).detail.map;
              this.useRandomMap = false;
              void this.loadNationCount();
            }}
            @random-map-selected=${() => {
              this.useRandomMap = true;
            }}
            @difficulty-selected=${(e: Event) => {
              this.selectedDifficulty = (
                e as CustomEvent<{ difficulty: Difficulty }>
              ).detail.difficulty;
            }}
            @doomsday-clock-speed-selected=${(e: Event) => {
              this.doomsdayClockSpeed = (
                e as CustomEvent<{ speed: DoomsdayClockSpeed }>
              ).detail.speed;
            }}
            @game-mode-selected=${(e: Event) => {
              this.gameMode = (
                e as CustomEvent<{ mode: GameMode }>
              ).detail.mode;
            }}
            @team-count-selected=${(e: Event) => {
              this.teamCount = (
                e as CustomEvent<{ count: TeamCountConfig }>
              ).detail.count;
            }}
            @bots-changed=${(e: Event) => {
              const value = (e as CustomEvent<{ value: number }>).detail.value;
              if (!Number.isNaN(value) && value >= 0 && value <= 400) {
                this.bots = value;
              }
            }}
            @nations-changed=${(e: Event) => {
              const value = (e as CustomEvent<{ value: number }>).detail.value;
              if (!Number.isNaN(value) && value >= 0 && value <= 400) {
                this.nations = value;
              }
            }}
            @option-toggle-changed=${(e: Event) => {
              const { labelKey, checked } = (
                e as CustomEvent<{ labelKey: string; checked: boolean }>
              ).detail;
              switch (labelKey) {
                case "game_settings.instant_build":
                  this.instantBuild = checked;
                  break;
                case "game_settings.random_spawn":
                  this.randomSpawn = checked;
                  break;
                case "game_settings.infinite_gold":
                  this.infiniteGold = checked;
                  break;
                case "game_settings.infinite_troops":
                  this.infiniteTroops = checked;
                  break;
                case "game_settings.compact_map":
                  this.compactMap = checked;
                  void this.loadNationCount();
                  break;
                case "game_settings.water_nukes":
                  this.waterNukes = checked;
                  break;
                case "game_settings.doomsday_clock":
                  this.doomsdayClock = checked;
                  break;
                default:
                  break;
              }
            }}
          ></game-config-settings>
        </div>
        <div class="p-6 border-t border-white/10 bg-black/20 shrink-0">
          ${this.renderError()}
          <o-button
            variant="primary"
            width="block"
            size="lg"
            translationKey=${"local_room.create_room"}
            .disable=${this.busy}
            @click=${this.createRoom}
          ></o-button>
        </div>
      </div>
    `;
  }

  protected renderBody(): TemplateResult {
    if (this.step === "host") return this.renderHost();
    if (this.step === "join") return this.renderJoin();
    if (this.step === "waiting") return this.renderWaiting();
    return this.renderChoose();
  }

  // ---------------------------------------------------------------------------
  // Entering the room
  // ---------------------------------------------------------------------------

  /**
   * Enter the room, as whoever this player is: the host for a new room, a guest
   * for an existing one.
   *
   * Both paths dispatch the same join-lobby the online flows do, so everything
   * downstream (the Transport fork, the worker, the terrain load) is the code
   * that already runs for a multiplayer game. What differs is only the
   * `localRoom` field, and that there is no gameStartInfo to bring along.
   */
  private async enterRoom(isHost: boolean, roomCode: string) {
    let relayUrl: string | null;
    try {
      relayUrl = this.relayTarget();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return;
    }
    const localRoom: LocalRoomConfig = {
      roomCode: roomToGameID(roomCode),
      isHost,
      relayUrl,
      config: {
        gameMap: this.useRandomMap ? getRandomMapType() : this.selectedMap,
        gameMapSize: this.compactMap ? GameMapSize.Compact : GameMapSize.Normal,
        // Private, not Singleplayer: this is a multiplayer-shaped game, and the
        // engine treats the two differently (no spawn timer for singleplayer,
        // human slots for private).
        gameType: GameType.Private,
        gameMode: this.gameMode,
        difficulty: this.selectedDifficulty,
        playerTeams: this.teamCount,
        donateGold: this.gameMode === GameMode.Team,
        donateTroops: this.gameMode === GameMode.Team,
        bots: this.bots,
        nations: sliderToNationsConfig(this.nations, this.defaultNationCount),
        infiniteGold: this.infiniteGold,
        infiniteTroops: this.infiniteTroops,
        instantBuild: this.instantBuild,
        randomSpawn: this.randomSpawn,
        ...(this.waterNukes ? { waterNukes: true } : {}),
        ...(this.doomsdayClock
          ? { doomsdayClock: { enabled: true, speed: this.doomsdayClockSpeed } }
          : {}),
      },
    };

    // Warm the cosmetics cache so the start does not wait on a catalog fetch
    // that a local build has no API to answer.
    void getPlayerCosmetics().catch(() => undefined);

    this.busy = true;
    // Show the waiting room from here rather than waiting for the room to
    // answer: Main's join path runs several awaits before the peer even
    // exists, and a button left busy across them reads as a dead click.
    this.step = "waiting";
    this.inRoom = true;
    this.snapshot = null;
    this.error = "";
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: roomToGameID(roomCode),
          localRoom,
          source: "local-room",
        } satisfies JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
    // The button's busy state is now the room's to answer, not the click's.
    this.busy = false;
  }

  private async createRoom() {
    if (this.busy) return;
    // A room code is 8 characters off a 32-symbol alphabet, so a collision with
    // a room that is open RIGHT NOW is not worth a retry loop: the relay that
    // owns the code is the one tab, and two tabs cannot both be hosting the
    // same code (each opens its own BroadcastChannel, and only one of them runs
    // a relay).
    const code = generateRoomCode();
    await this.enterRoom(true, code);
  }

  private async joinRoom() {
    if (this.busy) return;
    const code = normalizeRoomCode(this.roomCode);
    if (code === null) {
      this.error = translateText("local_room.bad_code") || MSG_BAD_CODE;
      return;
    }
    await this.enterRoom(false, code);
  }

  /**
   * Leaving while the room is still a lobby takes the player out of the room,
   * not just the dialog.
   *
   * Two cases must NOT do that: a dialog closed on its way out because the
   * game started (Main's prestart handler closes it for everyone), and a
   * dialog closed before anything ever joined. Both are covered by `inRoom`
   * plus the room's own `inLobby` flag.
   */
  protected onClose() {
    this.busy = false;
    const stillInLobby =
      this.inRoom && (this.snapshot?.inLobby ?? activeLocalPeer() !== null);
    this.inRoom = false;
    if (!stillInLobby) return;
    document.dispatchEvent(
      new CustomEvent("leave-lobby", {
        detail: { lobby: this.roomCode, cause: "player-left" },
        bubbles: true,
        composed: true,
      }),
    );
    this.step = "choose";
    this.snapshot = null;
  }
}
