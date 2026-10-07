import type { LocalPeer } from "./LocalPeer";
import type { RoomRosterEntry } from "./PeerRelayServer";

/**
 * The local room the page is currently in, if any, and the notification the
 * room's UI listens to.
 *
 * A room spans three things that are otherwise not connected: `Main` owns the
 * join, `Transport` owns the LocalPeer that talks to the room, and
 * `LocalRoomModal` renders the roster while everyone waits for the host to
 * start. None of them can name another directly (Transport is constructed
 * inside joinLobby, which Main only holds a handle to), so the peer registers
 * itself here on start and unregisters on teardown, and the modal reads it.
 *
 * One active room at a time is the real invariant: `Main.handleJoinLobby`
 * stops the previous lobby handle before starting the next, so a stale peer
 * can never be in this slot.
 */
let peer: LocalPeer | null = null;

/** Document event fired whenever the room's own state may have changed. */
export const LOCAL_ROOM_UPDATE = "local-room-update";

/**
 * @param next the room's peer, or null when the page is in no room.
 * Called from LocalPeer.start/endGame.
 */
export function setActiveLocalPeer(next: LocalPeer | null): void {
  peer = next;
}

/** The room the page is in, or null. The UI's read side. */
export function activeLocalPeer(): LocalPeer | null {
  return peer;
}

/**
 * Announce that something about the room changed: a player joined, the
 * lobby's map was chosen, the game started.
 *
 * A document event rather than a callback, because the listener is a Lit
 * component that mounts and unmounts with the page while the peer lives in the
 * join, and an event is the one mechanism that needs neither side to hold a
 * reference to the other.
 *
 * @param reason a short tag for logs; the payload is always pulled fresh from
 * activeLocalPeer(), so it is diagnostic only.
 */
export function notifyLocalRoomUpdate(reason: string): void {
  if (peer === null) return;
  document.dispatchEvent(
    new CustomEvent(LOCAL_ROOM_UPDATE, {
      detail: { reason },
      bubbles: true,
      composed: true,
    }),
  );
}

/** What the room UI needs to render. Pulled fresh, never cached. */
export interface LocalRoomSnapshot {
  roster: RoomRosterEntry[];
  seatCount: number;
  /** The relay endpoint, so the UI can show what the room is reachable over. */
  transport: string;
  /** False once the host has started the game and the lobby is closed. */
  inLobby: boolean;
}
