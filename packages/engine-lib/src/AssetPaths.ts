export type AssetManifest = Record<string, string>;

function safeDecodeAssetSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function assertSafeAssetSegment(segment: string): string {
  const decodedSegment = safeDecodeAssetSegment(segment);
  if (
    segment === "." ||
    segment === ".." ||
    decodedSegment === "." ||
    decodedSegment === ".."
  ) {
    throw new Error(`Invalid asset path segment: ${segment}`);
  }
  return decodedSegment;
}

export function encodeAssetPath(path: string): string {
  return normalizeAssetPath(path)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function normalizeAssetPath(path: string): string {
  const normalizedPath = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => assertSafeAssetSegment(segment))
    .join("/");

  if (normalizedPath.length === 0) {
    throw new Error("Asset path must not be empty");
  }

  return normalizedPath;
}

// Any scheme, not just http(s): the desktop shell resolves assets against an
// absolute app://openfront base (its cdnBase), and an already-resolved URL
// can be handed back to assetUrl() (e.g. WebGLFrameBuilder re-resolves
// player cosmetic refs that a singleplayer start resolved at join time).
// Matching only http(s) sent those through normalizeAssetPath, which mangled
// "app://openfront/_assets/flags/US.<hash>.svg" into
// "/app%3A/openfront/_assets/..." — a 404, and a country flag that silently
// never rendered in game on desktop.
function isAbsoluteUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

export function buildAssetUrl(
  path: string,
  assetManifest: AssetManifest = {},
  baseUrl: string = "",
): string {
  if (isAbsoluteUrl(path)) {
    return path;
  }

  const normalizedPath = normalizeAssetPath(path);

  const directUrl = assetManifest[normalizedPath];
  if (directUrl) {
    return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${directUrl}` : directUrl;
  }

  return `/${encodeAssetPath(normalizedPath)}`;
}

// buildAssetUrl returns root-relative URLs ("/_assets/…") whenever no CDN
// base is configured. The document resolves those for the main thread, and a
// worker loaded from a real script URL resolves them against its own origin —
// but a Vite inline worker (?worker&inline, how both the core and the replay
// workers ship) runs from a blob: URL, an opaque path that cannot be a base,
// so fetch() there rejects them with "Failed to parse URL from …". Prefixing
// the origin the blob inherits from its creating page makes them resolvable
// in every worker.
export function absolutizeAssetUrl(url: string, origin: string): string {
  if (!url.startsWith("/")) {
    return url;
  }
  if (url.startsWith("//")) {
    return url;
  }
  const base = origin.replace(/\/+$/, "");
  // An empty origin (no location, e.g. SSR) or an opaque "null" origin has
  // nothing to prefix, so leave the URL as-is rather than break it.
  if (base === "" || base === "null") {
    return url;
  }
  return `${base}${url}`;
}
