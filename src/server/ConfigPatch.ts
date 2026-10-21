// Moved to engine-lib so the engine's UpdateGameConfigExecution can apply a
// live config change mid-game; this re-export keeps the server-side call
// sites (GameServer, IntentAuthorization) and their tests working unchanged.
export {
  applyGameConfigPatch,
  hostCheatsEnabled,
} from "@openfront/engine-lib/configuration/GameConfigPatch";
