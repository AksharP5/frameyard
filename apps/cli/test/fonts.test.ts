import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";

const filename = fileURLToPath(new URL("../../desktop/src/dapi/handlers/fonts.ts", import.meta.url));
const require = createRequire(filename);
const code = buildSync({
  entryPoints: [filename],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0]!.text;
const module = { exports: {} as Pick<typeof import("../../desktop/src/dapi/handlers/fonts.ts"), "parseFontconfigFonts"> };
runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`)(
  require,
  module,
  module.exports,
  filename,
  dirname(filename),
);
const { parseFontconfigFonts } = module.exports;

test("maps Fontconfig weights to CSS weights and oblique faces to italic", () => {
  const weights = [0, 40, 50, 55, 75, 80, 100, 180, 200, 205, 210, 215];
  const rows = weights.map((weight) => `Example\tExample ${weight}\tExample-${weight}\t${weight}\t110`);
  const [family] = parseFontconfigFonts(rows.join("\n"));
  assert.equal(family.family, "Example");
  assert.deepEqual(family.variants.map((v) => v.weight), ["100", "200", "300", "350", "380", "400", "500", "600", "700", "800", "900", "1000"]);
  assert.ok(family.variants.every((v) => v.style === "italic"));
  assert.equal(family.variants[8].source, "local('Example 200'), local('Example-200')");
});

test("deduplicates named faces, escapes CSS names, and skips abstract variable ranges", () => {
  const row = "Artist's Font\tArtist's Font\t\t80\t0";
  const families = parseFontconfigFonts(`${row}\n${row}\ninvalid row\nBroken\t\t\tunknown\t0\nVariable\t\t\t[0 210]\t0`);
  assert.deepEqual(families, [{ family: "Artist's Font", variants: [{ weight: "400", source: "local('Artist\\'s Font')", style: "normal" }] }]);
});
