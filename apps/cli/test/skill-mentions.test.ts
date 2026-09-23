import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import type { CodexSkill } from "../../desktop/src/codex-capabilities.ts";

const source = fileURLToPath(new URL("../../web/src/agent-chat/skill-mentions.ts", import.meta.url));
const code = buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;
const module = { exports: {} as typeof import("../../web/src/agent-chat/skill-mentions.ts") };
runInThisContext(`(function(require,module,exports){${code}\n})`)(createRequire(import.meta.url), module, module.exports);
const { skillMentionAt, findSkillMentions, insertSkillMention, retainSkillMentions, removeSkillMention } = module.exports;
const skill = (name: string, description = ""): CodexSkill => ({ name, description, path: `/skills/${name}/SKILL.md` });

test("skill trigger follows the caret and replaces the whole token while preserving surrounding text", () => {
  const text = "Use\n$video:captions-v2.0 after";
  const start = text.indexOf("$");
  const end = text.indexOf(" after");
  const range = skillMentionAt(text, start + "$video:cap".length);
  assert.deepEqual(range, { query: "video:cap", start, end });
  const replacement = insertSkillMention(text, skill("video:titles"), range);
  assert.equal(replacement.text, "Use\n$video:titles after");
  assert.equal(replacement.caret, "Use\n$video:titles ".length);
  assert.deepEqual(skillMentionAt("$", 1), { query: "", start: 0, end: 1 });
  for (const text of ["price$captions", "\\$captions", "$captions ", "($captions"]) {
    assert.equal(skillMentionAt(text, text.length), undefined, text);
  }
  assert.equal(skillMentionAt("$captions", 4, 5), undefined, "selected text is not an autocomplete trigger");
});

test("skill search matches descriptions and ranks exact names before prefixes", () => {
  const catalog = [skill("other", "Create VIDEO CAPTIONS"), skill("captions-long"), skill("captions")];
  assert.deepEqual(findSkillMentions(catalog, "CAPTIONS").map(({ name }) => name), ["captions", "captions-long", "other"]);
  assert.deepEqual(findSkillMentions(catalog, "video captions"), [catalog[0]]);
  assert.equal(findSkillMentions(Array.from({ length: 20 }, (_, index) => skill(`skill-${index}`)), "").length, 12);
  assert.deepEqual(catalog.map(({ name }) => name), ["other", "captions-long", "captions"], "search must not reorder the shared catalog");
});

test("deleting the last exact token detaches its skill and preserves older picker attachments", () => {
  const captions = skill("video:captions-v2.0");
  const legacy = skill("legacy");
  const previous = `Use $${captions.name}, then $${captions.name}.extended`;
  assert.deepEqual(retainSkillMentions(previous, `Use $${captions.name}.extended`, [captions, legacy]), [legacy]);
  assert.deepEqual(retainSkillMentions(`$${captions.name} $${captions.name}`, `$${captions.name}`, [captions]), [captions]);
  assert.deepEqual(retainSkillMentions(`$${captions.name}`, "$other", [captions, legacy]), [legacy]);
  assert.deepEqual(retainSkillMentions("an old draft", "an edited old draft", [legacy]), [legacy]);
});

test("removing a chip removes its exact mentions without matching similar names or regex characters", () => {
  const name = "video:captions-v2.0";
  const text = `$${name} and $${name}\tthen $${name}, $${name}-extra $video:captions-v2X0 value$${name}`;
  assert.equal(removeSkillMention(text, name), `and then , $${name}-extra $video:captions-v2X0 value$${name}`);
  assert.deepEqual(insertSkillMention("Use this", skill(name)), { text: `Use this $${name} `, caret: `Use this $${name} `.length });
});
