import { Turn, Winner } from "@openfront/engine-api/Schemas";
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import {
  GameRecord,
  GameRecordSchema,
  PartialGameRecord,
  PartialGameRecordSchema,
  PlayerRecord,
  WireGameStartInfo,
} from "@openfront/shared/WireSchemas";
import { z } from "zod";
import { ClientEnv } from "./ClientEnv";

/**
 * The record of the game that just ended, kept where it can actually be used.
 *
 * The client has always built this record — `LocalServer.archiveGameRecord`
 * assembles it turn by turn and then uploads it — but on a local build the
 * upload is the only thing that ever happened to it, so the record was built
 * and thrown away. Holding it here is what makes "watch it back" and "save it"
 * possible at all, and it is a single slot on purpose: the prompt belongs to
 * the game that just finished, not to a history the player can browse.
 */
let current: GameRecord | null = null;

/**
 * Publish the finished record.
 *
 * Validation lives here rather than at the call site: every producer hands over
 * something assembled by `createPartialGameRecord`, and the one thing that can
 * quietly differ between a local build and the API is `gitCommit` — which the
 * replay reader checks, and which no local build ever stamped on the record.
 */
export function setLastGameRecord(record: unknown): void {
  const stamped =
    record !== null && typeof record === "object"
      ? { ...(record as Record<string, unknown>), gitCommit: safeGitCommit() }
      : record;
  const parsed = GameRecordSchema.safeParse(stamped);
  if (!parsed.success) {
    console.warn(
      "local replay: record rejected",
      parsed.error.issues.slice(0, 3),
    );
    current = null;
    return;
  }
  current = parsed.data;
}

/**
 * Assemble the record of a finished local game and publish it above.
 *
 * Two local hosts build exactly this object: the singleplayer `LocalServer`,
 * and every peer of a LAN room, which deals itself the same turns a server
 * would have (the relay seals one and broadcasts it to the room). The parse
 * lives here rather than at the call sites because a record that does not
 * validate must never reach the win screen — "watch it back" would only fail
 * on it afterwards.
 *
 * @returns the parsed record, or null when it did not validate.
 */
export function keepLocalGameRecord(args: {
  gameStartInfo: WireGameStartInfo;
  players: PlayerRecord[];
  turns: Turn[];
  startedAt: number;
  endedAt: number;
  winner: Winner | undefined;
}): PartialGameRecord | null {
  const record = createPartialGameRecord(
    args.gameStartInfo.gameID,
    args.gameStartInfo.config,
    args.players,
    args.turns,
    args.startedAt,
    args.endedAt,
    args.winner,
  );
  const parsed = PartialGameRecordSchema.safeParse(record);
  if (!parsed.success) {
    console.error(
      "local replay: record rejected",
      z.prettifyError(parsed.error),
    );
    return null;
  }
  setLastGameRecord(parsed.data);
  return parsed.data;
}

/** The record of the last finished game, or null if there isn't one. */
export function getLastGameRecord(): GameRecord | null {
  return current;
}

export function clearLastGameRecord(): void {
  current = null;
}

/**
 * The commit this build reports, or "DEV".
 *
 * Wrapped because ClientEnv throws when the page carries no bootstrap config,
 * and this runs in a teardown path where an exception would cost the player
 * the win screen. "DEV" is also what skips the replay reader's version check,
 * so a locally kept record stays openable.
 */
function safeGitCommit(): string {
  try {
    return ClientEnv.gitCommit();
  } catch {
    return "DEV";
  }
}

/**
 * Write the record to disk as plain JSON.
 *
 * Plain, not gzipped: the browser's own download does the storage, the file is
 * a few megabytes at most, and an uncompressed record is one a player can
 * actually inspect or diff. The reader takes JSON directly — the API's archive
 * endpoint is what gzips.
 */
export function downloadGameRecord(record: GameRecord): void {
  const blob = new Blob([JSON.stringify(record)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${record.info.gameID}.json`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay: revoking synchronously races the download start in
  // some browsers and produces an empty file.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
