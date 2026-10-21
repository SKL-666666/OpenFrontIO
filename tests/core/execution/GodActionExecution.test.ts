import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { GodActionKind } from "@openfront/engine/execution/GodActionExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { setup } from "../../util/Setup";

function human(name: string, clientID: string): PlayerInfo {
  return new PlayerInfo(name, PlayerType.Human, clientID, `${clientID}_id`);
}

async function spawnedGame() {
  const players = [human("god", "client_god"), human("victim", "client_v")];
  const game = await setup("big_plains", {}, players);
  game.addExecution(...players.map((p) => new SpawnExecution("game_id", p)));
  game.executeNextTick();
  game.executeNextTick();
  return game;
}

function godExec(
  game: Awaited<ReturnType<typeof spawnedGame>>,
  action: GodActionKind,
  amount?: number,
  tile?: number,
  unit?: UnitType,
) {
  const executor = new Executor(game, "game_id", "client_god");
  const exec = executor.createExec({
    type: "god_action",
    action,
    targetSmallID: game.playerByClientID("client_v")!.smallID(),
    amount,
    tile,
    unit,
    clientID: "client_god",
  } as never);
  expect(exec.isActive()).toBe(false);
  return exec;
}

function firstTile(
  game: Awaited<ReturnType<typeof spawnedGame>>,
  pred: (tile: number) => boolean,
): number {
  let found = -1;
  game.forEachTile((t) => {
    if (found === -1 && pred(t)) found = t;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

describe("GodActionExecution", () => {
  test("adds gold to another player", async () => {
    const game = await spawnedGame();
    const victim = game.playerByClientID("client_v")!;
    const before = victim.gold();

    game.addExecution(godExec(game, "gold", 1_000_000));
    game.executeNextTick();

    // The tick also pays territory income, so only the floor is predictable.
    expect(victim.gold() - before).toBeGreaterThanOrEqual(1_000_000n);
  });

  test("adds troops to another player", async () => {
    const game = await spawnedGame();
    const victim = game.playerByClientID("client_v")!;
    const before = victim.troops();

    game.addExecution(godExec(game, "troops", 500));
    game.executeNextTick();

    // Troops also regenerate during the tick.
    expect(victim.troops()).toBeGreaterThanOrEqual(before + 500);
  });

  test("lets the god wipe out another player", async () => {
    const game = await spawnedGame();
    const god = game.playerByClientID("client_god")!;
    const victim = game.playerByClientID("client_v")!;
    expect(victim.isAlive()).toBe(true);
    const godTilesBefore = god.numTilesOwned();

    game.addExecution(godExec(game, "conquer"));
    game.executeNextTick();

    expect(victim.isAlive()).toBe(false);
    expect(victim.numTilesOwned()).toBe(0);
    // The victim's land (and at least the land it started with) is now god's.
    expect(god.numTilesOwned()).toBeGreaterThan(godTilesBefore);
    expect(god.isAlive()).toBe(true);
  });

  test("sinks a land tile to water", async () => {
    const game = await spawnedGame();
    const tile = firstTile(
      game,
      (t) => game.map().isLand(t) && !game.map().hasOwner(t),
    );

    game.addExecution(godExec(game, "water", undefined, tile));
    game.executeNextTick();

    expect(game.map().isLand(tile)).toBe(false);
  });

  test("raises a water tile back to land", async () => {
    const game = await spawnedGame();
    // big_plains is all land, so sink a tile first, then raise it back.
    const tile = firstTile(
      game,
      (t) => game.map().isLand(t) && !game.map().hasOwner(t),
    );
    game.setWater(tile);
    expect(game.map().isLand(tile)).toBe(false);

    game.addExecution(godExec(game, "land", undefined, tile));
    game.executeNextTick();

    expect(game.map().isLand(tile)).toBe(true);
  });

  test("gives a tile to a player", async () => {
    const game = await spawnedGame();
    const victim = game.playerByClientID("client_v")!;
    const tile = firstTile(
      game,
      (t) =>
        game.map().isLand(t) &&
        !game.map().isImpassable(t) &&
        game.owner(t) !== victim,
    );
    const before = victim.numTilesOwned();

    game.addExecution(godExec(game, "give", undefined, tile));
    game.executeNextTick();

    expect(game.owner(tile)).toBe(victim);
    expect(victim.numTilesOwned()).toBe(before + 1);
  });

  test("erases a player's tile back to TerraNullius", async () => {
    const game = await spawnedGame();
    const victim = game.playerByClientID("client_v")!;
    const tile = firstTile(game, (t) => game.owner(t) === victim);

    game.addExecution(godExec(game, "erase", undefined, tile));
    game.executeNextTick();

    expect(game.owner(tile).isPlayer()).toBe(false);
  });

  test("builds a free structure for a player", async () => {
    const game = await spawnedGame();
    const tile = firstTile(
      game,
      (t) => game.map().isLand(t) && !game.map().isImpassable(t),
    );
    const before = game.units(UnitType.City).length;

    game.addExecution(godExec(game, "build", undefined, tile, UnitType.City));
    game.executeNextTick();

    expect(game.units(UnitType.City).length).toBe(before + 1);
  });

  test("ignores an unknown target", async () => {
    const game = await spawnedGame();
    const executor = new Executor(game, "game_id", "client_god");
    game.addExecution(
      executor.createExec({
        type: "god_action",
        action: "gold",
        targetSmallID: 9999,
        amount: 5,
        clientID: "client_god",
      } as never),
    );
    expect(() => game.executeNextTick()).not.toThrow();
  });
});
