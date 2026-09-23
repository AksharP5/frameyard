import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { z } from "zod";
import type { CatalogEntry, CatalogItem } from "./hyperframes-contracts";

// The public website promotes immutable packages separately from registry examples.
export const templateRevision = "254fe4bd8a3f00c1e70ac5e38a1bce25060f7590";
export const templateRepository = `https://raw.githubusercontent.com/heygen-com/hyperframes/${templateRevision}`;
const packageRoot = `https://static.heygen.ai/hyperframes/templates/promoted/${templateRevision}`;
const gallery = [
  { name: "notification-cascade", title: "Notification Cascade", description: "Notifications stack across a phone screen before lifting into a bold closing card.", duration: 14 },
  { name: "share-sheet-carousel", title: "Share-Sheet Carousel", description: "A spring-loaded share sheet cycles through product previews and lands on an accept tap.", duration: 7.2333 },
  { name: "ai-chat-reveal", title: "AI Chat Reveal", description: "A typed question becomes a streamed AI response, followed by a branded end card.", duration: 19.3333 },
  { name: "message-thread-reveal", title: "Message Thread Reveal", description: "A complete phone conversation unfolds beat by beat with link cards and receipts.", duration: 25.7667 },
  { name: "notes-reveal", title: "Notes Reveal", description: "A personal note types itself on screen before cutting to a hand-lettered checklist.", duration: 24.85 },
  { name: "chatgpt-exchange", title: "ChatGPT Exchange", description: "A ChatGPT-style prompt becomes a streamed recommendation and comparison table.", duration: 14.9 },
  { name: "claude-exchange", title: "Claude Exchange", description: "A Claude-style prompt runs through search and reasoning before streaming a cited answer.", duration: 21.4 },
  { name: "slack-notification-ad", title: "Slack Notification Ad", description: "A lock screen fills with escalating Slack video requests before HeyGen delivers the payoff.", duration: 12 },
];

export const websiteTemplates: CatalogEntry[] = gallery.map((item) => ({
  ...item, type: "template", tags: ["ad-template", "portrait"], dimensions: { width: 1080, height: 1920 },
  poster: `${packageRoot}/${item.name}/poster.jpg`, video: `${packageRoot}/${item.name}/preview.mp4`,
}));

export function templatePackageUrl(name: string) {
  if (!websiteTemplates.some((item) => item.name === name)) throw new Error("Unknown HyperFrames website template.");
  return `${packageRoot}/${name}/template.zip`;
}

async function extractTemplate(archive: string, source: string): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (error, file) => {
      if (error || !file) reject(error ?? new Error("Could not open template archive"));
      else resolve(file);
    });
  });
  let expanded = 0;
  const paths = new Set<string>();

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => { if (!finished) { finished = true; resolve(); } });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const path = entry.fileName;
          const parts = path.replace(/\/$/, "").split("/");
          if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") || parts.some(part => !part || part === "." || part === "..") || path === ".template-package.zip") {
            throw new Error("Template archive contains an unsafe path.");
          }
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error("Template archives cannot contain symbolic links.");
          if (paths.has(path)) throw new Error("Template archive contains duplicate paths.");
          paths.add(path);
          expanded += entry.uncompressedSize;
          if (paths.size > 2000 || expanded > 256 * 1024 * 1024) throw new Error("Template archive exceeds extraction limits.");

          const destination = join(source, ...parts);
          if (path.endsWith("/")) await mkdir(destination, { recursive: true });
          else {
            await mkdir(dirname(destination), { recursive: true });
            const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
              zip.openReadStream(entry, (error, stream) => {
                if (error || !stream) reject(error ?? new Error("Could not read template entry"));
                else resolve(stream);
              });
            });
            await pipeline(input, createWriteStream(destination, { flags: "wx" }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

export async function installWebsiteTemplate(source: string, item: Extract<CatalogItem, { type: "template" }>) {
  const packageUrl = templatePackageUrl(item.name);
  const response = await fetch(packageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Template download failed: HTTP ${response.status}.`);
  const archive = join(source, ".template-package.zip");
  const file = await open(archive, "wx");
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let downloaded = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > 128 * 1024 * 1024) throw new Error("Template package exceeds 128 MB.");
      hash.update(value);
      await file.writeFile(value);
    }
  } finally {
    await reader.cancel();
    await file.close();
  }
  await extractTemplate(archive, source);
  const provenance = z.object({ source: z.object({ commit: z.literal(templateRevision) }), template: z.object({ id: z.literal(item.name) }) }).parse(JSON.parse(await readFile(join(source, "template-source.json"), "utf8")));
  const contract = z.object({ baseline: z.object({ path: z.literal("__template_baseline__.html"), sha256: z.string() }) }).parse(JSON.parse(await readFile(join(source, "template-contract.json"), "utf8")));
  const baseline = await readFile(join(source, contract.baseline.path));
  if (createHash("sha256").update(baseline).digest("hex") !== contract.baseline.sha256) throw new Error("Template baseline does not match its editing contract.");
  await readFile(join(source, "index.html"));
  const license = await fetch(`${templateRepository}/LICENSE`, { signal: AbortSignal.timeout(10_000) });
  if (!license.ok) throw new Error(`Template license download failed: HTTP ${license.status}.`);
  await writeFile(join(source, "LICENSE.hyperframes"), await license.text(), { flag: "wx" });
  await writeFile(join(source, "diffusion-template-source.json"), JSON.stringify({
    website: item.templateSource.website, packageUrl, packageSha256: hash.digest("hex"),
    revision: provenance.source.commit, template: provenance.template.id, license: item.templateSource.license,
  }, null, 2) + "\n", { flag: "wx" });
  await unlink(archive);
}
