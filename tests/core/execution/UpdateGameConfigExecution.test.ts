import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { setup } from "../../util/Setup";

function human(clientID: string): PlayerInfo {
  return new PlayerInfo("player", PlayerType.Human, clientID, "player_id");
}

describe("UpdateGameConfigExecution", () => {
  test("applies a host config patch to the live game config", async () => {
    const game = await setup(
      "big_plains",
      { difficulty: Difficulty.Medium, infiniteGold: false, bots: 0 },
      [human("client_id")],
    );
    const executor = new Executor(game, "game_id", "client_id");

    const exec = executor.createExec({
      type: "update_game_config",
      config: { difficulty: Difficulty.Hard, infiniteGold: true },
      clientID: "client_id",
    } as never);

    expect(exec.isActive()).toBe(false);
    game.addExecution(exec);
    game.executeNextTick();

    // Written through to the live GameConfig...
    const config = game.config().gameConfig();
    expect(config.difficulty).toBe(Difficulty.Hard);
    expect(config.infiniteGold).toBe(true);
    // ...and read back through EngineConfig, so rules change immediately.
    expect(game.config().infiniteGold()).toBe(true);
    // Keys the patch omitted keep their value.
    expect(config.bots).toBe(0);
  });

  test("applies the host cheat block live", async () => {
    const game = await setup("big_plains", {}, [human("client_id")]);
    const executor = new Executor(game, "game_id", "client_id");

    game.addExecution(
      executor.createExec({
        type: "update_game_config",
        config: { hostCheats: { infiniteTroops: true, goldMultiplier: 3 } },
        clientID: "client_id",
      } as never),
    );
    game.executeNextTick();

    expect(game.config().gameConfig().hostCheats).toEqual({
      infiniteTroops: true,
      goldMultiplier: 3,
    });
  });

  test("clears a nullable key when the patch sends null", async () => {
    const game = await setup("big_plains", { spawnImmunityDuration: 50 }, [
      human("client_id"),
    ]);
    const executor = new Executor(game, "game_id", "client_id");

    game.addExecution(
      executor.createExec({
        type: "update_game_config",
        config: { spawnImmunityDuration: null },
        clientID: "client_id",
      } as never),
    );
    game.executeNextTick();

    expect(game.config().gameConfig().spawnImmunityDuration).toBeUndefined();
  });
});
