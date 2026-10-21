import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Execution, Game, Player } from "../game/Game";
import type { ExecRecord, SnapshotWriter } from "../snapshot/SnapshotContext";
import { NoOpExecutionSnapshot } from "./NoOpExecution";

export type GodActionKind =
  | "gold"
  | "troops"
  | "conquer"
  | "build"
  | "water"
  | "land"
  | "give"
  | "erase";

/**
 * God mode's "mouse": reach into the simulation and act on the world.
 *
 * Two families of action:
 *  - player actions (gold/troops/conquer/build/give) hit the player named by
 *    `targetSmallID`;
 *  - terrain actions (water/land/erase) only touch the tile named by `tile`.
 *
 * Local/singleplayer only — a server strips client-sourced `god_action`s the
 * same way it does other host-only cheats. Applied during init like a Pause,
 * so it never lives across a tick and is never snapshotted.
 */
export class GodActionExecution implements Execution {
  constructor(
    // The god: the intent's sender (the local player). Performs conquests.
    private god: Player,
    private action: GodActionKind,
    private targetSmallID: number,
    private amount: number = 0,
    private tile: number | undefined = undefined,
    private unit: UnitType | undefined = undefined,
  ) {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(game: Game, _ticks: number): void {
    // Terrain brushes act on a tile, not a player.
    if (
      this.action === "water" ||
      this.action === "land" ||
      this.action === "erase"
    ) {
      this.applyTerrainAction(game);
      return;
    }

    // playerBySmallID is index-based; a hostile/out-of-range id can fall off
    // the array, so widen and guard for undefined and for the terra-nullius
    // sentinel (which is not a player).
    const target = game.playerBySmallID(this.targetSmallID) as
      | Player
      | undefined;
    if (target === undefined || !target.isPlayer()) {
      console.warn(`god_action target ${this.targetSmallID} not found`);
      return;
    }

    switch (this.action) {
      case "gold":
        target.addGold(BigInt(this.amount));
        break;
      case "troops":
        target.addTroops(this.amount);
        break;
      case "conquer":
        // Conquering yourself is a no-op; a dead target has nothing to take.
        // Mirrors PlayerExecution's elimination: hand over the gold/stats
        // bookkeeping first, then transfer every tile. Snapshot the tiles
        // because conquering mutates the set we are iterating.
        if (target !== this.god && target.isAlive()) {
          const tiles = [...target.tiles()];
          game.conquerPlayer(this.god, target);
          for (const tile of tiles) {
            this.god.conquer(tile);
          }
        }
        break;
      case "give":
        this.giveTile(game, target);
        break;
      case "build":
        this.build(game, target);
        break;
    }
  }

  private tileRef(game: Game): number | undefined {
    if (this.tile === undefined || !game.map().isValidRef(this.tile)) {
      return undefined;
    }
    return this.tile;
  }

  /** Paint the tile: give it to `target`, or erase/water/land it. */
  private giveTile(game: Game, target: Player): void {
    const tile = this.tileRef(game);
    if (tile === undefined) return;
    if (!game.map().isLand(tile) || game.map().isImpassable(tile)) return;
    // conquer reassigns the tile from any previous owner, and broadcasts it.
    target.conquer(tile);
  }

  private applyTerrainAction(game: Game): void {
    const tile = this.tileRef(game);
    if (tile === undefined) return;
    const map = game.map();

    switch (this.action) {
      case "water":
        // setWater refuses owned tiles, so take it back first.
        if (!map.isLand(tile)) return;
        this.relinquish(game, tile);
        game.setWater(tile);
        break;
      case "land":
        if (map.isLand(tile)) return;
        game.setLand(tile);
        break;
      case "erase":
        this.relinquish(game, tile);
        break;
    }
  }

  private relinquish(game: Game, tile: number): void {
    if (!game.map().hasOwner(tile)) return;
    const owner = game.owner(tile);
    if (owner.isPlayer()) owner.relinquish(tile);
  }

  private build(game: Game, target: Player): void {
    const tile = this.tileRef(game);
    if (tile === undefined || this.unit === undefined) return;
    if (!game.map().isLand(tile) || game.map().isImpassable(tile)) return;
    // God builds are free: refund whatever buildUnit charges straight back.
    const cost = game.unitInfo(this.unit).cost(game, target);
    try {
      (
        target.buildUnit as unknown as (
          u: UnitType,
          s: number,
          p: Record<string, unknown>,
        ) => unknown
      )(this.unit, tile, {});
      target.addGold(cost);
    } catch (err) {
      console.warn(`god_action build ${this.unit} failed:`, err);
    }
  }

  tick(_ticks: number): void {}

  // Never alive at a tick boundary, so never snapshotted; the empty NoOp record
  // just satisfies the writer's shape if it ever were.
  snapshot(_w: SnapshotWriter): ExecRecord {
    return NoOpExecutionSnapshot.write({});
  }

  restoreSnapshot(): void {}
}
