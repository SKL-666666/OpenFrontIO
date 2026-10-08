import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCosmetic } from "../../src/client/Cosmetics";
import "../../src/client/LangSelector";
import type { LangSelector } from "../../src/client/LangSelector";
import "../../src/client/components/CosmeticCard";
import type { CosmeticCard } from "../../src/client/components/CosmeticCard";
import {
  cosmeticDisplayName,
  cosmeticRarityLabel,
} from "../../src/client/components/CosmeticPresentation";

/**
 * The source file this fork renders from.
 *
 * Read rather than spelled out: en.json is Simplified Chinese here, so
 * "Equipped" is no longer what `inventory.equipped` resolves to. The fr
 * assertions further down are the real proof that a language switch re-renders
 * these labels — they pin a language file this fork does not translate.
 */
const en = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "resources", "lang", "en.json"),
    "utf8",
  ),
);

const rarePattern: ResolvedCosmetic = {
  type: "pattern",
  cosmetic: {
    name: "stripes",
    pattern: "AAAAAA",
    product: null,
    rarity: "rare",
  } as never,
  colorPalette: null,
  relationship: "owned",
  key: "pattern:stripes",
};

const noCrown: ResolvedCosmetic = {
  type: "crown",
  cosmetic: null,
  colorPalette: null,
  relationship: "owned",
  key: "crown:none",
};

const noFlag: ResolvedCosmetic = {
  type: "flag",
  cosmetic: {
    name: "None",
    url: "/flags/xx.svg",
    product: null,
    rarity: "common",
  } as never,
  colorPalette: null,
  relationship: "owned",
  key: "country:xx",
};

const defaultEffect: ResolvedCosmetic = {
  type: "effect",
  cosmetic: null,
  colorPalette: null,
  relationship: "owned",
  key: "effect:none:transportShipTrail",
  effectType: "transportShipTrail",
};

describe("cosmetic presentation localization", () => {
  let selector: LangSelector | undefined;
  let card: CosmeticCard | undefined;

  beforeEach(() => {
    localStorage.setItem("lang", "en");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              common: { none: "Aucun" },
              cosmetics: { rare: "Rare FR" },
              inventory: { equipped: "Équipé" },
              territory_patterns: { pattern: { default: "Par défaut" } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });

  afterEach(() => {
    card?.remove();
    selector?.remove();
    card = undefined;
    selector = undefined;
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("refreshes equipped, rarity, None, and Default labels on a live language switch", async () => {
    selector = document.createElement("lang-selector") as LangSelector;
    document.body.appendChild(selector);
    await vi.waitFor(() => expect(selector!.defaultTranslations).toBeTruthy());

    card = document.createElement("cosmetic-card") as CosmeticCard;
    card.resolved = rarePattern;
    card.state = "equipped";
    document.body.appendChild(card);

    await card.updateComplete;

    // Compared against what en.json resolves the key to, not an English
    // literal: this fork's source file is Simplified Chinese, so
    // "Equipped" is no longer what `inventory.equipped` renders. The fr
    // assertions below are what actually prove a live switch re-renders
    // these labels, and fr.json is untouched here.
    expect(
      card.querySelector("[data-cosmetic-equipped]")?.textContent,
    ).toContain(en.inventory.equipped);
    expect(cosmeticRarityLabel(rarePattern)).toContain(en.cosmetics.rare);

    window.dispatchEvent(
      new CustomEvent("language-selected", { detail: { lang: "fr" } }),
    );

    await vi.waitFor(() => expect(selector!.currentLang).toBe("fr"));
    await vi.waitFor(() =>
      expect(
        card!.querySelector("[data-cosmetic-equipped]")?.textContent,
      ).toContain("Équipé"),
    );
    expect(cosmeticRarityLabel(rarePattern)).toContain("Rare FR");
    expect(cosmeticDisplayName(noCrown)).toBe("Aucun");
    expect(cosmeticDisplayName(noFlag)).toBe("Aucun");
    expect(cosmeticDisplayName(defaultEffect)).toBe("Par défaut");
  });
});
