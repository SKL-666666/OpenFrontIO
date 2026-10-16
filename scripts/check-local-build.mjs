#!/usr/bin/env node
/**
 * Exit 0 when static/index.html is a USABLE local page, exit 1 when it is not.
 *
 * The page source (index.html) is an EJS template. `npm run build:offline`
 * renders it through vite's createHtmlPlugin, so the emitted file is plain
 * HTML. `npm run build-prod` deliberately does NOT render it: production
 * expects the game server to call RenderHtml.ts at request time, and it
 * rewrites the bundle refs into `<%- cdnBaseRaw %>` placeholders for that
 * server to fill in. There is no such server in the local build, so a
 * production artifact served by scripts/lan-host.mjs would hand the browser
 * literal `<% ... %>` text -- including inside the BOOTSTRAP_CONFIG inline
 * script, which is a SyntaxError that stops the client booting at all.
 *
 * `npm run build-prod` writes to the same static/ directory, so it silently
 * replaces a good local build with that unusable one. start-local.cmd runs
 * this before trusting an existing static/ and rebuilds when it fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "static", "index.html");

if (!fs.existsSync(htmlPath)) {
  console.log("[check-local-build] static/index.html is missing");
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
const marker = html.includes("<%");

if (marker) {
  console.log(
    "[check-local-build] static/index.html is an unrendered EJS template " +
      "(a production build artifact); it must be rebuilt for local use",
  );
  process.exit(1);
}

process.exit(0);
