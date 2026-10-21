import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

/** An armed god-mode tile brush; null when no brush is active. */
export type GodBrush = {
  action: "water" | "land" | "give" | "erase" | "build";
  unit?: PlayerBuildableUnitType;
};

export interface UIState {
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /** Local/singleplayer god tool: click the map to paint. */
  godBrush?: GodBrush | null;
}
