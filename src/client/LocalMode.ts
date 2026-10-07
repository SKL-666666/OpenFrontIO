import { ClientEnv } from "./ClientEnv";

/**
 * Whether this page is the local-only build: the whole game runs from it, with
 * no game server, no API and no third-party host reachable.
 *
 * Read defensively, unlike `ClientEnv.isLocalMode()` itself. This is called from
 * boot-time and menu-time code that also runs in tests with no
 * BOOTSTRAP_CONFIG at all, where ClientEnv.get() throws "Missing
 * BOOTSTRAP_CONFIG" — and a guard that exists to keep the page OFF the network
 * must not be the thing that takes the page down. A page with no config is by
 * definition not a configured local build, so the fallback is right.
 *
 * Memoised: several of the callers below sit on boot paths that run before the
 * first paint, and each of them would otherwise re-parse the bootstrap.
 */
let cached: boolean | null = null;

export function isLocalMode(): boolean {
  if (cached !== null) return cached;
  try {
    cached = ClientEnv.isLocalMode();
  } catch {
    cached = false;
  }
  return cached;
}

/** Test-only: drop the memoised answer so a rewritten bootstrap is re-read. */
export function resetLocalModeCache(): void {
  cached = null;
}
