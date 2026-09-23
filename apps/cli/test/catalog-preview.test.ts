import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { catalogPreviewDocument } from "../../web/src/components/agent/catalog-preview-document.ts";

test("published HTML stays inside the opaque player even when it contains script terminators", () => {
  const html = '<div>Animation</div><script>window.title="</script><script>intruder=true</script>"</script>';
  const document = catalogPreviewDocument(html, false);
  const scripts = [...document.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const actions: (string | number)[] = [];
  const player = {
    duration: 10,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    addEventListener: (name: string, action: () => void) => listeners.set(name, action),
    seek: (time: number) => actions.push(time),
    pause: () => actions.push("pause"),
  };
  const context = { document: { createElement: () => player, body: { append: () => {} } }, parent: { postMessage: () => {} } };
  runInNewContext(scripts[1][1], context);
  assert.equal(attributes.get("srcdoc"), html);
  assert.equal(attributes.get("sandbox-origin"), "opaque");
  assert.ok(!("intruder" in context));
  listeners.get("ready")!();
  assert.deepEqual(actions, [4.5, "pause"]);
});
