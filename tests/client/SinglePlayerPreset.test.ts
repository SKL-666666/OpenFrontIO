import {
  Difficulty,
  GameMapType,
  GameMode,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSinglePlayerPreset,
  readSinglePlayerPreset,
  SinglePlayerPreset,
  writeSinglePlayerPreset,
} from "../../src/client/SinglePlayerPreset";

const FULL: SinglePlayerPreset = {
  selectedMap: GameMapType.World,
  selectedDifficulty: Difficulty.Hard,
  useRandomMap: false,
  gameMode: GameMode.Team,
  teamCount: 4,
  bots: 120,
  nations: 48,
  infiniteGold: true,
  infiniteTroops: false,
  compactMap: true,
  maxTimer: true,
  maxTimerValue: 25,
  instantBuild: true,
  randomSpawn: true,
  disabledUnits: [UnitType.TransportShip],
  goldMultiplier: true,
  goldMultiplierValue: 3.5,
  startingGold: false,
  startingGoldValue: undefined,
  customAlliances: true,
  customAllianceMinutes: 12,
  waterNukes: true,
  doomsdayClock: true,
  doomsdayClockSpeed: "fast",
  overtime: true,
  overtimeStartMinutes: 45,
};

function raw(value: unknown): void {
  localStorage.setItem("ofl.single-player-config", JSON.stringify(value));
}

describe("SinglePlayerPreset", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSinglePlayerPreset();
  });

  it("round-trips every field it was written with", () => {
    writeSinglePlayerPreset(FULL);
    expect(readSinglePlayerPreset()).toEqual(FULL);
  });

  it("returns nothing when nothing was ever saved", () => {
    expect(readSinglePlayerPreset()).toEqual({});
  });

  it("returns nothing rather than throwing on an unreadable value", () => {
    localStorage.setItem("ofl.single-player-config", "not json {");
    expect(readSinglePlayerPreset()).toEqual({});

    raw(null);
    expect(readSinglePlayerPreset()).toEqual({});

    raw("a string");
    expect(readSinglePlayerPreset()).toEqual({});
  });

  it("drops fields whose value does not type-check and keeps the rest", () => {
    raw({
      selectedMap: GameMapType.World,
      selectedDifficulty: "Nightmare", // not a Difficulty
      gameMode: GameMode.Team,
      bots: "400", // wrong type
      compactMap: true,
      maxTimerValue: "30", // wrong type
      doomsdayClockSpeed: "ludicrous", // not a DoomsdayClockSpeed
    });

    expect(readSinglePlayerPreset()).toEqual({
      selectedMap: GameMapType.World,
      gameMode: GameMode.Team,
      compactMap: true,
    });
  });

  it("drops a bot count the form itself would have refused", () => {
    raw({ bots: 401 });
    expect(readSinglePlayerPreset()).toEqual({});

    raw({ bots: -1 });
    expect(readSinglePlayerPreset()).toEqual({});

    raw({ bots: 400, nations: 0 });
    expect(readSinglePlayerPreset()).toEqual({ bots: 400, nations: 0 });
  });

  it("keeps the undefined-valued number fields that JSON can carry", () => {
    raw({ maxTimerValue: null, startingGoldValue: 5 });
    // null is not a number, so the first must go; the second must survive.
    expect(readSinglePlayerPreset()).toEqual({ startingGoldValue: 5 });
  });

  it("filters unit types the modal does not offer", () => {
    raw({ disabledUnits: [UnitType.TransportShip, "ParticleBeam", 7, null] });
    expect(readSinglePlayerPreset()).toEqual({
      disabledUnits: [UnitType.TransportShip],
    });

    raw({ disabledUnits: "nope" });
    expect(readSinglePlayerPreset()).toEqual({});
  });

  it("does not let a failure to write poison the next read", () => {
    writeSinglePlayerPreset({ ...FULL, bots: 10 });
    expect(readSinglePlayerPreset().bots).toBe(10);
    clearSinglePlayerPreset();
    expect(readSinglePlayerPreset()).toEqual({});
  });
});
