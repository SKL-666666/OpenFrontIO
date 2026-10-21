import { GameConfig } from "@openfront/engine-api/Schemas";
import { applyGameConfigPatch } from "@openfront/engine-lib/configuration/GameConfigPatch";
import { Execution, Game } from "../game/Game";
import type { ExecRecord, SnapshotWriter } from "../snapshot/SnapshotContext";
import { NoOpExecutionSnapshot } from "./NoOpExecution";

/**
 * Applies a host's config patch to the game's live config.
 *
 * The server intercepts `update_game_config` and mutates its own GameConfig
 * (which it then hands out at game start), so in multiplayer this execution
 * never runs. In local/singleplayer there is no server: the intent reaches the
 * turn, and this applies the patch in place. EngineConfig reads every rule off
 * that same GameConfig object, so the change takes effect immediately — this
 * is what powers the in-game "world laws" of god mode.
 */
export class UpdateGameConfigExecution implements Execution {
  constructor(private patch: Partial<GameConfig>) {}

  isActive(): boolean {
    // Applied during init, like PauseExecution: never alive at a tick boundary.
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(game: Game, _ticks: number): void {
    applyGameConfigPatch(game.config().gameConfig(), this.patch);
  }

  tick(_ticks: number): void {}

  // Never alive at a tick boundary, so it is never snapshotted; the empty NoOp
  // record just satisfies the writer's shape if it ever were.
  snapshot(_w: SnapshotWriter): ExecRecord {
    return NoOpExecutionSnapshot.write({});
  }

  restoreSnapshot(): void {}
}
