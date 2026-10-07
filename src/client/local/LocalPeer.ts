import {
  ClientID,
  GameConfigSchema,
  GameID,
} from "@openfront/engine-api/Schemas";
import { ClientMessage, ServerMessage } from "@openfront/shared/WireSchemas";
import { z } from "zod";
import { getPersistentID } from "../Auth";
import { HubFrame, LocalHubSet, RELAY_AUTHOR } from "./LocalHub";
import {
  activeLocalPeer,
  notifyLocalRoomUpdate,
  setActiveLocalPeer,
  type LocalRoomSnapshot,
} from "./LocalRoomState";
import {
  clientIDFromPersistentID,
  PeerRelayServer,
  type RoomRosterEntry,
} from "./PeerRelayServer";

/** The game a local room runs. */
export type LocalGameConfig = z.infer<typeof GameConfigSchema>;

/**
 * How often this peer refreshes its `hello`.
 *
 * The relay sweeps a silent peer after PEER_TIMEOUT_MS, so this is the safety
 * margin beneath that: a peer whose transport hiccuped (a hub reconnect, a
 * throttled background tab) is re-announced before it can be swept out of a
 * roster it is still in.
 */
const HELLO_REFRESH_MS = 5_000;

const PING_INTERVAL_MS = 5_000;

/** What a local room is, from one tab's point of view. */
export interface LocalRoomConfig {
  /** The room code, which doubles as the game id (see GAME_ID_REGEX). */
  roomCode: GameID;
  /** Whether this tab created the room, and therefore runs its relay. */
  isHost: boolean;
  /**
   * The game to run. Only the HOST's copy is ever used: the relay broadcasts
   * the config it was built with, so a guest that guessed the map wrong still
   * plays the map the room was actually created with.
   */
  config: LocalGameConfig;
  /**
   * Where to reach the optional LAN frame relay (scripts/lan-host.mjs), or null
   * to use the tab relay alone.
   *
   * Null is not "no multiplayer": every room also runs a BroadcastChannel hub,
   * so a second tab of this browser always finds it. A relay URL is only what
   * adds peers on OTHER machines.
   */
  relayUrl?: string | null;
}

/**
 * One local player's end of a local room.
 *
 * Deliberately the SAME surface as LocalServer — updateCallback / start /
 * onMessage / turnComplete / endGame — because Transport already routes every
 * local game through that shape. A local multiplayer game is then a fourth
 * answer to `isLocal` rather than a new transport: intents, hashes, winners,
 * live stats and pause keep working through the code that already has them,
 * and the failure modes a real socket has (reconnect budget, session
 * readiness, frame buffering) simply do not exist here.
 *
 * The relay (PeerRelayServer, host tab only) is created and owned here too,
 * because "this tab is the room" and "this tab is a player in the room" are
 * settled by the same click: a host runs both, joined by one in-page hub.
 */
export class LocalPeer {
  /** The relay, when this tab is hosting. Null for a guest. */
  private relay: PeerRelayServer | null = null;

  private clientConnect: (() => void) | null = null;
  private clientMessage: ((message: ServerMessage) => void) | null = null;

  private unsubscribe: (() => void) | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** This peer's own persistent id: its stable identity for the whole room. */
  private readonly peerId = getPersistentID();

  /**
   * This peer's clientID, derived locally with the SAME function the relay
   * derives it with. Computing it here rather than reading it back off the
   * roster is what lets a peer start simulating before any lobby broadcast has
   * reached it, and it is the reason a room needs no handshake to agree on who
   * everybody is.
   */
  private readonly myClientID: ClientID =
    clientIDFromPersistentID(getPersistentID());

  /** Identity from the `join` message Transport sends right after start(). */
  private username = "";
  private clanTag: string | null = null;
  private spectator = false;

  /** The turn currently being processed, or -1 before the first one arrives. */
  private currentTurn = -1;

  /**
   * The last roster broadcast, for a guest: only the host runs a relay, so a
   * guest keeps what the relay told it rather than asking for it.
   */
  private lastLobby: RoomRosterEntry[] = [];

  /**
   * The room's `start` broadcast has been seen. Both roles see it (the host's
   * own copy comes back through the local delivery), so it is the one signal
   * for "the lobby is closed" that is true for every player rather than only
   * for whoever is hosting.
   */
  private gameStarted = false;

  private left = false;

  constructor(
    private readonly hub: LocalHubSet,
    private readonly room: LocalRoomConfig,
  ) {}

  get clientID(): ClientID {
    return this.myClientID;
  }

  get isSpectator(): boolean {
    return this.spectator;
  }

  /** The relay, when this tab hosts one. The room UI reads the roster from it. */
  get relayServer(): PeerRelayServer | null {
    return this.relay;
  }

  updateCallback(
    clientConnect: () => void,
    clientMessage: (message: ServerMessage) => void,
  ): void {
    this.clientConnect = clientConnect;
    this.clientMessage = clientMessage;
  }

  start(): void {
    if (this.left) return;

    // Publish first. The relay broadcasts the roster the moment it starts, and
    // notifyLocalRoomUpdate() only answers while an active peer exists to read
    // from — registered any later, the room's very first roster would be
    // dropped and the waiting panel would sit on its spinner until the next
    // broadcast a second later.
    setActiveLocalPeer(this);

    // Subscribe BEFORE the relay exists, not after: the relay's first action is
    // broadcastLobby(), and a listener attached a line too late would drop the
    // room's first roster as well. Nothing else can be in flight yet, and
    // `relay` is only read for peer-authored frames, none of which exist until
    // the block below returns.
    this.unsubscribe = this.hub.onFrame((frame) => this.onFrame(frame));

    // The host runs the room's relay AND plays in it, joined by one in-page
    // hub: the same tab is both the server and a player in it.
    if (this.room.isHost) {
      this.relay = new PeerRelayServer(
        this.hub,
        this.room.roomCode,
        this.room.config,
        Date.now(),
        this.peerId,
      );
      this.relay.start();
    }

    this.helloTimer = setInterval(() => this.sendHello(), HELLO_REFRESH_MS);
    this.pingTimer = setInterval(
      () =>
        this.hub.send({
          k: "ping",
          author: this.peerId,
          sentAt: Math.floor(performance.now()),
        }),
      PING_INTERVAL_MS,
    );

    this.clientConnect?.();
  }

  endGame(): void {
    if (this.left) return;
    this.left = true;
    // Only clear our own slot: a peer superseded by a newer join tears down
    // after the newer one has registered, and must not blank the new room.
    if (activeLocalPeer() === this) setActiveLocalPeer(null);
    this.clearTimers();
    // Stop listening before saying goodbye: a host's own `closed` frame comes
    // back through the local delivery, and announcing "the room ended" to a
    // player who is already tearing the room down is noise.
    this.unsubscribe?.();
    this.unsubscribe = null;
    // The host ends the ROOM, not just its own seat — the tab that owns the
    // relay going away ends every other player's game, so they are told why.
    // A guest just drops out of the roster, which is what `bye` means.
    if (this.relay !== null) {
      this.relay.stop("host-left");
    } else {
      this.hub.send({ k: "bye", author: this.peerId });
    }
    this.hub.close();
  }

  /**
   * What the room's UI renders, read fresh from the relay each time.
   *
   * A guest has no relay, so its roster comes from the lobby broadcasts it has
   * received — the same roster, kept by the other side.
   */
  snapshot(): LocalRoomSnapshot {
    const roster = this.relay?.roster() ?? this.lastLobby;
    return {
      roster,
      seatCount: roster.filter((c) => !c.spectator).length,
      transport: this.hub.describe(),
      // Read off this peer's own view of the start, not the relay's flag: a
      // guest has no relay, and both sides see the same `start` broadcast, so
      // this is the one signal that is true for every player in the room.
      inLobby: !this.gameStarted,
    };
  }

  private clearTimers(): void {
    if (this.helloTimer !== null) clearInterval(this.helloTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.helloTimer = null;
    this.pingTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Client -> room
  // ---------------------------------------------------------------------------

  /**
   * Everything Transport sends in a local game lands here and is translated
   * into the room's frame vocabulary. The three that carry identity (join,
   * rejoin, spectate) are handled here because they are the peer's own state;
   * everything else is a room-wide event.
   */
  onMessage(message: ClientMessage): void {
    if (this.left) return;
    switch (message.type) {
      case "join":
        this.username = message.username;
        this.clanTag = message.clanTag;
        this.spectator = message.spectator === true;
        this.sendHello();
        return;
      case "rejoin":
        this.sendHello();
        return;
      case "spectate":
        this.spectator = message.spectator;
        this.sendHello();
        return;
      case "intent":
        this.hub.send({
          k: "intent",
          author: this.peerId,
          intent: message.intent,
        });
        return;
      case "hash":
        this.hub.send({
          k: "hash",
          author: this.peerId,
          turnNumber: message.turnNumber,
          hash: message.hash,
        });
        return;
      case "winner":
        this.hub.send({
          k: "winner",
          author: this.peerId,
          winner: message.winner,
          allPlayersStats: message.allPlayersStats,
        });
        return;
      case "ping":
        this.hub.send({
          k: "ping",
          author: this.peerId,
          sentAt: Math.floor(performance.now()),
        });
        return;
      default:
        // log, report and live_stats have no local meaning: a room has no
        // moderation surface to report into, and the leaderboard a live-stats
        // feed feeds is the API's.
        return;
    }
  }

  /**
   * "I finished processing turn N" — the room's flow control.
   *
   * The relay will not seal another turn until every seated peer has sent this
   * for the one it is holding, so it goes out for EVERY turn, immediately, and
   * is never batched behind the next intent.
   */
  turnComplete(): void {
    if (this.left) return;
    this.hub.send({
      k: "turnComplete",
      author: this.peerId,
      turnNumber: this.currentTurn,
    });
  }

  /** The host's Start button. Ignored by every other peer (see PeerRelayServer). */
  requestLaunch(): void {
    this.hub.send({ k: "launch", author: this.peerId });
  }

  private sendHello(): void {
    // Nothing to announce before the join message carries a name: the relay
    // would seat an unnamed peer, and a reload before the join (a hub that took
    // its time) must not produce one.
    if (this.username === "") return;
    this.hub.send({
      k: "hello",
      author: this.peerId,
      persistentID: this.peerId,
      username: this.username,
      clanTag: this.clanTag,
      spectator: this.spectator,
    });
  }

  // ---------------------------------------------------------------------------
  // Room -> client
  // ---------------------------------------------------------------------------

  private onFrame(frame: HubFrame): void {
    // Everything NOT authored by the relay is input to the room, not to this
    // peer — and it is the relay that decides what it means. A guest has no
    // relay, so its own frames and every other peer's are simply not its
    // business; a host's are, including the ones it sent itself, which come
    // back through the hub's local delivery (see LocalDelivery).
    //
    // The relay's own broadcasts come back the same way, which is why they are
    // handled below rather than dropped: `broadcastLobby` from inside onFrame
    // would otherwise be swallowed by the guard above.
    if (frame.author !== RELAY_AUTHOR) {
      this.relay?.onFrame(frame);
      return;
    }
    switch (frame.k) {
      case "lobby":
        // joinLobby reads this as a lobby_info: it is where a guest learns the
        // map, which it starts downloading while the room is still waiting, and
        // where Main learns the roster for the presence payload.
        this.lastLobby = frame.clients;
        notifyLocalRoomUpdate("lobby");
        this.clientMessage?.({
          type: "lobby_info",
          lobby: {
            gameID: this.room.roomCode,
            clients: frame.clients,
            serverTime: Date.now(),
            gameConfig: frame.config,
            publicGameType: "hosted",
          },
          myClientID: this.myClientID,
        } satisfies ServerMessage);
        return;
      case "start":
        this.currentTurn = -1;
        this.gameStarted = true;
        notifyLocalRoomUpdate("start");
        this.clientMessage?.({
          type: "start",
          gameStartInfo: frame.gameStartInfo,
          turns: [],
          lobbyCreatedAt: frame.gameStartInfo.lobbyCreatedAt,
          myClientID: this.myClientID,
        } satisfies ServerMessage);
        return;
      case "turn":
        this.currentTurn = frame.turn.turnNumber;
        this.clientMessage?.({
          type: "turn",
          turn: frame.turn,
        } satisfies ServerMessage);
        return;
      case "desync":
        this.clientMessage?.({
          type: "desync",
          turn: frame.turnNumber,
          correctHash: null,
          clientsWithCorrectHash: 0,
          totalActiveClients: 1,
          yourHash: frame.yourHash,
        } satisfies ServerMessage);
        return;
      case "error":
        if (frame.to !== undefined && frame.to !== this.peerId) return;
        this.clientMessage?.({
          type: "error",
          error: frame.error,
          message: frame.message,
        } satisfies ServerMessage);
        return;
      case "pong":
        this.clientMessage?.({
          type: "pong",
          sentAt: frame.sentAt,
        } satisfies ServerMessage);
        return;
      case "closed":
        notifyLocalRoomUpdate("closed");
        this.clientMessage?.({
          type: "error",
          error: frame.reason,
        } satisfies ServerMessage);
        return;
      default:
        return;
    }
  }
}
