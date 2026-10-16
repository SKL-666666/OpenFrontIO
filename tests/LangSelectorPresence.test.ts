import ejs from "ejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = fs.readFileSync(path.join(root, "index.html"), "utf8");

/** Count of `<lang-selector` openings in a rendered page. */
function count(html: string): number {
  return html.split("<lang-selector").length - 1;
}

const locals = {
  gitCommit: '"DEV"',
  assetManifest: "{}",
  cdnBase: '""',
  gameEnv: '"dev"',
  turnstileSiteKey: '"k"',
  jwtAudience: '"localhost"',
  manifestHref: "m",
  faviconHref: "f",
  gameplayScreenshotUrl: "g",
  backgroundImageUrl: "b",
  desktopLogoImageUrl: "d",
  mobileLogoImageUrl: "mo",
};

/**
 * translateText() resolves the active language through
 * document.querySelector("lang-selector"), and echoes the raw key back when
 * none is in the DOM. That element lives inside <page-footer> (Footer.ts) --
 * which index.html strips out as online-only chrome on a local build -- so a
 * local page with no replacement of its own renders every translation key in
 * the UI instead of the string.
 *
 * Both halves are load-bearing: the page must end up with exactly one
 * resolver, never zero and never two (querySelector resolves the first, and
 * the footer's copy is the one the online layout positions). The two blocks
 * in index.html are mutually exclusive, and each owns one of them: a local
 * build carries its own, the server-rendered page gets the footer's.
 */
describe("index.html language resolver", () => {
  it("renders its own <lang-selector> and drops the footer on a local build", () => {
    const html = ejs.render(template, { ...locals, local: "true" });

    expect(count(html)).toBe(1);
    // The footer element is where the online page's resolver lives, so it
    // has to be gone too -- otherwise the local page would have two.
    expect(html).not.toContain("<page-footer></page-footer>");
  });

  it("relies on the footer for its one <lang-selector> when not local", () => {
    // `local` absent entirely, which is what RenderHtml and the Steam shell
    // supply. index.html itself names no <lang-selector>: Footer.ts renders
    // it inside <page-footer>, and only that.
    const html = ejs.render(template, locals);

    expect(count(html)).toBe(0);
    expect(html).toContain("<page-footer></page-footer>");
  });
});
