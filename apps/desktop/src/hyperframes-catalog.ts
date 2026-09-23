import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { renderAnimation } from "../../cli/src/animation";
import { catalogEntrySchema, catalogItemSchema, catalogPreviewSchema, catalogRequestSchema } from "./hyperframes-contracts";
import type { CatalogEntry, CatalogItem, CatalogRequest, CatalogResponse, CatalogSource } from "./hyperframes-contracts";
import { installWebsiteTemplate, templatePackageUrl, templateRepository, templateRevision, websiteTemplates } from "./hyperframes-templates";

const upstream = "https://raw.githubusercontent.com/heygen-com/hyperframes/main";
const hyfrme = "https://hyfrme.vercel.app";
const typeDirs = { example: "examples", block: "blocks", component: "components" } as const;
const day = 24 * 60 * 60 * 1000;
const recordSchema = z.record(z.string(), z.unknown());

function dataDirectory() {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "diffusion-studio");
}

async function fetchJson(path: string, root = upstream): Promise<unknown> {
  const response = await fetch(`${root}/${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Catalog download failed: HTTP ${response.status} for ${root}/${path}`);
  return response.json();
}

async function cached<T>(key: string, schema: z.ZodType<T>, fetchValue: () => Promise<T>, refresh = false) {
  const path = join(dataDirectory(), "catalog", `${key}.json`);
  const entrySchema = z.object({ fetchedAt: z.number(), value: schema });
  const previous = await readFile(path, "utf8").then((text) => entrySchema.parse(JSON.parse(text))).catch(() => undefined);
  if (!refresh && previous && Date.now() - previous.fetchedAt < day) return { value: previous.value, cached: true };
  try {
    const value = await fetchValue();
    await mkdir(join(dataDirectory(), "catalog"), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fetchedAt: Date.now(), value }));
    await rename(temporary, path);
    return { value, cached: false };
  } catch (error) {
    if (previous) return { value: previous.value, cached: true };
    throw error;
  }
}

export async function getCatalogItem(input: { name: string; type: CatalogEntry["type"] }, catalog: CatalogSource = "hyperframes", refresh = false): Promise<CatalogItem> {
  const { name, type } = input;
  if (catalog === "hyfrme" && type !== "block") throw new Error("Hyfrme catalog items are blocks.");
  const result = await cached(`${catalog}-manifest-v3-${type}-${name}`, catalogItemSchema, async () => {
    if (type === "template") {
      const packageUrl = templatePackageUrl(name);
      const raw = recordSchema.parse(await fetchJson(`registry/blocks/${name}/registry-item.json`, templateRepository));
      if (raw.name !== name || raw.type !== "hyperframes:block") throw new Error("Template identity does not match its manifest.");
      const instructions = await fetch(`${templateRepository}/registry/blocks/${name}/TEMPLATE.md`, { signal: AbortSignal.timeout(10_000) });
      if (!instructions.ok) throw new Error(`Template instructions download failed: HTTP ${instructions.status}.`);
      const entry = websiteTemplates.find((item) => item.name === name)!;
      return catalogItemSchema.parse({
        ...raw, ...entry, preview: { poster: entry.poster, video: entry.video },
        templateSource: {
          website: "https://www.hyperframes.dev/", repository: "https://github.com/heygen-com/hyperframes", revision: templateRevision,
          packageUrl, license: "Apache-2.0", instructions: await instructions.text(),
        },
      });
    }
    const raw = recordSchema.parse(await fetchJson(`registry/${typeDirs[type]}/${name}/registry-item.json`, catalog === "hyfrme" ? hyfrme : upstream));
    if (raw.type !== `hyperframes:${type}` || raw.name !== name) throw new Error("Catalog item identity does not match its manifest.");
    // Template previews are published separately from their registry manifests.
    const preview = catalog === "hyfrme"
      ? { poster: `${hyfrme}/previews/${name}/thumbnail.png`, video: `${hyfrme}/previews/${name}/hyperframes.mp4` }
      : raw.preview ?? (type === "example" ? {
        poster: `https://static.heygen.ai/hyperframes-oss/docs/images/templates/${name}.png`,
        video: `https://static.heygen.ai/hyperframes-oss/docs/images/templates/${name}.mp4`,
      } : undefined);
    return catalogItemSchema.parse({ ...raw, type, preview });
  }, refresh);
  return result.value;
}

export async function listCatalog(catalog: CatalogSource = "hyperframes", refresh = false) {
  const result = await cached(catalog === "hyfrme" ? "hyfrme-catalog" : "catalog-v2", z.array(catalogEntrySchema), async () => {
    if (catalog === "hyfrme") {
      const [indexValue, registryValue] = await Promise.all([
        fetchJson("src/generated/catalog-data.json", "https://raw.githubusercontent.com/AksharP5/hyfrme/main"),
        fetchJson("registry/registry.json", hyfrme),
      ]);
      const index = z.array(z.object({ item: catalogEntrySchema.omit({ type: true, poster: true, video: true }) })).parse(indexValue);
      const registry = z.object({ items: z.array(z.object({ name: catalogEntrySchema.shape.name, type: z.literal("hyperframes:block") })) }).parse(registryValue);
      const names = new Set(registry.items.map((item) => item.name));
      return index.filter(({ item }) => names.has(item.name)).map(({ item }) => catalogEntrySchema.parse({
        ...item, type: "block", poster: `${hyfrme}/previews/${item.name}/thumbnail.png`, video: `${hyfrme}/previews/${item.name}/hyperframes.mp4`,
      })).sort((a, b) => a.title.localeCompare(b.title));
    }
    const [indexValue, registryValue] = await Promise.all([
      fetchJson("docs/public/catalog-index.json"), fetchJson("registry/registry.json"),
    ]);
    const index = z.array(catalogEntrySchema.omit({ poster: true }).extend({ preview: z.string().optional() })).parse(indexValue);
    const registry = z.object({ items: z.array(z.object({ name: catalogEntrySchema.shape.name, type: z.enum(["hyperframes:example", "hyperframes:block", "hyperframes:component"]) })) }).parse(registryValue);
    const names = new Set(registry.items.map((item) => `${item.type}:${item.name}`));
    const items = index.filter((item) => names.has(`hyperframes:${item.type}:${item.name}`)).map((item) =>
      catalogEntrySchema.parse({ ...item, ...(item.preview ? { poster: item.preview } : {}) }),
    );
    const examples = await Promise.all(registry.items.filter((item) => item.type === "hyperframes:example").map((item) =>
      getCatalogItem({ name: item.name, type: "example" }, catalog, refresh),
    ));
    return [...examples.map((item) => catalogEntrySchema.parse({ ...item, ...item.preview })), ...items];
  }, refresh);
  return { items: catalog === "hyperframes" ? [...websiteTemplates, ...result.value] : result.value, cached: result.cached };
}

async function inside(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path)) throw new Error("Catalog files must use relative project paths.");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Catalog path escapes the project.");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error("Catalog paths cannot traverse symbolic links.");
  }
  return target;
}

async function runCatalogCli(catalog: CatalogSource, args: string[], cwd: string) {
  const executable = (catalog === "hyfrme" ? process.env.DIFFUSION_HYFRME_BIN : process.env.DIFFUSION_HYPERFRAMES_BIN)
    ?? join(dataDirectory(), "tools", "node_modules", ".bin", catalog);
  const env: NodeJS.ProcessEnv = { ...process.env, DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_SKIP_SKILLS: "1" };
  if (catalog === "hyfrme") env.HYFRME_REGISTRY_URL = `${hyfrme}/registry`;
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output = (output + chunk).slice(-1_000_000); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-4000); });
    child.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "ENOENT" ? `${catalog} is not installed. Run npm run setup:local in the editor repository.` : error.message)));
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${catalog === "hyfrme" ? "Hyfrme" : "HyperFrames"} exited ${code}: ${(errorOutput || output).trim()}`)));
  });
}

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function writeBlockHost(source: string, item: Extract<CatalogItem, { type: "block" }>) {
  const entry = item.files.find((file) => file.type === "hyperframes:composition");
  if (!entry) throw new Error("This block has no composition file.");
  const html = await readFile(await inside(source, entry.target), "utf8");
  const root = html.match(/<[a-z][^>]*\bdata-composition-id\s*=\s*["']([^"']+)["'][^>]*>/i);
  const id = root?.[1];
  if (!id) throw new Error("This block has no composition ID.");
  const fps = root[0].match(/\bdata-fps\s*=\s*["']([^"']+)["']/i)?.[1].trim();
  const { width, height } = item.dimensions;
  await writeFile(join(source, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>${attribute(item.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden} [data-composition-src]{position:absolute;inset:0}</style></head>
<body><div id="catalog-root" data-composition-id="catalog-root" data-width="${width}" data-height="${height}" data-start="0" data-duration="${item.duration}"${fps ? ` data-fps="${attribute(fps)}"` : ""}>
<div id="catalog-block" data-composition-id="${attribute(id)}" data-composition-src="${attribute(entry.target)}" data-width="${width}" data-height="${height}" data-start="0" data-duration="${item.duration}" data-track-index="0"></div>
</div><script>window.__timelines = window.__timelines || {}; window.__timelines["catalog-root"] = gsap.timeline({paused:true});</script></body></html>\n`, { flag: "wx" });
}

const packageUpdates = new Map<string, Promise<void>>();

async function updatePackage(root: string, update: () => Promise<void>) {
  const previous = packageUpdates.get(root) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(update);
  packageUpdates.set(root, current);
  try { await current; }
  finally { if (packageUpdates.get(root) === current) packageUpdates.delete(root); }
}

export async function installCatalogItem(input: { dir: string; name: string; type: CatalogEntry["type"] }, catalog: CatalogSource = "hyperframes") {
  const item = await getCatalogItem(input, catalog);
  const root = await realpath(input.dir);
  const packagePath = await inside(root, "package.json");
  recordSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
  const animations = await inside(root, "animations");
  await inside(root, "assets");
  await mkdir(animations, { recursive: true });
  const source = await mkdtemp(join(animations, `${item.name}-`));
  const id = source.slice(animations.length + 1).toLowerCase();
  let snippet = "";
  try {
    if (catalog === "hyfrme") {
      await writeFile(join(source, "hyperframes.json"), JSON.stringify({ registry: `${hyfrme}/registry` }, null, 2) + "\n", { flag: "wx" });
      snippet = await runCatalogCli(catalog, ["add", item.name, "--dir", source], root);
      if (item.type === "block") await writeBlockHost(source, item);
    } else if (item.type === "template") {
      await installWebsiteTemplate(source, item);
    } else if (item.type === "example") {
      await runCatalogCli(catalog, ["init", source, "--example", item.name, "--non-interactive"], root);
    } else {
      const result = z.object({ ok: z.literal(true), snippet: z.string() }).parse(JSON.parse(await runCatalogCli(catalog, [
        "add", item.name, "--dir", source, "--no-clipboard", "--json",
      ], root)));
      snippet = result.snippet;
      if (item.type === "block") await writeBlockHost(source, item);
    }
    if (item.type === "component") return { id, type: item.type, source: relative(root, source), snippet };
    await readFile(join(source, "index.html"));
    const output = `assets/${id}.mp4`;
    const config = { engine: "hyperframes", source: relative(root, source), output, ...(item.type === "template" ? { entry: "index.html" } : {}) };
    // Downloads can overlap; each registration merges the latest package under this reservation.
    await updatePackage(root, async () => {
      const original = await readFile(packagePath, "utf8");
      const pkg = recordSchema.parse(JSON.parse(original));
      const diffusion = pkg.diffusion === undefined ? {} : recordSchema.parse(pkg.diffusion);
      const registered = diffusion.animations === undefined ? {} : recordSchema.parse(diffusion.animations);
      if (id in registered) throw new Error(`Animation ${id} already exists.`);
      const outputPath = await inside(root, output);
      const existingOutput = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (existingOutput) throw new Error(`Asset ${output} already exists.`);
      const temporary = join(root, `.package-${randomUUID()}.json`);
      await writeFile(temporary, JSON.stringify({ ...pkg, diffusion: { ...diffusion, animations: { ...registered, [id]: config } } }, null, 2) + "\n", { flag: "wx" });
      try {
        if (await readFile(packagePath, "utf8") !== original) throw new Error("Project settings changed during installation. Source was kept; retry registration after the edit finishes.");
        await rename(temporary, packagePath);
      } finally { await rm(temporary, { force: true }); }
    });
    return { id, type: item.type, source: config.source, output, snippet };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Source kept at ${relative(root, source)}.`, { cause: error });
  }
}

export async function handleCatalogRequest(input: unknown, catalog: CatalogSource = "hyperframes", signal?: AbortSignal): Promise<CatalogResponse> {
  signal?.throwIfAborted();
  const request: CatalogRequest = catalogRequestSchema.parse(input);
  switch (request.action) {
    case "list": return { action: "list", ...await listCatalog(catalog, request.refresh) };
    case "detail": return { action: "detail", item: await getCatalogItem(request, catalog) };
    case "preview": {
      if (catalog !== "hyperframes") throw new Error("Hyfrme previews use the item's published video.");
      const result = await cached(`preview-${request.type}-${request.name}`, catalogPreviewSchema, async () =>
        catalogPreviewSchema.parse(await fetchJson(`docs/public/catalog/${typeDirs[request.type]}/${request.name}.json`)),
      );
      return { action: "preview", ...result.value };
    }
    case "install": return { action: "install", ...await installCatalogItem(request, catalog) };
    case "render": {
      const result = await renderAnimation(request.id, request.dir, "hyperframes", signal);
      const root = await realpath(request.dir);
      const path = relative(join(root, "assets"), result.output);
      const libraryPath = path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : null;
      return { action: "render", id: result.id, output: relative(root, result.output), libraryPath };
    }
  }
}
