import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfigSchema } from "@openfront/engine-api/Schemas";
import { ServerMessage } from "@openfront/shared/WireSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  createDirectHub,
  generateRoomCode,
  HubFrame,
  isRelayFrame,
  LOCAL_ROOM_HASH_PREFIX,
  LocalHubSet,
  localRoomCodeFromHash,
  normalizeRoomCode,
  RELAY_AUTHOR,
  ROOM_CODE_LENGTH,
} from "../../src/client/local/LocalHub";
import { LocalPeer, LocalRoomConfig } from "../../src/client/local/LocalPeer";
import {
  clientIDFromPersistentID,
  PeerRelayServer,
} from "../../src/client/local/PeerRelayServer";
import { resetLocalModeCache } from "../../src/client/LocalMode";
import {
  clearLastGameRecord,
  getLastGameRecord,
} from "../../src/client/LocalReplay";

/**
 * The room code is also the game id, so it has to satisfy GAME_ID_REGEX
 * (8-10 alphanumeric) on its own — a code a peer could type but the wire would
 * refuse is a room that can never start.
 */
function expectValidGameID(code: string): void {
  expect(code).toMatch(/^[A-Za-z0-9]{8,10}$/);
}

function roomConfig(overrides: Partial<LocalRoomConfig> = {}): LocalRoomConfig {
  return {
    roomCode: "ABCD2345",
    isHost: false,
    relayUrl: null,
    config: GameConfigSchema.parse({
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Normal,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      playerTeams: 1,
      donateGold: false,
      donateTroops: false,
      bots: 10,
      nations: "default",
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    }),
    ...overrides,
  };
}

/**
 * A hub set that records everything sent on it and lets a test inject frames as
 * if they had arrived over a transport.
 *
 * Deliberately NOT a real BroadcastChannel (jsdom has none) and not a
 * WebSocket: what is under test is the room's protocol, not the browser's
 * transport, and an in-memory hub keeps the exact order of the exchange
 * readable in one test.
 */
function fakeHub(): LocalHubSet & {
  sent: HubFrame[];
  inject(frame: HubFrame): void;
} {
  const handlers = new Set<(frame: HubFrame) => void>();
  const sent: HubFrame[] = [];
  return {
    hubs: [],
    sent,
    inject(frame) {
      for (const handler of [...handlers]) handler(frame);
    },
    describe: () => "fake",
    send(frame) {
      sent.push(frame);
      // Delivers to the sender too, like createHubSet: a host's own frames
      // must reach its own relay, and a frame a test sends must be observable
      // by whatever it is being tested against.
      for (const handler of [...handlers]) handler(frame);
    },
    onFrame(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
    },
  };
}

function bootstrap() {
  ClientEnv.reset();
  resetLocalModeCache();
  (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    turnstileSiteKey: "x",
    jwtAudience: "localhost",
    gitCommit: "test",
    local: true,
  };
  ClientEnv.reset();
}

describe("local room codes", () => {
  it("mints codes that are valid game ids and exclude ambiguous glyphs", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expectValidGameID(code);
      // I and O (and 0, 1) are the ones a human retyping a code off one
      // screen into another gets wrong, so they must never appear.
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("normalises case and separators without ever inventing a different room", () => {
    expect(normalizeRoomCode("abcd2345")).toBe("ABCD2345");
    expect(normalizeRoomCode("  abcd 2345 ")).toBe("ABCD2345");
    expect(normalizeRoomCode("ABCD-2345")).toBe("ABCD2345");

    // The glyphs the generator can never emit are REFUSED, not folded onto a
    // neighbouring one: every folded guess on a 32-symbol alphabet has a real
    // chance of naming a different, perfectly valid room, and joining a
    // stranger's game silently is worse than being asked to retype.
    expect(normalizeRoomCode("abcd234i")).toBeNull();
    expect(normalizeRoomCode("abcd234o")).toBeNull();
    expect(normalizeRoomCode("abcd2340")).toBeNull();
    expect(normalizeRoomCode("abcd2341")).toBeNull();
    // Lowercase l uppercases to an ordinary L, which IS in the alphabet.
    expect(normalizeRoomCode("abcd234l")).toBe("ABCD234L");
  });

  it("rejects anything that cannot be the room it claims to be", () => {
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode("ABCD234")).toBeNull(); // too short
    expect(normalizeRoomCode("ABCD23456")).toBeNull(); // too long
    expect(normalizeRoomCode("ABCD!!")).toBeNull();
    expect(normalizeRoomCode("nope")).toBeNull();
  });

  it("reads its own hash form back out of a URL", () => {
    expect(localRoomCodeFromHash(`#${LOCAL_ROOM_HASH_PREFIX}ABCD2345`)).toBe(
      "ABCD2345",
    );
    expect(localRoomCodeFromHash("#modal=single-player")).toBeNull();
    expect(localRoomCodeFromHash("")).toBeNull();
    expect(localRoomCodeFromHash(`#${LOCAL_ROOM_HASH_PREFIX}nope`)).toBeNull();
  });
});

describe("createDirectHub", () => {
  it("delivers a frame to every handler, sender included", () => {
    const hub = createDirectHub();
    const seen: HubFrame[] = [];
    const stop = hub.onFrame((frame) => seen.push(frame));
    hub.send({ k: "launch", author: "a" });
    hub.send({ k: "launch", author: "b" });
    expect(seen).toHaveLength(2);

    // Unsubscribing is what keeps a superseded transport from answering the
    // room after the player left it.
    stop();
    hub.send({ k: "launch", author: "c" });
    expect(seen).toHaveLength(2);
    hub.close();
  });

  it("describes itself as the in-tab endpoint", () => {
    expect(createDirectHub().kind).toBe("direct");
    expect(createDirectHub().endpoint).toBe("this tab");
  });
});

describe("clientIDFromPersistentID", () => {
  it("is stable for one identity and a legal clientID", () => {
    const a = clientIDFromPersistentID("persistent-a");
    expect(a).toBe(clientIDFromPersistentID("persistent-a"));
    expectValidGameID(a);
  });

  it("separates two identities", () => {
    expect(clientIDFromPersistentID("persistent-a")).not.toBe(
      clientIDFromPersistentID("persistent-b"),
    );
  });
});

describe("PeerRelayServer", () => {
  let hub: ReturnType<typeof fakeHub>;
  let relay: PeerRelayServer;

  function makeRelay(): PeerRelayServer {
    return new PeerRelayServer(
      hub,
      "ABCD2345",
      roomConfig().config,
      1_700_000_000_000,
      "HOSTPEER1",
    );
  }

  function hello(
    peerId: string,
    overrides: Partial<Extract<HubFrame, { k: "hello" }>> = {},
  ): void {
    relay.onFrame({
      k: "hello",
      author: peerId,
      persistentID: peerId,
      username: `player-${peerId}`,
      clanTag: null,
      spectator: false,
      ...overrides,
    });
  }

  function turns(): (HubFrame & { k: "turn" })[] {
    return hub.sent.filter(
      (f): f is HubFrame & { k: "turn" } => f.k === "turn",
    );
  }

  beforeEach(() => {
    bootstrap();
    hub = fakeHub();
    relay = makeRelay();
  });

  it("seats each peer and broadcasts the roster", () => {
    relay.start();
    hello("HOSTPEER1");
    hello("OTHER1");
    const rosters = hub.sent.filter(
      (f): f is HubFrame & { k: "lobby" } => f.k === "lobby",
    );
    expect(rosters.length).toBeGreaterThan(0);
    const last = rosters[rosters.length - 1];
    expect(last.clients.map((c) => c.username)).toEqual([
      "player-HOSTPEER1",
      "player-OTHER1",
    ]);
    expect(relay.seatCount()).toBe(2);
    relay.stop("end");
  });

  it("keeps a peer's seat and identity across a re-announce", () => {
    relay.start();
    hello("HOSTPEER1");
    const clientID = relay.roster()[0].clientID;
    hello("HOSTPEER1", { username: "renamed" });
    expect(relay.roster()).toHaveLength(1);
    expect(relay.roster()[0].clientID).toBe(clientID);
    expect(relay.roster()[0].username).toBe("renamed");
    relay.stop("end");
  });

  it("refuses to start a game on anyone's word but the host's", () => {
    relay.start();
    hello("HOSTPEER1");
    hello("OTHER1");
    relay.onFrame({ k: "launch", author: "OTHER1" });
    expect(relay.hasStarted()).toBe(false);
    expect(
      hub.sent.some(
        (f) => f.k === "error" && f.error === "only-the-host-can-start",
      ),
    ).toBe(true);
    relay.stop("end");
  });

  it("builds the start message from the roster, in roster order", () => {
    relay.start();
    hello("HOSTPEER1");
    hello("OTHER1");
    relay.onFrame({ k: "launch", author: "HOSTPEER1" });
    expect(relay.hasStarted()).toBe(true);

    const start = hub.sent.find((f) => f.k === "start");
    expect(start).toBeDefined();
    if (start?.k !== "start") throw new Error("unreachable");

    expect(start.gameStartInfo.gameID).toBe("ABCD2345");
    expect(start.gameStartInfo.players.map((p) => p.username)).toEqual([
      "player-HOSTPEER1",
      "player-OTHER1",
    ]);
    // Order and clientIDs are the whole invariant: every peer simulates from
    // this array, so a mismatch is a different game on every machine.
    expect(start.gameStartInfo.players.map((p) => p.clientID)).toEqual([
      relay.roster()[0].clientID,
      relay.roster()[1].clientID,
    ]);
    expect(start.gameStartInfo.players[0].isLobbyCreator).toBe(true);
    expect(start.gameStartInfo.players[1].isLobbyCreator).toBe(false);
    relay.stop("end");
  });

  it("stamps an intent with the sender's clientID", () => {
    relay.start();
    hello("HOSTPEER1");
    relay.onFrame({ k: "launch", author: "HOSTPEER1" });
    relay.onFrame({
      k: "intent",
      author: "HOSTPEER1",
      intent: { type: "toggle_pause", paused: true },
    });
    expect(turns()).toHaveLength(1);
    expect(turns()[0].turn.intents[0].clientID).toBe(
      relay.roster()[0].clientID,
    );
    relay.stop("end");
  });

  it("holds the next turn until every seated peer has finished the last", () => {
    // The relay from beforeEach is on real timers; swap it out before faking
    // them, or its lobby/sweep intervals would keep firing on a clock the test
    // no longer controls.
    relay.stop("end");
    hub = fakeHub();
    vi.useFakeTimers();
    try {
      relay = makeRelay();
      relay.start();
      hello("HOSTPEER1");
      hello("OTHER1");
      relay.onFrame({ k: "launch", author: "HOSTPEER1" });
      hub.sent.length = 0;

      // The FIRST turn needs no ACK: nothing has been sent, so every peer is
      // trivially caught up and the clock seals turn 0 on its own.
      vi.advanceTimersByTime(1_000);
      expect(turns()).toHaveLength(1);
      expect(turns()[0].turn.turnNumber).toBe(0);

      hub.sent.length = 0;
      // From here every seated peer must finish the previous turn before the
      // next is sealed: a peer that ran ahead would be simulating from a turn
      // nobody else has.
      vi.advanceTimersByTime(1_000);
      expect(turns()).toHaveLength(0);

      relay.onFrame({ k: "turnComplete", author: "HOSTPEER1", turnNumber: 0 });
      vi.advanceTimersByTime(1_000);
      expect(turns()).toHaveLength(0);

      relay.onFrame({ k: "turnComplete", author: "OTHER1", turnNumber: 0 });
      vi.advanceTimersByTime(1_000);
      expect(turns().length).toBeGreaterThan(0);
    } finally {
      relay.stop("end");
      vi.useRealTimers();
    }
  });

  it("treats a late arrival as a spectator rather than a seat", () => {
    relay.start();
    hello("HOSTPEER1");
    hello("OTHER1");
    relay.onFrame({ k: "launch", author: "HOSTPEER1" });
    hello("LATE1");
    expect(relay.seatCount()).toBe(2);
    expect(relay.roster()).toHaveLength(3);
    expect(relay.roster()[2].spectator).toBe(true);
    relay.stop("end");
  });

  it("answers a ping with a pong", () => {
    relay.start();
    hello("HOSTPEER1");
    hub.sent.length = 0;
    relay.onFrame({ k: "ping", author: "HOSTPEER1", sentAt: 42 });
    expect(hub.sent).toContainEqual({
      k: "pong",
      author: RELAY_AUTHOR,
      sentAt: 42,
    });
    relay.stop("end");
  });

  it("never folds its own broadcasts back into the room", () => {
    relay.start();
    hello("HOSTPEER1");
    const before = relay.roster().length;
    hub.inject({
      k: "lobby",
      author: RELAY_AUTHOR,
      clients: [],
      config: roomConfig().config,
    });
    expect(relay.roster()).toHaveLength(before);
    relay.stop("end");
  });

  it("ignores frames it did not hear through its own start", () => {
    relay.start();
    hello("HOSTPEER1");
    // Not launched: intents are meaningless before the game exists.
    relay.onFrame({
      k: "intent",
      author: "HOSTPEER1",
      intent: { type: "toggle_pause", paused: true },
    });
    expect(turns()).toHaveLength(0);
    relay.stop("end");
  });
});

describe("LocalPeer", () => {
  let hub: ReturnType<typeof fakeHub>;
  let received: ServerMessage[];

  function connect(config: LocalRoomConfig): LocalPeer {
    hub = fakeHub();
    received = [];
    const peer = new LocalPeer(hub, config);
    peer.updateCallback(
      () => {},
      (message) => received.push(message),
    );
    peer.start();
    return peer;
  }

  function join(peer: LocalPeer, username = "Ada"): void {
    peer.onMessage({
      type: "join",
      gameID: "ABCD2345",
      username,
      clanTag: null,
      cosmetics: {},
      turnstileToken: null,
      token: "t",
      spectator: false,
      gitCommit: "test",
      platform: "windows",
    } as never);
  }

  beforeEach(() => {
    bootstrap();
  });

  it("announces itself once the join carries a name", () => {
    const peer = connect(roomConfig());
    hub.sent.length = 0;
    join(peer);
    const hello = hub.sent.find((f) => f.k === "hello");
    expect(hello).toBeDefined();
    if (hello?.k !== "hello") throw new Error("unreachable");
    expect(hello.username).toBe("Ada");
    // The clientID the relay will derive is this peer's own derivation, so the
    // two never disagree about who it is.
    expect(peer.clientID).toBe(clientIDFromPersistentID(hello.persistentID));
    peer.endGame();
  });

  it("does not seat an identity it has no name for yet", () => {
    const peer = connect(roomConfig());
    hub.sent.length = 0;
    peer.onMessage({
      type: "rejoin",
      gameID: "ABCD2345",
      lastTurn: 0,
      token: "t",
      gitCommit: "test",
    } as never);
    expect(hub.sent.some((f) => f.k === "hello")).toBe(false);
    peer.endGame();
  });

  it("relays gameplay intents for the room to stamp", () => {
    const peer = connect(roomConfig());
    join(peer);
    hub.sent.length = 0;

    peer.onMessage({
      type: "intent",
      intent: { type: "spawn", tile: { x: 1, y: 2 } },
    } as never);
    const intents = hub.sent.filter((f) => f.k === "intent");
    expect(intents).toHaveLength(1);
    if (intents[0]?.k !== "intent") throw new Error("unreachable");
    // The server stamps the clientID — a peer that sent its own would be
    // claiming an identity the room did not assign it.
    expect("clientID" in intents[0].intent).toBe(false);
    expect(intents[0].author).not.toBe("");
    peer.endGame();
  });

  it("ACKs every turn it is given, and nothing before it", () => {
    const peer = connect(roomConfig());
    join(peer);
    hub.sent.length = 0;

    peer.turnComplete();
    let acks = hub.sent.filter(
      (f): f is HubFrame & { k: "turnComplete" } => f.k === "turnComplete",
    );
    expect(acks).toHaveLength(1);
    // Nothing received, so nothing finished: -1 is the "no turn yet" marker
    // the relay's high-water mark is designed to accept.
    expect(acks[0].turnNumber).toBe(-1);

    hub.inject({
      k: "turn",
      author: RELAY_AUTHOR,
      turn: { turnNumber: 7, intents: [] },
    });
    expect(received[received.length - 1]).toEqual({
      type: "turn",
      turn: { turnNumber: 7, intents: [] },
    });

    peer.turnComplete();
    acks = hub.sent.filter(
      (f): f is HubFrame & { k: "turnComplete" } => f.k === "turnComplete",
    );
    expect(acks[acks.length - 1].turnNumber).toBe(7);
    peer.endGame();
  });

  it("turns a relay start frame into the start message joinLobby expects", () => {
    const peer = connect(roomConfig());
    join(peer);

    hub.inject({
      k: "start",
      author: RELAY_AUTHOR,
      gameStartInfo: {
        gameID: "ABCD2345",
        lobbyCreatedAt: 1,
        config: roomConfig().config,
        players: [{ clientID: peer.clientID, username: "Ada", clanTag: null }],
      },
    });

    const start = received.find((m) => m.type === "start");
    expect(start).toBeDefined();
    if (start?.type !== "start") throw new Error("unreachable");
    expect(start.myClientID).toBe(peer.clientID);
    expect(start.gameStartInfo.gameID).toBe("ABCD2345");
    peer.endGame();
  });

  it("hosts a relay; a guest does not", () => {
    const host = connect(roomConfig({ isHost: true }));
    expect(host.relayServer).not.toBeNull();
    // The relay broadcasts the roster the moment it starts — and it must be
    // heard, which is why LocalPeer subscribes before constructing it.
    expect(hub.sent.some((f) => f.k === "lobby")).toBe(true);
    host.endGame();

    const guest = connect(roomConfig({ isHost: false }));
    expect(guest.relayServer).toBeNull();
    guest.endGame();
  });

  it("reports a relay-authored close as an error the client can act on", () => {
    const guest = connect(roomConfig());
    hub.inject({ k: "closed", author: RELAY_AUTHOR, reason: "host-left" });
    expect(received).toContainEqual({ type: "error", error: "host-left" });
    guest.endGame();
  });

  it("does not turn a frame from another peer into a client message", () => {
    const guest = connect(roomConfig());
    join(guest);
    // A guest has no relay to hand it to, so peer traffic is simply not its
    // business; only the relay ever produces a ServerMessage.
    guest["onFrame"]({
      k: "hello",
      author: "SOMEPEER",
      persistentID: "SOMEPEER",
      username: "Bob",
      clanTag: null,
      spectator: false,
    });
    expect(received.filter((m) => m.type === "lobby_info")).toHaveLength(0);
    guest.endGame();
  });

  it("keeps a record of the game it was dealt, for the win screen", () => {
    const peer = connect(roomConfig());
    join(peer);
    clearLastGameRecord();
    // The record carries the build's own commit, and the schema only accepts
    // a real 40-hex sha or the literal "DEV" — neither of which this file's
    // bootstrap config ("test") is. The offline build sets DEV, so that is
    // what the shape under test has to be exercised with.
    (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
      ...(window.BOOTSTRAP_CONFIG as object),
      gitCommit: "DEV",
    };
    ClientEnv.reset();

    hub.inject({
      k: "start",
      author: RELAY_AUTHOR,
      gameStartInfo: {
        gameID: "ABCD2345",
        lobbyCreatedAt: 1,
        config: roomConfig().config,
        players: [{ clientID: peer.clientID, username: "Ada", clanTag: null }],
      },
    });
    // createPartialGameRecord drops turns that carry neither intents nor a
    // hash, so these are hashed the way a real turn of a real game is.
    hub.inject({
      k: "turn",
      author: RELAY_AUTHOR,
      turn: { turnNumber: 0, intents: [], hash: 101 },
    });
    hub.inject({
      k: "turn",
      author: RELAY_AUTHOR,
      turn: { turnNumber: 1, intents: [], hash: 102 },
    });

    // Every player's stats are required by the record's schema, and they only
    // arrive with the winner — so nothing can have been kept yet.
    expect(getLastGameRecord()).toBeNull();

    peer.onMessage({
      type: "winner",
      winner: ["player", peer.clientID],
      allPlayersStats: { [peer.clientID]: {} },
    } as never);

    const record = getLastGameRecord();
    expect(record).not.toBeNull();
    if (record === null) throw new Error("unreachable");
    expect(record.info.gameID).toBe("ABCD2345");
    expect(record.turns).toHaveLength(2);
    expect(record.info.players).toHaveLength(1);
    expect(record.info.players[0].clientID).toBe(peer.clientID);

    // A second winner would publish a record built from a turn list this peer
    // is still appending to.
    peer.onMessage({
      type: "winner",
      winner: ["player", peer.clientID],
      allPlayersStats: { [peer.clientID]: {} },
    } as never);
    expect(getLastGameRecord()?.turns).toHaveLength(2);
    peer.endGame();
  });
});

describe("isRelayFrame", () => {
  it("narrows to relay-authored frames only", () => {
    expect(isRelayFrame({ k: "launch", author: "HOSTPEER1" })).toBe(false);
    expect(
      isRelayFrame({
        k: "turn",
        author: RELAY_AUTHOR,
        turn: { turnNumber: 1, intents: [] },
      }),
    ).toBe(true);
  });
});
