/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { DapiError, FONT_LIMIT } from "@diffusionstudio/dapi";

import type { FontFamily } from "@diffusionstudio/dapi";
import type { MainHandler } from "../handler";

// JXA script that walks every registered font family via NSFontManager and
// emits each variant's CSS-style weight, italic flag, and CSS `local()` source.
const LIST_FONTS_JXA = `
ObjC.import("AppKit");

function nsfmWeightToCss(w) {
  if (w <= 1) return "100";
  if (w <= 2) return "200";
  if (w <= 3) return "300";
  if (w <= 5) return "400";
  if (w <= 6) return "500";
  if (w <= 8) return "600";
  if (w <= 9) return "700";
  if (w <= 11) return "800";
  return "900";
}

function run() {
  var fm = $.NSFontManager.sharedFontManager;
  var families = fm.availableFontFamilies;
  var out = [];
  for (var i = 0; i < families.count; i++) {
    var family = ObjC.unwrap(families.objectAtIndex(i));
    if (family.charAt(0) === ".") continue;
    var members = fm.availableMembersOfFontFamily(family);
    if (!members || members.isNil()) continue;
    var variants = [];
    for (var j = 0; j < members.count; j++) {
      var m = members.objectAtIndex(j);
      var fontName = ObjC.unwrap(m.objectAtIndex(0));
      var styleName = ObjC.unwrap(m.objectAtIndex(1));
      var weight = ObjC.unwrap(m.objectAtIndex(2));
      var traits = ObjC.unwrap(m.objectAtIndex(3));
      var fullName = styleName === "Regular" ? family : family + " " + styleName;
      variants.push({
        weight: nsfmWeightToCss(weight),
        style: (traits & 1) !== 0 ? "italic" : "normal",
        source: "local('" + fullName + "'), local('" + fontName + "')",
      });
    }
    if (variants.length > 0) out.push({ family: family, variants: variants });
  }
  return JSON.stringify(out);
}
`;

const FONTCONFIG_FORMAT =
  "%{family[0]}\\t%{fullname[0]}\\t%{postscriptname[0]}\\t%{weight}\\t%{slant}\\n";

// Fontconfig weights differ from CSS weights. These anchors match
// FcWeightToOpenTypeDouble, including the intermediate light values.
const FONTCONFIG_WEIGHTS = [
  [0, 100],
  [40, 200],
  [50, 300],
  [55, 350],
  [75, 380],
  [80, 400],
  [100, 500],
  [180, 600],
  [200, 700],
  [205, 800],
  [210, 900],
  [215, 1000],
] as const;

function cssWeight(weight: number): number {
  for (let i = 1; i < FONTCONFIG_WEIGHTS.length; i++) {
    const [upper, cssUpper] = FONTCONFIG_WEIGHTS[i]!;
    if (weight > upper) continue;
    const [lower, cssLower] = FONTCONFIG_WEIGHTS[i - 1]!;
    return Math.round(cssLower + ((weight - lower) / (upper - lower)) * (cssUpper - cssLower));
  }
  throw new Error(`Invalid Fontconfig weight: ${weight}`);
}

export function parseFontconfigFonts(output: string): FontFamily[] {
  const families = new Map<string, FontFamily>();
  for (const line of output.trim().split("\n")) {
    const [family, fullName, postscriptName, rawWeight, rawSlant] = line.split("\t");
    if (!family || !rawWeight || !rawSlant) continue;

    const weight = Number(rawWeight);
    const slant = Number(rawSlant);
    // Variable ranges have no usable local() name; fc-list emits their named
    // instances separately.
    if (![weight, slant].every(Number.isFinite) || weight < 0 || weight > 215) continue;
    const names = [...new Set([fullName, postscriptName].filter(Boolean))];
    if (names.length === 0) continue;
    const source = names
      .map((name) => `local('${name!.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}')`)
      .join(", ");
    const style = slant === 0 ? "normal" : "italic";
    const entry = families.get(family) ?? { family, variants: [] };
    families.set(family, entry);
    const variant = { weight: String(cssWeight(weight)), style, source } as const;
    if (entry.variants.some((item) =>
      item.weight === variant.weight && item.style === variant.style && item.source === variant.source
    )) {
      continue;
    }
    entry.variants.push(variant);
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function listLocalFonts(): FontFamily[] {
  const system = platform();
  if (system !== "darwin" && system !== "linux") {
    throw new DapiError("unsupported", "fonts is supported on macOS and Linux.");
  }

  const linux = system === "linux";
  const result = spawnSync(
    linux ? "fc-list" : "osascript",
    linux ? ["--format", FONTCONFIG_FORMAT] : ["-l", "JavaScript", "-e", LIST_FONTS_JXA],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) {
    throw new DapiError(
      "unsupported",
      linux ? `Unable to run fc-list. Install fontconfig: ${result.error.message}` : result.error.message,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Failed to enumerate fonts.");
  }
  return linux
    ? parseFontconfigFonts(result.stdout)
    : JSON.parse(result.stdout.trim()) as FontFamily[];
}

export const fonts: MainHandler<"fonts"> = async ({ family, weights, style, limit = FONT_LIMIT }) => {
  const pattern = family?.toLowerCase();
  const wanted = weights && weights.length > 0 ? new Set(weights) : null;

  const families: FontFamily[] = [];
  for (const entry of listLocalFonts()) {
    if (pattern && !entry.family.toLowerCase().includes(pattern)) continue;
    const variants = entry.variants.filter((variant) => {
      if (wanted && !wanted.has(variant.weight)) return false;
      if (style && variant.style !== style) return false;
      return true;
    });
    if (variants.length === 0) continue;
    families.push({ family: entry.family, variants });
  }
  return { families: families.slice(0, limit), total: families.length };
};
