/**
 * The singleplayer form, remembered between opens.
 *
 * `SinglePlayerModal.resetOptions()` wipes every field on close — on purpose:
 * a modal that opens on a stale half-chosen configuration reads as a bug, and
 * `startTutorial()` needs a clean default to start from. That leaves the solo
 * player restarting the same setup by hand every session, which is the one
 * thing a local, offline game should do for them.
 *
 * So the form is snapshotted when a game actually starts and replayed into the
 * next open. Snapshotted at the start rather than at the close, because
 * closing is not choosing: an abandoned edit should not be what the next game
 * launches with.
 *
 * Reads never throw and never trust what they find. localStorage holds JSON a
 * previous build may have written in a different shape, and it is editable by
 * hand, so every field is type-checked on the way in and dropped when it does
 * not match. What is dropped simply stays at the modal's default — a partially
 * broken preset degrades to a normal form rather than to an exception.
 */
import {
  Difficulty,
  GameMapType,
  GameMode,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { TeamCountConfig } from "@openfront/engine-api/Schemas";
import { DoomsdayClockSpeed } from "@openfront/engine-lib/game/DoomsdayClock";
import { PREFS, readPref, removePref, writePref } from "./LocalPrefs";

/**
 * The modal's own field names, so applying one is a direct assignment per
 * field rather than a rename map that can drift out of sync with the form.
 */
export interface SinglePlayerPreset {
  selectedMap: GameMapType;
  selectedDifficulty: Difficulty;
  useRandomMap: boolean;
  gameMode: GameMode;
  teamCount: TeamCountConfig;
  bots: number;
  nations: number;
  infiniteGold: boolean;
  infiniteTroops: boolean;
  compactMap: boolean;
  maxTimer: boolean;
  maxTimerValue: number | undefined;
  instantBuild: boolean;
  randomSpawn: boolean;
  disabledUnits: UnitType[];
  goldMultiplier: boolean;
  goldMultiplierValue: number | undefined;
  startingGold: boolean;
  startingGoldValue: number | undefined;
  customAlliances: boolean;
  customAllianceMinutes: number | undefined;
  waterNukes: boolean;
  doomsdayClock: boolean;
  doomsdayClockSpeed: DoomsdayClockSpeed;
  overtime: boolean;
  overtimeStartMinutes: number | undefined;
}

const DOOMSDAY_SPEEDS: readonly string[] = [
  "slow",
  "normal",
  "fast",
  "veryfast",
];

const BOOL_FIELDS: readonly (keyof SinglePlayerPreset)[] = [
  "useRandomMap",
  "infiniteGold",
  "infiniteTroops",
  "compactMap",
  "maxTimer",
  "instantBuild",
  "randomSpawn",
  "goldMultiplier",
  "startingGold",
  "customAlliances",
  "waterNukes",
  "doomsdayClock",
  "overtime",
];

// Bounded like the form's own handlers, so a preset cannot smuggle in a bot
// count the start button would have refused.
const NUMBER_FIELDS: readonly (keyof SinglePlayerPreset)[] = [
  "bots",
  "nations",
  "teamCount",
];

const OPTIONAL_NUMBER_FIELDS: readonly (keyof SinglePlayerPreset)[] = [
  "maxTimerValue",
  "goldMultiplierValue",
  "startingGoldValue",
  "customAllianceMinutes",
  "overtimeStartMinutes",
];

function isEnumValue<T extends string>(
  value: unknown,
  values: readonly string[],
): value is T {
  return typeof value === "string" && values.includes(value);
}

/**
 * Whatever of `raw` survives type checking.
 *
 * Missing or mismatched fields are simply absent: the caller applies this
 * over a form that is already at its defaults, so "dropped" means "left at
 * default" and needs no error path of its own.
 */
export function readSinglePlayerPreset(): Partial<SinglePlayerPreset> {
  const raw = readPref<unknown>(PREFS.singlePlayerConfig, null);
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const preset: Partial<SinglePlayerPreset> = {};
  // Through a loose view: the field lists above are typed as key unions, and
  // the whole point of checking each value first is that the write then
  // cannot be narrowed per field by TypeScript.
  const loose = preset as Record<string, unknown>;

  if (isEnumValue<GameMapType>(record.selectedMap, Object.values(GameMapType)))
    preset.selectedMap = record.selectedMap;
  if (
    isEnumValue<Difficulty>(
      record.selectedDifficulty,
      Object.values(Difficulty),
    )
  )
    preset.selectedDifficulty = record.selectedDifficulty;
  if (isEnumValue<GameMode>(record.gameMode, Object.values(GameMode)))
    preset.gameMode = record.gameMode;
  if (
    isEnumValue<DoomsdayClockSpeed>(record.doomsdayClockSpeed, DOOMSDAY_SPEEDS)
  )
    preset.doomsdayClockSpeed = record.doomsdayClockSpeed;

  for (const key of BOOL_FIELDS) {
    if (typeof record[key] === "boolean") loose[key] = record[key];
  }
  for (const key of NUMBER_FIELDS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (key === "bots" && (value < 0 || value > 400)) continue;
    if (key === "nations" && value < 0) continue;
    loose[key] = value;
  }
  for (const key of OPTIONAL_NUMBER_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    loose[key] = value;
  }

  // Filtered rather than taken wholesale: a unit the modal does not offer
  // would reach startGame()'s filter anyway, but a nonsense value would
  // first have to survive rendering in the disabled-units list.
  if (Array.isArray(record.disabledUnits)) {
    preset.disabledUnits = (record.disabledUnits as unknown[]).filter(
      (unit): unit is UnitType =>
        typeof unit === "string" &&
        Object.values(UnitType).includes(unit as UnitType),
    );
  }

  return preset;
}

/** Snapshot the form as it stands. Call this on start, never on close. */
export function writeSinglePlayerPreset(preset: SinglePlayerPreset): void {
  writePref(PREFS.singlePlayerConfig, preset);
}

/** Drop the saved form, so the next open is the stock configuration. */
export function clearSinglePlayerPreset(): void {
  removePref(PREFS.singlePlayerConfig);
}
