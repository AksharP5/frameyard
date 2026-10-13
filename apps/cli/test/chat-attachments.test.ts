import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const solid: typeof import("solid-js") = require(require.resolve("solid-js").replace("server.cjs", "solid.cjs"));
const built = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/agent-chat/attachments.tsx", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "transform", jsxFactory: "view",
  plugins: [{ name: "attachment-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ kind, path }) => kind === "entry-point" ? undefined : { path, external: true });
  } }],
});

function fixture() {
  const uploads: unknown[] = [];
  const urls: Blob[] = [];
  const revoked: string[] = [];
  const module = { exports: {} as typeof import("../../web/src/agent-chat/attachments.tsx") };
  const dependencies: Record<string, unknown> = {
    "solid-js": solid,
    "somoto": { toast: { error: () => {} } },
    "./connection": { hasHost: () => true, client: { request: async (_method: string, data: unknown) => { uploads.push(data); return { path: "/uploaded.png" }; } } },
    "@/lib/cva": { cx: () => "" },
  };
  class Reader {
    result = "data:image/png;base64,Ynl0ZXM=";
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  }
  runInThisContext(`(function(require,module,exports,view,window,URL,FileReader){${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? {}, module, module.exports, () => {}, { desktop: undefined },
    { createObjectURL: (file: Blob) => { urls.push(file); return `blob:${urls.length}`; }, revokeObjectURL: (url: string) => revoked.push(url) }, Reader,
  );
  return { ...module.exports, uploads, urls, revoked };
}

function paste(file: File, types = ["Files"]) {
  let prevented = false;
  return {
    event: { clipboardData: { files: [file], types }, preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent,
    prevented: () => prevented,
  };
}

test("native binary paste uses its file callback without uploading to the shared host", async () => {
  const f = fixture();
  const file = new File(["bytes"], "image.png", { type: "image/png" });
  const event = paste(file);
  let received: File[] = [];
  f.createPasteHandler(() => assert.fail("native paste must not create hosted attachments"), (files) => { received = files; })(event.event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.prevented(), true);
  assert.deepEqual(received, [file]);
  assert.deepEqual(f.uploads, []);
});

test("rich-text clipboard images remain part of a text paste", () => {
  const f = fixture();
  const event = paste(new File(["preview"], "preview.png", { type: "image/png" }), ["text/rtf", "Files"]);
  f.createPasteHandler(() => assert.fail("rich text must remain text"), () => assert.fail("rich text must remain text"))(event.event);
  assert.equal(event.prevented(), false);
  assert.deepEqual(f.uploads, []);
});

test("image draft attachments create thumbnail URLs only while a tile owns them", () => {
  const f = fixture();
  const first = new File(["first"], "image.png", { type: "image/png" });
  const second = new File(["second"], "other.png", { type: "image/png" });
  const dropped = (file: File) => f.droppedAttachments({ dataTransfer: { items: [{ kind: "file", getAsFile: () => file }] } } as unknown as DragEvent)[0];
  const original = dropped(first);
  assert.equal(original.preview, first);
  assert.deepEqual(f.urls, [], "discarding an attachment before rendering must allocate no URL");
  const [attachment, setAttachment] = solid.createSignal(original);
  const dispose = solid.createRoot((dispose) => {
    f.AttachmentTile({ get attachment() { return attachment(); }, onRemove() {} });
    return dispose;
  });
  assert.deepEqual(f.urls, [first]);
  setAttachment(dropped(second));
  assert.deepEqual(f.revoked, ["blob:1"]);
  assert.deepEqual(f.urls, [first, second]);
  dispose();
  assert.deepEqual(f.revoked, ["blob:1", "blob:2"]);
});


test("the composer reads the current native file callback for each paste", async () => {
  const f = fixture();
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../../web/src/agent-chat/composer.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "transform", jsxFactory: "view",
    plugins: [{ name: "composer-paste-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ kind, path }) => kind === "entry-point" ? undefined : { path, external: true });
    } }],
  });
  const module = { exports: {} as typeof import("../../web/src/agent-chat/composer.tsx") };
  let onPaste!: (event: ClipboardEvent) => void;
  runInThisContext(`(function(require,module,exports,view){${bundle.outputFiles[0].text}\n})`)(
    (name: string) => name === "solid-js" ? solid : name === "./attachments" ? f : {}, module, module.exports,
    (_tag: unknown, props: { onPaste?: typeof onPaste } | null) => { if (props?.onPaste) onPaste = props.onPaste; },
  );
  const native: File[][] = [];
  let onFiles: ((files: File[]) => void) | undefined;
  const hosted: import("../../web/src/agent-chat/attachments.tsx").Attachment[][] = [];
  solid.createRoot((dispose) => {
    module.exports.Composer({
      text: "", attachments: [], onText() {}, onAttachments: (files) => hosted.push(files),
      running: false, waiting: false, blocked: null, model: null, onModel() {}, onSend() {}, onStop() {},
      get onFiles() { return onFiles; },
    });
    onFiles = (files) => native.push(files);
    const first = new File(["native"], "native.png", { type: "image/png" });
    onPaste(paste(first).event);
    assert.deepEqual(native, [[first]]);
    assert.deepEqual(f.uploads, []);
    onFiles = undefined;
    onPaste(paste(new File(["hosted"], "hosted.png", { type: "image/png" })).event);
    dispose();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hosted.length, 1);
  assert.equal(f.uploads.length, 1);
});
