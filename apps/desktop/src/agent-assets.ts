/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { appendFile, link, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { z } from "zod";
import { assetCandidateSchema, assetImportRequestSchema, assetSearchRequestSchema, generatedAssetImportSchema } from "./agent-asset-contracts";
import type { AssetCandidate, AssetImportRequest, AssetSearchRequest, AssetSearchResult, GeneratedAssetImport, ImportedAgentAsset } from "./agent-asset-contracts";
import type { LookupFunction } from "node:net";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateNetworks.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) privateNetworks.addSubnet(address, prefix, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !privateNetworks.check(address, family === 6 ? "ipv6" : "ipv4");
}

function publicUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || (isIP(hostname) && !publicAddress(hostname))) {
    throw new Error("Use a public HTTPS image URL without credentials or a custom port.");
  }
  return url;
}

// Resolve once and hand those checked addresses to HTTPS. A second DNS lookup
// could otherwise change a public hostname into a local-network address.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      callback(new Error("Asset URLs cannot access private networks."), "", 4);
      return;
    }
    callback(null, options.all ? addresses : addresses[0].address, options.all ? undefined : addresses[0].family);
  }, (error: Error) => callback(error, "", 4));
};

async function download(url: string, maxBytes = MAX_BYTES, timeout = 15_000): Promise<Buffer> {
  let target = publicUrl(url);
  const signal = AbortSignal.timeout(timeout);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(target, {
        signal, lookup: publicLookup,
        headers: { "User-Agent": "DiffusionStudioLinux/0.204.1 (local asset search)", Accept: "application/json,image/svg+xml,image/png,image/jpeg,image/webp" },
      }, resolve);
      req.on("error", reject);
      req.end();
    });
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (!response.headers.location || redirects === 4) throw new Error("Asset URL redirected too many times.");
        target = publicUrl(new URL(response.headers.location, target).href);
        continue;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Asset server returned HTTP ${response.statusCode ?? "unknown"}.`);
      }
      if (Number(response.headers["content-length"] ?? 0) > maxBytes) throw new Error("Asset response is too large.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw new Error("Asset response is too large.");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } finally {
      response.destroy();
    }
  }
  throw new Error("Asset download failed.");
}

const svglRoute = z.union([z.url(), z.object({ light: z.url(), dark: z.url() })]);
const svglSchema = z.array(z.object({ title: z.string(), route: svglRoute, wordmark: svglRoute.optional(), url: z.url(), brandUrl: z.url().optional() }));
const iconifySchema = z.object({
  icons: z.array(z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/)),
  collections: z.record(z.string(), z.object({ author: z.object({ name: z.string() }).optional(), license: z.object({ title: z.string() }).optional() })).optional(),
});
const lobeSchema = z.object({ files: z.array(z.object({ path: z.string().regex(/^\/icons\/[a-z0-9-]+\.svg$/) })) });
const wikiSchema = z.object({ query: z.object({ pages: z.record(z.string(), z.object({
  pageid: z.number(), title: z.string(), index: z.number().optional(),
  imageinfo: z.array(z.object({
    url: z.url(), thumburl: z.url().optional(), descriptionurl: z.url(), mime: z.string().optional(),
    extmetadata: z.record(z.string(), z.object({ value: z.unknown() })).optional(),
  })).optional(),
})) }).optional() });

const LOBE_ROOT = "https://unpkg.com/@lobehub/icons-static-svg@1.94.0";
let lobeCatalog: Promise<z.infer<typeof lobeSchema>> | undefined;
const searchCache = new Map<string, { until: number; result: AssetSearchResult }>();

function candidate(value: Omit<AssetCandidate, "id" | "previewUrl"> & { previewUrl?: string }): AssetCandidate {
  return assetCandidateSchema.parse({ ...value, id: createHash("sha256").update(value.url).digest("hex").slice(0, 16), previewUrl: value.previewUrl ?? value.url, title: value.title.slice(0, 160) });
}

async function searchLogos(query: string, provider: "svgl" | "iconify" | "lobe"): Promise<AssetCandidate[]> {
  const words = query.replace(/\b(?:logo|icon|brand)\b/gi, "").trim() || query;
  if (provider === "svgl") {
    const data = svglSchema.parse(JSON.parse((await download(`https://api.svgl.app/?search=${encodeURIComponent(words)}`, 2_000_000, 6000)).toString()));
    return data.flatMap((logo) => [logo.route, ...(logo.wordmark ? [logo.wordmark] : [])].flatMap((route, index) => {
      const variants = typeof route === "string" ? [["", route]] : Object.entries(route);
      return variants.map(([variant, url]) => candidate({ title: `${logo.title}${index ? " wordmark" : ""}${variant ? ` (${variant})` : ""}`, url, sourcePageUrl: logo.brandUrl ?? logo.url, provider, attribution: "Brand artwork from SVGL; trademark rights remain with the owner." }));
    }));
  }
  if (provider === "iconify") {
    const data = iconifySchema.parse(JSON.parse((await download(`https://api.iconify.design/search?query=${encodeURIComponent(words)}&prefixes=logos,simple-icons,devicon&limit=32`, 2_000_000, 6000)).toString()));
    return data.icons.map((icon) => {
      const [prefix, name] = icon.split(":");
      const collection = data.collections?.[prefix];
      return candidate({ title: `${name.replace(/-/g, " ")} (${prefix})`, url: `https://api.iconify.design/${prefix}/${name}.svg`, sourcePageUrl: `https://icon-sets.iconify.design/${prefix}/${name}/`, provider, attribution: [collection?.author?.name, collection?.license?.title].filter(Boolean).join(" · ") || undefined });
    });
  }
  lobeCatalog ??= download(`${LOBE_ROOT}/icons/?meta`, 2_000_000, 6000).then((bytes) => lobeSchema.parse(JSON.parse(bytes.toString()))).catch((error) => {
    lobeCatalog = undefined;
    throw error;
  });
  const slug = words.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (await lobeCatalog).files.filter(({ path }) => {
    const name = path.slice("/icons/".length, -4);
    return name === slug || name.startsWith(`${slug}-`);
  }).map(({ path }) => candidate({ title: path.slice("/icons/".length, -4).replace(/-/g, " "), url: `${LOBE_ROOT}${path}`, sourcePageUrl: "https://github.com/lobehub/lobe-icons", provider, attribution: "LobeHub icons, MIT; brand trademarks belong to their owners." }));
}

async function searchImages(query: string, limit: number): Promise<AssetCandidate[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({ action: "query", format: "json", generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: String(limit), prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: "1600" })) url.searchParams.set(key, value);
  const data = wikiSchema.parse(JSON.parse((await download(url.href, 3_000_000, 8000)).toString()));
  return Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).flatMap((page) => {
    const info = page.imageinfo?.[0];
    if (!info || (info.mime && !["image/png", "image/jpeg", "image/webp"].includes(info.mime))) return [];
    const attribution = ["Artist", "LicenseShortName", "Credit"].map((key) => {
      const value = info.extmetadata?.[key]?.value;
      return typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim() : "";
    }).filter(Boolean).join(" · ").slice(0, 2000);
    return [candidate({ title: page.title.replace(/^File:/, ""), url: info.thumburl ?? info.url, previewUrl: info.thumburl ?? info.url, sourcePageUrl: info.descriptionurl, provider: "wikimedia", attribution })];
  });
}

export async function searchAssets(input: AssetSearchRequest): Promise<AssetSearchResult> {
  const req = assetSearchRequestSchema.parse(input);
  const key = JSON.stringify(req);
  const cached = searchCache.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const providers = req.kind === "image" ? ["wikimedia"] as const : ["svgl", "lobe", "iconify"] as const;
  const results = await Promise.allSettled(providers.map((provider) => provider === "wikimedia" ? searchImages(req.query, req.limit) : searchLogos(req.query, provider)));
  const assets: AssetCandidate[] = [];
  const warnings: string[] = [];
  const groups: AssetCandidate[][] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") groups.push(result.value);
    else warnings.push(`${providers[index]}: ${result.reason instanceof Error ? result.reason.message.slice(0, 200) : "Search failed"}`);
  }
  const seen = new Set<string>();
  for (let row = 0; row < Math.max(0, ...groups.map((group) => group.length)) && assets.length < req.limit; row++) {
    for (const group of groups) {
      const asset = group[row];
      if (!asset || seen.has(asset.url) || assets.length >= req.limit) continue;
      seen.add(asset.url);
      assets.push(asset);
    }
  }
  const result = { assets, warnings };
  if (!warnings.length) {
    if (searchCache.size >= 64) searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(key, { until: Date.now() + 10 * 60_000, result });
  }
  return result;
}

function dimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16000 || height > 16000 || width * height > MAX_PIXELS) {
    throw new Error("Image dimensions are invalid or exceed 40 million pixels.");
  }
  return { width, height };
}

function svgDimensions(bytes: Buffer) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!doctype\b|<!entity\b|<\?xml-stylesheet\b/i.test(source)) throw new Error("SVG declarations and external stylesheets are not supported.");
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`Invalid SVG: ${message}`); } }).parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("Image does not contain a valid SVG root.");
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    if (element.namespaceURI !== root.namespaceURI || /^(?:script|foreignObject|iframe|object|embed|audio|video|animate|animateMotion|animateTransform|set|discard)$/i.test(element.localName ?? "")) throw new Error("SVG contains active content.");
    const values = Array.from(element.attributes).map((attribute) => {
      if (/^on/i.test(attribute.localName ?? "")) throw new Error("SVG contains event handlers.");
      if (/^(?:href|src)$/i.test(attribute.localName ?? "") && !/^#[\w:.-]+$/.test(attribute.value.trim())) throw new Error("SVG contains an external image or reference.");
      return attribute.value;
    });
    if (element.localName === "style") values.push(element.textContent ?? "");
    for (const value of values) {
      if (/\\|@import\b|expression\s*\(|(?:javascript|vbscript)\s*:/i.test(value)) throw new Error("SVG contains active styling.");
      for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
        if (!/^#[\w:.-]+$/.test(match[2].trim())) throw new Error("SVG contains an external resource.");
      }
    }
  }
  const length = (name: string) => {
    const value = root.getAttribute(name) ?? "";
    return /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : 0;
  };
  const viewBox = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  return dimensions(length("width") || (viewBox.length === 4 ? viewBox[2] : 300), length("height") || (viewBox.length === 4 ? viewBox[3] : 150));
}

function rasterHeader(bytes: Buffer): { mimeType: Exclude<ImportedAgentAsset["mimeType"], "image/svg+xml">; extension: string; width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { mimeType: "image/png", extension: "png", ...dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) };
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 255) { offset++; continue; }
      if (marker === 218 || marker === 217) break;
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) {
        return { mimeType: "image/jpeg", extension: "jpg", ...dimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)) };
      }
      offset += size + 2;
    }
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const type = bytes.toString("ascii", 12, 16);
    if (type === "VP8X") return { mimeType: "image/webp", extension: "webp", ...dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1) };
    if (type === "VP8L" && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      return { mimeType: "image/webp", extension: "webp", ...dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) };
    }
    if (type === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) return { mimeType: "image/webp", extension: "webp", ...dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff) };
  }
  return undefined;
}

async function inspectImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Image must contain between 1 byte and 20 MiB.");
  const header = rasterHeader(bytes);
  if (header) {
    // Electron's nativeImage decodes PNG/JPEG but not WebP. FFmpeg is a
    // required local dependency and validates the pixels before publication.
    if (header.mimeType === "image/webp") {
      await new Promise<void>((resolve, reject) => {
        const child = execFile("ffmpeg", ["-v", "error", "-xerror", "-threads", "2", "-max_pixels", String(MAX_PIXELS), "-f", "webp_pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 15_000, maxBuffer: 64_000 }, (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`WebP decoding failed: ${stderr.trim() || error.message}`, { cause: error }));
            return;
          }
          resolve();
        });
        child.stdin?.on("error", reject);
        child.stdin?.end(bytes);
      });
      return header;
    }
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("Image data could not be decoded.");
    return { ...header, ...dimensions(image.getSize().width, image.getSize().height) };
  }
  if (/^\s*(?:<\?xml\b|<!--|<svg\b)/i.test(bytes.toString("utf8", 0, 256))) return { mimeType: "image/svg+xml" as const, extension: "svg", ...svgDimensions(bytes) };
  throw new Error("Only valid SVG, PNG, JPEG, and WebP images can be imported.");
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function projectDirectory(dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new Error("Use an absolute project directory.");
  const root = await realpath(dir);
  if (!(await stat(root)).isDirectory()) throw new Error("Project path is not a directory.");
  return root;
}

async function childDirectory(root: string, segments: string[]): Promise<string> {
  let directory = root;
  for (const segment of segments) {
    const next = join(directory, segment);
    await mkdir(next).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    directory = await realpath(next);
    if (!inside(root, directory)) throw new Error("Project asset directories cannot point outside the project.");
  }
  return directory;
}

async function storeImage(root: string, bytes: Buffer, provenance: Record<string, string | undefined>): Promise<ImportedAgentAsset> {
  const image = await inspectImage(bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const assets = await childDirectory(root, ["assets", "acquired"]);
  const records = await childDirectory(root, [".diffusion", "asset-provenance"]);
  const filename = `${hash}.${image.extension}`;
  const path = join(assets, filename);
  let deduplicated = false;
  // Publish complete bytes with an exclusive hard link. Concurrent imports
  // deduplicate, and the editor never discovers a half-written image.
  const temporary = join(records, `${hash}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o644);
  try {
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await link(temporary, path).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await existing.stat()).size !== bytes.length || !(await existing.readFile()).equals(bytes)) throw new Error("An existing asset has different contents; it was not overwritten.");
      } finally { await existing.close(); }
      deduplicated = true;
    });
  } finally {
    await unlink(temporary);
  }
  const provenancePath = join(records, `${hash}.jsonl`);
  const record = { ...provenance, sha256: hash, mimeType: image.mimeType, width: image.width, height: image.height, importedAt: new Date().toISOString() };
  await appendFile(provenancePath, `${JSON.stringify(record)}\n`, { flag: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, mode: 0o600 });
  return { path, libraryPath: `acquired/${filename}`, mimeType: image.mimeType, width: image.width, height: image.height, provenancePath, deduplicated };
}

export async function importAsset(input: AssetImportRequest): Promise<ImportedAgentAsset> {
  const req = assetImportRequestSchema.parse(input);
  publicUrl(req.url);
  if (req.sourcePageUrl) publicUrl(req.sourcePageUrl);
  const root = await projectDirectory(req.dir);
  const bytes = await download(req.url);
  return storeImage(root, bytes, { kind: "download", title: req.title, url: req.url, sourcePageUrl: req.sourcePageUrl, query: req.query, attribution: req.attribution });
}

/** Internal Codex result boundary. Never expose savedPath as a remote URL import. */
export async function importGeneratedAsset(input: GeneratedAssetImport): Promise<ImportedAgentAsset> {
  const req = generatedAssetImportSchema.parse(input);
  const root = await projectDirectory(req.dir);
  let bytes: Buffer;
  if (req.savedPath) {
    if (!isAbsolute(req.savedPath)) throw new Error("Generated image path must be absolute.");
    const path = await realpath(req.savedPath);
    const codexImages = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images");
    const codexRoot = await realpath(codexImages).catch(() => codexImages);
    if (!inside(root, path) && !inside(codexRoot, path)) throw new Error("Generated image is outside the project and Codex image directories.");
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Generated image must be a file under 20 MiB.");
    bytes = await readFile(path);
  } else {
    const base64 = req.result!;
    if (base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error("Generated image is not valid base64 or exceeds 20 MiB.");
    bytes = Buffer.from(base64, "base64");
  }
  return storeImage(root, bytes, { kind: "generated", title: req.title ?? "Generated image", prompt: req.prompt, savedPath: req.savedPath });
}
