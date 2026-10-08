/**
 * Small typed key/value store over localStorage for the local build.
 *
 * Deliberately not `UserSettings`: that class is the game's settings surface
 * (graphics, audio, HUD), is read by components all over the client, and its
 * schema is validated on load. This is preference memory for *this fork's*
 * quality-of-life features — what the last game was set to, which relay the
 * last room used — which nothing else reads and which must never be able to
 * throw.
 *
 * Every read is guarded: a corrupt value, a quota error or a private-browsing
 * store that refuses writes all fall back to the caller's default rather than
 * taking down the menu that asked.
 */

const PREFIX = "ofl.";

function keyOf(key: string): string {
  return PREFIX + key;
}

/** Read a JSON value, or `fallback` when it is missing or unreadable. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(keyOf(key));
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Never let a preference break the screen that reads it.
    return fallback;
  }
}

/** Write a JSON value. Silently ignored where storage is unavailable. */
export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(keyOf(key), JSON.stringify(value));
  } catch {
    // Quota exceeded or disabled storage: the preference simply doesn't stick.
  }
}

export function removePref(key: string): void {
  try {
    localStorage.removeItem(keyOf(key));
  } catch {
    // See writePref.
  }
}

/**
 * Preference names used by this fork.
 *
 * Kept as constants rather than string literals so a typo fails typecheck
 * instead of silently writing a second, never-read key.
 */
export const PREFS = {
  /** Last game speed, so a new game doesn't start at 1x every time. */
  gameSpeed: "game-speed",
  /** The last LAN relay address typed into the room dialog. */
  lastRelayUrl: "last-relay-url",
  /** The last room code entered (or created), for "rejoin last room". */
  lastRoomCode: "last-room-code",
  /** Last singleplayer config, so a reopened modal is what you were playing. */
  singlePlayerConfig: "single-player-config",
  /** Last local-room host config, same idea for the LAN dialog. */
  localRoomConfig: "local-room-config",
} as const;
