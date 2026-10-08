import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const EN_JSON = path.join(
  __dirname,
  "..",
  "..",
  "resources",
  "lang",
  "en.json",
);

describe("multi_tab translations", () => {
  it("includes all multi_tab modal translation keys in en.json", () => {
    const en = JSON.parse(fs.readFileSync(EN_JSON, "utf8"));
    expect(en.multi_tab).toBeDefined();
    // Presence, not wording. en.json is this fork's source file and it is
    // written in Simplified Chinese, so pinning an English literal would only
    // be pinning a copy of a string — the invariant is that every key the
    // modal asks for exists and is non-empty, which is what makes a raw key
    // impossible to render.
    for (const key of [
      "warning",
      "detected",
      "please_wait",
      "seconds",
      "explanation",
    ]) {
      expect(typeof en.multi_tab[key]).toBe("string");
      expect(en.multi_tab[key].length).toBeGreaterThan(0);
    }
  });
});
