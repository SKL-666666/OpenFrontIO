import {
  AllPlayersStats,
  ClientID,
  GameConfigSchema,
  GameID,
  StampedIntent,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import {
  WireGameStartInfo,
  WireGameStartInfoSchema,
} from "@openfront/shared/WireSchemas";
import { z } from "zod";
import { ClientEnv } from "../ClientEnv";
import { HubFrame, LocalHubSet, RELAY_AUTHOR } from "./LocalHub";

/** One connected player in the room. */
interface Peer {
  peerId: string;
  clientID: ClientID;
  username: string;
  clanTag: string | null;
  spectator: boolean;
  /** Last time the peer proved it was alive (hello, turnComplete, hash or ping). */
  lastSeen: number;
  /** Highest turn number this peer has finished processing; -1 before its first. */
  ackedTurn: number;
}

export interface RoomRosterEntry {
  clientID: ClientID;
  username: string;
  clanTag: string | null;
  spectator: boolean;
}

/**
 * How long a peer may go silent before the room stops counting it.
 *
 * A tab that closes sends nothing �?BroadcastChannel has no close frame, and a
 * socket close is the relay process's business rather than a frame �?so silence
 * is the only signal there is. Generous on purpose: a peer dropped from the
 * ACK set while it is merely slow stops the whole room waiting for it, and one
 * dropped from the roster entirely loses its seat in a simulation that is
 * already running.
 */
const PEER_TIMEOUT_MS = 20_000;
const PEER_SWEEP_MS = 5_000;

/** How often the roster is rebroadcast while the room is still a lobby. */
const LOBBY_BROADCAST_MS = 1_000;

/** Hashes are compared on this cadence, as in the singleplayer LocalServer. */
const HASH_EVERY_TURNS = 100;

/**
 * The room's server, running in the HOST's browser tab.
 *
 * This is the piece that made the Node game server look necessary, and it is
 * deliberately small: bundle every peer's intents into a turn, seal it, and
 * hand the identical turn to everyone. The simulation itself never runs here �? * it runs in every peer's own worker (docs/Architecture.md) �?which is why the
 * sealed turn has to be byte-identical everywhere and why a peer that misses
 * one desyncs visibly rather than silently.
 *
 * What it deliberately does NOT do, though a real GameServer does, is on
 * purpose: no tokens, no rate limits, no rejoin validation, no disconnect
 * grace, no record archive, no telemetry. A local room has no adversary and no
 * archive to write to, so every one of those is cost with nothing to protect.
 */
export class PeerRelayServer {
  private readonly peers = new Map<string, Peer>();

  /** clientID by persistentID, so a peer that re-announces reclaims its seat. */
  private readonly clientIDsByPersistentID = new Map<string, ClientID>();

  private turns: Turn[] = [];
  private intents: StampedIntent[] = [];
  /** Sealed turns handed out; also the ACK high-water mark the room waits on. */
  private turnsSent = 0;
  private paused = false;
  /**
   * The turn clock is running: `launch()` has built the game.
   *
   * Distinct from `lobbyRunning` on purpose. They used to be one flag, which
   * meant start() latched the very thing launch() checked and the room could
   * never begin �?the guard has to be about the game, not about the timers
   * around it.
   */
  private started = false;
  /** The roster broadcasts are running; false once the game has started. */
  private lobbyRunning = false;
  private ended = false;

  private turnTimer: ReturnType<typeof setInterval> | null = null;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastTurnAt = 0;

  /** Reported state hash per turn, for the divergence check. */
  private hashes = new Map<number, Map<string, number>>();

  private winner: { winner: Winner; allPlayersStats: AllPlayersStats } | null =
    null;

  constructor(
    private readonly hub: LocalHubSet,
    private readonly gameID: GameID,
    private readonly config: z.infer<typeof GameConfigSchema>,
    private readonly createdAt: number,
    private readonly hostPeerId: string,
  ) {}

  start(): void {
    if (this.lobbyRunning || this.ended) return;
    this.lobbyRunning = true;
    this.broadcastLobby();
    this.lobbyTimer = setInterval(
      () => this.broadcastLobby(),
      LOBBY_BROADCAST_MS,
    );
    this.sweepTimer = setInterval(() => this.sweepPeers(), PEER_SWEEP_MS);
  }

  /** End the room and tell everyone why. Idempotent. */
  stop(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.hub.send({ k: "closed", author: RELAY_AUTHOR, reason });
  }

  private clearTimers(): void {
    if (this.turnTimer !== null) clearInterval(this.turnTimer);
    if (this.lobbyTimer !== null) clearInterval(this.lobbyTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.turnTimer = null;
    this.lobbyTimer = null;
    this.sweepTimer = null;
  }

  /**
   * Fold one frame from a peer into the room.
   *
   * `author` is the peer the frame claims to be from, and it is NOT verified �?   * it is simply the only handle an unaddressed broadcast gives us. A peer can
   * therefore impersonate another by putting their id in `author`. That is not
   * a boundary worth defending here: everyone in the room typed the same code
   * to get in, and the fix (a per-peer secret handshake) would cost a framing
   * protocol to protect nothing anyone in such a room wants.
   */
  onFrame(frame: HubFrame): void {
    if (this.ended) return;
    // The relay's own broadcasts come back on an echoing hub (the direct hub
    // delivers to the sender). Nothing else is ever authored by the relay.
    if (frame.author === RELAY_AUTHOR) return;
    switch (frame.k) {
      case "hello":
        this.onHello(frame);
        return;
      case "bye":
        if (this.peers.delete(frame.author)) this.broadcastLobby();
        return;
      case "launch":
        // Only the tab that created the room may start it. Anyone else asking
        // is told so rather than left wondering why nothing happened.
        if (frame.author === this.hostPeerId) this.launch();
        else this.sendError(frame.author, "only-the-host-can-start");
        return;
      case "intent":
        this.onIntent(frame);
        return;
      case "turnComplete":
        this.onTurnComplete(frame);
        return;
      case "hash":
        this.onHash(frame);
        return;
      case "ping":
        this.hub.send({
          k: "pong",
          author: RELAY_AUTHOR,
          sentAt: frame.sentAt,
        });
        return;
      case "winner":
        this.onWinner(frame.winner, frame.allPlayersStats);
        return;
      default:
        // Relay-authored frames (lobby, start, turn, ...) and anything added to
        // the frame union later: not ours to handle.
        return;
    }
  }

  private onHello(frame: Extract<HubFrame, { k: "hello" }>): void {
    const existing = this.peers.get(frame.author);
    if (existing !== undefined) {
      // A re-announce from a peer already seated (a Transport reconnect, or the
      // host's own peer re-announcing after a hub blip): keep the seat AND the
      // ACK position, and take the display fields, which the player may have
      // edited between joining and rejoining.
      existing.username = frame.username;
      existing.clanTag = frame.clanTag;
      existing.spectator = frame.spectator;
      existing.lastSeen = Date.now();
      this.broadcastLobby();
      return;
    }
    // The roster is frozen at start (GameServer does the same): a peer that
    // arrives late cannot be given a seat in a simulation everyone else is
    // already running. It can still watch.
    const spectator = this.started ? true : frame.spectator;
    this.peers.set(frame.author, {
      peerId: frame.author,
      clientID: this.clientIDFor(frame.persistentID),
      username: frame.username,
      clanTag: frame.clanTag,
      spectator,
      lastSeen: Date.now(),
      // -1 whatever the phase: a peer that arrives before the game has simply
      // not finished turn -1 yet, which is the same as "not yet".
      ackedTurn: -1,
    });
    this.broadcastLobby();
  }

  /**
   * A peer's clientID, derived from its persistentID.
   *
   * The real server derives it from a JWT claim; a local room has no auth, and
   * it needs the same two properties that derivation gives: STABLE, so a peer
   * that reloads or reconnects reclaims its own seat instead of appearing twice,
   * and DERIVED FROM SOMETHING ONLY ITSELF KNOWS, so two peers cannot collide by
   * picking the same display name.
   *
   * Collisions across a handful of players remain possible (a 32-bit hash over
   * a short space), and are accepted: the engine reads a repeated clientID as
   * the same player, which in a room this size is a cosmetic duplicate rather
   * than a broken game.
   */
  private clientIDFor(persistentID: string): ClientID {
    const existing = this.clientIDsByPersistentID.get(persistentID);
    if (existing !== undefined) return existing;
    const clientID = clientIDFromPersistentID(persistentID);
    this.clientIDsByPersistentID.set(persistentID, clientID);
    return clientID;
  }

  private sweepPeers(): void {
    const now = Date.now();
    let dropped = false;
    for (const peer of [...this.peers.values()]) {
      if (now - peer.lastSeen < PEER_TIMEOUT_MS) continue;
      this.peers.delete(peer.peerId);
      dropped = true;
    }
    if (dropped) this.broadcastLobby();
  }

  private onIntent(frame: Extract<HubFrame, { k: "intent" }>): void {
    if (!this.started || this.ended) return;
    const peer = this.peers.get(frame.author);
    if (peer === undefined) return;
    peer.lastSeen = Date.now();

    // Pause is a turn-affecting intent like any other, so it rides a sealed turn
    // exactly as it does in the singleplayer LocalServer: the pause takes
    // effect on the tick the client stamped it with, not whenever it arrived.
    if (frame.intent.type === "toggle_pause") {
      this.intents.push({ ...frame.intent, clientID: peer.clientID });
      this.endTurn();
      this.paused = frame.intent.paused;
      return;
    }
    // Everything else is dropped while paused, for the same reason: it would be
    // sealed into a turn that is not being simulated.
    if (this.paused) return;
    this.intents.push({ ...frame.intent, clientID: peer.clientID });
  }

  private onTurnComplete(
    frame: Extract<HubFrame, { k: "turnComplete" }>,
  ): void {
    const peer = this.peers.get(frame.author);
    if (peer === undefined) return;
    peer.lastSeen = Date.now();
    if (frame.turnNumber > peer.ackedTurn) peer.ackedTurn = frame.turnNumber;
  }

  private onHash(frame: Extract<HubFrame, { k: "hash" }>): void {
    const peer = this.peers.get(frame.author);
    if (peer === undefined) return;
    peer.lastSeen = Date.now();
    if (frame.turnNumber % HASH_EVERY_TURNS !== 0) return;
    let at = this.hashes.get(frame.turnNumber);
    if (at === undefined) {
      at = new Map();
      this.hashes.set(frame.turnNumber, at);
    }
    at.set(peer.peerId, frame.hash);
  }

  private onWinner(winner: Winner, allPlayersStats: AllPlayersStats): void {
    // Recorded and nothing more: a local room has no record to archive and no
    // successor lobby to hand out. Every peer detects the win itself, so the
    // win modal is already up on all of them.
    this.winner = { winner, allPlayersStats };
  }

  winnerOf(): { winner: Winner; allPlayersStats: AllPlayersStats } | null {
    return this.winner;
  }

  private sendError(peerId: string, error: string, message?: string): void {
    this.hub.send({
      k: "error",
      author: RELAY_AUTHOR,
      to: peerId,
      error,
      message,
    });
  }

  /** Roster + config, so a peer's UI can render the room it is waiting in. */
  broadcastLobby(): void {
    if (this.started || this.ended) return;
    this.hub.send({
      k: "lobby",
      author: RELAY_AUTHOR,
      clients: this.roster(),
      config: this.config,
    });
  }

  roster(): RoomRosterEntry[] {
    return [...this.peers.values()].map((p) => ({
      clientID: p.clientID,
      username: p.username,
      clanTag: p.clanTag,
      spectator: p.spectator,
    }));
  }

  /** Seats, not connections �?the number a lobby shows as its player count. */
  seatCount(): number {
    return this.roster().filter((p) => !p.spectator).length;
  }

  /**
   * Build the game and start the turn clock. Host-initiated.
   *
   * Everything here reaches every peer unchanged because it is computed once
   * and broadcast, not derived per recipient. That is the invariant the whole
   * room rests on: the players array's ORDER, the config and the gameID must
   * arrive in every worker identically, or the workers simulate different games
   * and the divergence only shows up as a map that disagrees.
   */
  launch(): void {
    if (this.started || this.ended) return;
    const gameStartInfo = {
      gameID: this.gameID,
      lobbyCreatedAt: this.createdAt,
      config: this.config,
      players: [...this.peers.values()].map((p) => ({
        clientID: p.clientID,
        username: p.username,
        clanTag: p.clanTag,
        isLobbyCreator: p.peerId === this.hostPeerId,
      })),
    } satisfies Partial<WireGameStartInfo> as WireGameStartInfo;
    const parsed = WireGameStartInfoSchema.safeParse(gameStartInfo);
    if (!parsed.success) {
      const detail = z.prettifyError(parsed.error).slice(0, 300);
      console.error("local room: bad game start info", detail);
      this.sendError(this.hostPeerId, "bad-game-config", detail);
      return;
    }
    this.started = true;
    if (this.lobbyTimer !== null) {
      clearInterval(this.lobbyTimer);
      this.lobbyTimer = null;
    }
    this.hub.send({
      k: "start",
      author: RELAY_AUTHOR,
      gameStartInfo: parsed.data,
    });
    this.lastTurnAt = Date.now();
    this.turnTimer = setInterval(() => this.tick(), 5);
  }

  private tick(): void {
    if (this.ended) return;
    // Flow control: a turn is sealed only once every connected player has
    // finished the previous one. The simulation is deterministic, so a peer
    // that ran ahead would be simulating from a turn nobody else has sealed.
    if (!this.everyoneAcked()) return;
    if (Date.now() - this.lastTurnAt < ClientEnv.turnIntervalMs()) return;
    this.lastTurnAt = Date.now();
    this.endTurn();
  }

  private everyoneAcked(): boolean {
    for (const peer of this.peers.values()) {
      // A spectator is in the roster but holds no seat, so its ACK is not
      // waited on �?a spectator that stalls must not stall the game.
      if (peer.spectator) continue;
      if (peer.ackedTurn < this.turnsSent - 1) return false;
    }
    return true;
  }

  /** Seal this tick's intents into a turn and hand it to every peer. */
  private endTurn(): void {
    if (this.paused) return;
    const pastTurn: Turn = {
      turnNumber: this.turns.length,
      intents: this.intents,
    };
    this.turns.push(pastTurn);
    this.intents = [];
    this.turnsSent++;
    // Compared against what the peers reported for this turn, so a divergent
    // one is told rather than left rendering a different map from everyone else.
    this.reportDivergence(pastTurn.turnNumber);
    this.hub.send({ k: "turn", author: RELAY_AUTHOR, turn: pastTurn });
  }

  private reportDivergence(turnNumber: number): void {
    const at = this.hashes.get(turnNumber);
    this.hashes.delete(turnNumber);
    if (at === undefined || at.size < 2) return;
    const entries = [...at.entries()];
    const [, majority] = entries[0];
    const odd = entries.filter(([, hash]) => hash !== majority);
    if (odd.length === 0) return;
    for (const [peerId, hash] of odd) {
      console.warn(
        `local room: hash divergence at turn ${turnNumber} (${hash} vs ${majority})`,
      );
      this.hub.send({
        k: "desync",
        author: RELAY_AUTHOR,
        turnNumber,
        yourHash: hash,
      });
      void peerId;
    }
  }

  hasStarted(): boolean {
    return this.started;
  }
}

/**
 * 8 chars of base36 from a 32-bit hash of the persistent id.
 *
 * Uppercase base36 inside GAME_ID_REGEX, and exactly EIGHT characters — which
 * is the part that has to be right: a 32-bit hash is at most 4294967295, and
 * that is only 7 base36 digits, so padding to 7 (the natural "minimum width")
 * yields a 7-char id and WireGameStartInfoSchema rejects the whole start
 * message. The room would then never launch, and every peer would sit in a
 * lobby that refuses to start. Pad to 8, then clamp with slice so a value that
 * somehow exceeded 36^8 still cannot produce a 9-char id.
 */
export function clientIDFromPersistentID(persistentID: string): ClientID {
  let hash = 0;
  for (let i = 0; i < persistentID.length; i++) {
    hash = (hash << 5) - hash + persistentID.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).toUpperCase().padStart(8, "0").slice(0, 8);
}
