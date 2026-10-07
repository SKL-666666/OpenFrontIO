import {
  AllPlayersStats,
  GameID,
  Intent,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import { WireGameStartInfo } from "@openfront/shared/WireSchemas";

/**
 * How local peers reach each other. Three implementations, one contract:
 *
 *   - `"direct"`     — one page: the host's relay and its own peer.
 *   - `"broadcast"`  — several tabs of the SAME browser (BroadcastChannel).
 *                      No process anywhere.
 *   - `"relay"`      — several machines, through the optional
 *                      scripts/lan-host.mjs dumb frame relay.
 *
 * Every hub is a pure broadcast: a frame posted by anyone is delivered to
 * everyone, sender included. There is no addressing and no delivery
 * guarantee beyond "the browser got it to the other tabs" — the relay is a
 * firehose, and the frames themselves say who they are for.
 *
 * That is deliberate. The simulation is deterministic and runs in EVERY peer's
 * worker (see docs/Architecture.md), so the only thing the "server" has to get
 * right is that all peers seal the SAME turn. Whoever is hosting owns the turn
 * clock and broadcasts the sealed turn; a lost or reordered frame would desync
 * the room, which the peers' own hash checks surface (see
 * PeerRelayServer.onHash). Addressing and per-peer reliability would buy
 * nothing a 100ms turn clock and a hash check do not already give.
 *
 * A hub itself is only the transport: `send` puts a frame on the wire for the
 * OTHER peers, `onFrame` is what the other peers' frames invoke, and the
 * sender's own copy of its frame is delivered by `LocalDelivery` — which
 * `createHubSet` composes across both of its transports so a frame is handled
 * exactly once however many ways it travelled.
 *
 * Frames are plain JSON, not the zbin binary the real wire uses: the zbin
 * clientID dictionary is seeded from the start message and has to be threaded
 * through every encode/decode, which buys bytes this transport does not need.
 */

/**
 * The author of a frame the room's relay produced, as opposed to a peer.
 *
 * Every frame carries the id of whoever wrote it, and both ends of the room
 * filter on it: PeerRelayServer drops anything authored by the relay (its own
 * broadcasts come back through the local delivery), and LocalPeer acts only on
 * those and hands everything else to the relay. That one convention is what
 * makes an unaddressed broadcast safe to fan out to everyone.
 */
export const RELAY_AUTHOR = "__relay__";

/** Where the room's relay lives, from a peer's point of view. */
export type LocalHubKind = "direct" | "broadcast" | "relay";

export type HubFrame =
  /** A peer announcing itself, or re-announcing on a rejoin. */
  | {
      k: "hello";
      author: string;
      persistentID: string;
      username: string;
      clanTag: string | null;
      spectator: boolean;
    }
  /** A peer leaving on purpose. Absent on a tab close, which the relay learns by timeout. */
  | { k: "bye"; author: string }
  /** Relay -> peers: the roster, while the room is still in the lobby. */
  | {
      k: "lobby";
      author: typeof RELAY_AUTHOR;
      clients: {
        clientID: string;
        username: string;
        clanTag: string | null;
        spectator: boolean;
      }[];
      config: WireGameStartInfo["config"];
    }
  /** Relay -> peers: the game is starting; every peer simulates THIS. */
  | {
      k: "start";
      author: typeof RELAY_AUTHOR;
      gameStartInfo: WireGameStartInfo;
    }
  /** Relay -> peers: the sealed turn. Identical bytes everywhere, by construction. */
  | { k: "turn"; author: typeof RELAY_AUTHOR; turn: Turn }
  /** Relay -> peers: this peer's hash disagrees with the majority. */
  | {
      k: "desync";
      author: typeof RELAY_AUTHOR;
      turnNumber: number;
      yourHash: number;
    }
  /** Relay -> one peer: refused, or thrown out. */
  | {
      k: "error";
      author: typeof RELAY_AUTHOR;
      /** The peer it is for, since the hub is an unaddressed broadcast. */
      to?: string;
      error: string;
      message?: string;
    }
  /** Relay -> one peer: latency check. */
  | { k: "pong"; author: typeof RELAY_AUTHOR; sentAt: number }
  /** Peer -> relay: a gameplay intent, still un-stamped. */
  | { k: "intent"; author: string; intent: Intent }
  /** Peer -> relay: this peer finished processing turn `turnNumber`. */
  | { k: "turnComplete"; author: string; turnNumber: number }
  /** Peer -> relay: state hash, for the desync check. */
  | { k: "hash"; author: string; turnNumber: number; hash: number }
  /** Peer -> relay: latency check. */
  | { k: "ping"; author: string; sentAt: number }
  /** Peer -> relay: the host wants the game to begin. */
  | { k: "launch"; author: string }
  /** Peer -> relay: the game was decided. */
  | {
      k: "winner";
      author: string;
      winner: Winner;
      allPlayersStats: AllPlayersStats;
    }
  /** Relay -> peers: the host ended the room. */
  | { k: "closed"; author: typeof RELAY_AUTHOR; reason: string };

/**
 * The frame transport under a local room. Pure broadcast, as described above.
 *
 * `send` puts a frame out for the OTHER peers; it does not deliver the frame to
 * this peer, which is `LocalDelivery`'s job. `onFrame` is therefore the other
 * peers' frames, not this one's — with the exception of the direct hub, which
 * has no remote side and so is the degenerate case where sending IS receiving.
 *
 * `send` never throws on a dead hub: a peer whose relay socket is down has
 * already been surfaced to the player by the reconnecting hub implementation,
 * and dropping the frame is what "the room is not there right now" means.
 */
export interface LocalHub {
  readonly kind: LocalHubKind;
  /** Human-readable target, for the room's UI ("tab relay", the relay URL). */
  readonly endpoint: string;
  send(frame: HubFrame): void;
  /** Subscribes to frames received from the other peers. */
  onFrame(handler: (frame: HubFrame) => void): () => void;
  close(): void;
}

/** The room code doubles as the game's id, so it must satisfy GAME_ID_REGEX. */
export const ROOM_CODE_LENGTH = 8;

/** Unambiguous alphabet: no I/O/0/1, so a code read off one screen and typed
 *  into another cannot be mistyped into a different room. */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A fresh room code. Uppercase, 8 chars — valid as a GameID (see GAME_ID_REGEX). */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Normalise what a player typed into a room code, or null if it can't be one.
 *
 * Deliberately does NOT fold glyphs onto each other — no I→J, no O→Q. Every
 * wrong guess on a 32-symbol alphabet has a decent chance of naming a DIFFERENT
 * valid room, and a player who gets silently connected to a stranger's game is
 * far worse off than one asked to retype a character. All this does is forgive
 * the things that cannot change identity: case, and the spaces or dashes people
 * paste a code with.
 *
 * Anything that leaves an 8-character code outside ROOM_CODE_ALPHABET — which
 * is where every character the generator never emits (I, O, 0, 1) lands — is
 * refused, so the caller can say the code is wrong rather than guess.
 */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]+/g, "");
  if (code.length !== ROOM_CODE_LENGTH) return null;
  if (![...code].every((c) => ROOM_CODE_ALPHABET.includes(c))) return null;
  return code;
}

export const roomToGameID = (code: string): GameID => code;

/** Hash form of a room in the page URL: `#local-room=CODE`. */
export const LOCAL_ROOM_HASH_PREFIX = "local-room=";

/** The room code a URL hash names, or null if it names none. */
export function localRoomCodeFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const at = raw.indexOf(LOCAL_ROOM_HASH_PREFIX);
  if (at === -1) return null;
  return normalizeRoomCode(raw.slice(at + LOCAL_ROOM_HASH_PREFIX.length));
}

/**
 * The in-tab half of a hub: who receives a frame once a transport has it.
 *
 * `deliver` runs for every frame a hub accepts, INCLUDING one this peer just
 * sent. That is not a nicety: BroadcastChannel and the relay process both skip
 * the sender (the channel never echoes, and lan-host.mjs explicitly does
 * `if (peer === ws) continue`), while the host's own peer and the host's own
 * relay live in the same tab and MUST exchange frames through here. Without it,
 * a host playing over the broadcast hub would be the one player whose intents
 * never reached the room.
 *
 * It is an object rather than a per-hub field because `createHubSet` runs two
 * transports at once and hands them BOTH this one: a frame that went out on the
 * broadcast channel and out on the relay must still be delivered to each
 * handler exactly once, or the room would process every intent twice. So the
 * transports deliver INCOMING frames through it, and only `createHubSet`'s
 * `send` delivers a frame it originated — see createHubSet.
 */
export interface LocalDelivery {
  deliver(frame: HubFrame): void;
  add(handler: (frame: HubFrame) => void): () => void;
  clear(): void;
}

export function createLocalDelivery(): LocalDelivery {
  const handlers = new Set<(frame: HubFrame) => void>();
  return {
    deliver(frame: HubFrame): void {
      // Snapshot, so a handler that subscribes or unsubscribes while it runs
      // cannot corrupt the iteration.
      for (const handler of [...handlers]) handler(frame);
    },
    add(handler: (frame: HubFrame) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    clear(): void {
      handlers.clear();
    },
  };
}

/**
 * In-page bus, for the host tab: the relay and the host's own peer live in the
 * same document, so "the network" is a function call and there is no remote
 * side at all — sending and receiving are the same thing.
 *
 * Handlers run synchronously on send. That is a hazard rather than a
 * convenience: PeerRelayServer.endTurn broadcasts a turn, and a synchronous
 * delivery re-enters the relay from inside its own clock tick. The snapshot in
 * LocalDelivery keeps a send from mutating the listener set mid-iteration, and
 * the relay never mutates its own roster while handling a frame it is
 * delivering — but the rule holds regardless: a hub handler must not block.
 */
export function createDirectHub(
  local: LocalDelivery = createLocalDelivery(),
): LocalHub {
  return {
    kind: "direct",
    endpoint: "this tab",
    send(frame) {
      local.deliver(frame);
    },
    onFrame: local.add,
    close: local.clear,
  };
}

/**
 * Several tabs of the same browser, with nothing listening on a port.
 *
 * BroadcastChannel is same-origin and same-profile, so this covers exactly
 * "open the game in two tabs", which is the case that needs no setup at all.
 * It does not echo to the sender, so `send` only transmits and the originator's
 * copy is delivered by whoever composed this hub (see LocalDelivery).
 */
export function createBroadcastHub(
  roomCode: string,
  local: LocalDelivery = createLocalDelivery(),
): LocalHub {
  const channel = new BroadcastChannel(`openfront-local-${roomCode}`);
  channel.onmessage = (event: MessageEvent) => {
    local.deliver(event.data as HubFrame);
  };
  return {
    kind: "broadcast",
    endpoint: "other tabs of this browser",
    send(frame) {
      try {
        channel.postMessage(frame);
      } catch (e) {
        console.warn("local hub: broadcast failed", e);
      }
    },
    onFrame: local.add,
    close() {
      channel.onmessage = null;
      local.clear();
      channel.close();
    },
  };
}

/**
 * Several machines, through scripts/lan-host.mjs.
 *
 * That process is a dumb frame relay: it moves JSON between the sockets in one
 * room and runs no game logic at all, so the simulation still happens in each
 * player's own browser (see LocalHub's doc comment).
 *
 * The room code rides the URL as a query param, because one relay process can
 * serve several rooms — peers in different rooms must not see each other's
 * frames. The relay groups sockets by that param and deliberately does NOT
 * echo a frame back to its sender (lan-host.mjs, `if (peer === ws) continue`),
 * so the sender's own copy is delivered locally instead: instant, and still
 * delivered while the socket is down, which a round trip would not be.
 */
export function createRelayHub(
  url: string,
  roomCode: string,
  local: LocalDelivery = createLocalDelivery(),
): LocalHub {
  let target: string;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("room", roomCode);
    target = parsed.toString();
  } catch {
    target = url;
  }
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let retryTimer: number | null = null;

  const scheduleReconnect = () => {
    if (closed || retryTimer !== null) return;
    // Same backoff shape as Transport's game socket: immediate first retry,
    // then doubling to a 10s ceiling. A relay that is not up yet is the normal
    // case for a guest who typed the host's address before it was started.
    const delay =
      attempts === 0 ? 0 : Math.min(10_000, 500 * 2 ** (attempts - 1));
    attempts++;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    let next: WebSocket;
    try {
      next = new WebSocket(target);
    } catch (e) {
      console.warn("local hub: relay URL rejected", e);
      scheduleReconnect();
      return;
    }
    socket = next;
    next.onopen = () => {
      attempts = 0;
    };
    next.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: HubFrame;
      try {
        frame = JSON.parse(event.data) as HubFrame;
      } catch {
        return;
      }
      local.deliver(frame);
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      scheduleReconnect();
    };
    next.onerror = () => {
      // onclose always follows; the reconnect is scheduled there, so that a
      // failed attempt cannot start two overlapping retry chains.
      next.close();
    };
  };

  connect();

  return {
    kind: "relay",
    endpoint: target,
    send(frame) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(frame));
    },
    onFrame: local.add,
    close() {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      local.clear();
      socket?.close();
      socket = null;
    },
  };
}

/**
 * Pick the hub a room should use.
 *
 * A BroadcastChannel only reaches other tabs of THIS browser, which is right for
 * "open it twice" and useless for the friend on the same wifi. So the room
 * always runs BOTH: the tab relay is always available, and when the player
 * gives a relay address the LAN hub is used too — every frame goes out on both,
 * so a second tab and a second machine land in the same room.
 */
export interface LocalHubSet {
  hubs: LocalHub[];
  /** "tab relay" / "tab relay + ws://…" — shown in the room UI. */
  describe(): string;
  send(frame: HubFrame): void;
  onFrame(handler: (frame: HubFrame) => void): () => void;
  close(): void;
}

export function createHubSet(
  roomCode: string,
  relayUrl: string | null,
): LocalHubSet {
  // ONE delivery for the whole set. Both transports run their own sender-side
  // delivery, so handing each its own would double every frame the moment a
  // player gave a relay address — a single intent from the host would become
  // two in the sealed turn. Sharing this is what makes "send once, handle once"
  // true no matter how many transports are carrying it.
  const local = createLocalDelivery();
  const broadcast = createBroadcastHub(roomCode, local);
  const relay =
    relayUrl === null ? null : createRelayHub(relayUrl, roomCode, local);
  const hubs = relay === null ? [broadcast] : [broadcast, relay];
  return {
    hubs,
    describe() {
      const parts = ["tab relay"];
      if (relay !== null) parts.push(relay.endpoint);
      return parts.join(" + ");
    },
    send(frame) {
      // Each transport only puts the frame on the wire for the other peers;
      // the sender's own copy is delivered here, exactly once. Letting each
      // transport do it would double every frame the moment a player gave a
      // relay address, and a single intent from the host would become two in
      // the sealed turn.
      for (const hub of hubs) hub.send(frame);
      local.deliver(frame);
    },
    onFrame: local.add,
    close() {
      for (const hub of hubs) hub.close();
      local.clear();
    },
  };
}

/** Narrowing helper for the frames a relay frame can never carry. */
export function isRelayFrame(
  frame: HubFrame,
): frame is HubFrame & { author: typeof RELAY_AUTHOR } {
  return frame.author === RELAY_AUTHOR;
}
