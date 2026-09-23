import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dialog, type BrowserWindow, type WebContentsDidStartNavigationEventParams } from "electron";
import { CodexService } from "./codex";
import type { CodexTool, CodexToolResult } from "./codex-contracts";
import { mainBridge } from "./main-manager";
import { MAIN_CHANNELS } from "./main-channels";
import { editorToolSchema } from "./editor-agent-contracts";
import { handleCatalogRequest } from "./hyperframes-catalog";
import { catalogRequestSchema } from "./hyperframes-contracts";
import { importAsset, importGeneratedAsset, searchAssets } from "./agent-assets";
import { assetImportRequestSchema, assetSearchRequestSchema } from "./agent-asset-contracts";
import { handleManimRequest } from "./manim";
import { manimRequestSchema } from "./manim-contracts";
import { handleAnimationRequest } from "./animations";
import { animationRequestSchema, animationToolSchema } from "./animation-contracts";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints";
import { unwatchProject, watchProject } from "./projects";

const descriptions = {
  editor_effects: "Browse native editable effects, titles, backgrounds, transitions and utilities. Supply id to read one preset's settings and fidelity notes, or query to search. These work on the existing scene and do not need HyperFrames rendering.",
  editor_add_preset: "Add a native Effects library preset by exact preset ID. Supply start/end in scene seconds and optional settings from editor_effects. For transitions place the cut at the interval midpoint; they affect the composited footage across that cut. Supply captured sceneId/sceneSize/frameRate when available. Returns a persistent source ID for edits. No media rendering or audio duplication needed.",
  editor_update_preset: "Revise an existing native preset using its source ID. settings merges with its current text, colors, region and motion controls; start/end retime it. One undo step. For WippHighlight, use editor_update with highlight controls instead.",
  editor_context: "Read the open project's current selection, active scene, playhead, selected asset and asset list.",
  editor_capture: "Inspect a composited video frame without moving the playhead. Optionally specify sceneId and time in scene seconds, for example near a transcript word or cut; otherwise captures the current playhead.",
  editor_add: "Create editable native layers, paints or keyframes from a tree {tag,props,text?,children}. parentId is a source ID and defaults to the active scene. Supports scene3d, mesh, path3d, pointCloud, light and volume alongside text, paths, images, groups and paints. Use start/end in props for timing. The renderer validates every property before insertion. Returns source IDs for further edits and uses one undo step. Read .diffusion/docs/reference/jsx/spatial.md for 3D coordinates, materials and physics.",
  editor_update: "Change any native element using its source ID. Supports numeric animation properties, colors, XYZ path d, point/vertex arrays, camera controls, mesh materials, lights, volume density, physics and rigidBody settings. Existing animation tracks receive numeric, color, path and array edits at the playhead. Uses one normal undo step. For an existing highlight, revise region, magnification, destination, mode, dim, blur, radius, shadow, enter, exit or start/end here instead of adding another effect.",
  editor_insert_asset: "Insert a project library asset into the active scene at the playhead, or at a supplied start time in seconds.",
  editor_add_highlight: "Enlarge a live region of the composited scene and optionally move it to the center. Adds an editable Highlight effect above existing visuals without copying footage or audio. Supply normalized region {x,y,width,height} and start/end in scene seconds; end is exclusive. mode=center moves toward destination [x,y], default [.5,.5]; in-place enlarges where the region is. Pass the attached sceneId, sceneSize and frameRate when available so stale frame geometry is rejected. Options: magnification default1.8, dim .45, blur8px, radius12px, shadow .35, enter/exit .35seconds. Returns source ID and snapped timing; use editor_update for revisions.",
};

export function registerAgentBridge(dataDir: string, getWindow: () => BrowserWindow | null) {
  const pending = new Map<string, (value: CodexToolResult) => void>();
  const tools: CodexTool[] = editorToolSchema.options.map((option) => ({
    name: option.shape.name.value,
    description: descriptions[option.shape.name.value],
    inputSchema: z.json().parse(z.toJSONSchema(option.shape.args)),
  }));
  tools.push(
    { name: "project_animations", description: "List, render, convert to editable layers, cancel or export this project's retained HyperFrames and Manim animations. action=editable creates a native JSX component and returns its path, dimensions, layer/key counts and conversion report. Unsupported visual features fail unless allowPartial is explicitly requested. It preserves original source and never inserts or replaces timeline content automatically. Register source in package.json diffusion.animations first; read .diffusion/docs/reference/animation.md. Renders appear in Animations without timeline insertion. Export requires output: MP4 for opaque clips or MOV with alpha for transparent overlays. Use editor_insert_asset with libraryPath only when placement is requested.", inputSchema: z.json().parse(z.toJSONSchema(animationToolSchema)) },
    { name: "manim_animations", description: "List or render registered Manim animations. Prefer project_animations for the shared Animations view and export. Rendering preserves source and does not insert a timeline clip.", inputSchema: z.json().parse(z.toJSONSchema(manimRequestSchema)) },
    { name: "asset_search", description: "Search for logos or images. Returns candidates with URLs and source attribution; use asset_import to add one to the project.", inputSchema: z.json().parse(z.toJSONSchema(assetSearchRequestSchema)) },
    { name: "asset_import", description: "Download a public HTTPS image into this project's Assets, retaining its source URL. Use editor_insert_asset to place it in the scene when requested.", inputSchema: z.json().parse(z.toJSONSchema(assetImportRequestSchema.omit({ dir: true }))) },
    { name: "hyperframes_catalog", description: "Browse, inspect, install and render HyperFrames website video templates, starter examples, blocks and components. Website templates include original editable source, assets, variables and remix guidance. Installed source remains editable. Components need composition wiring before rendering. Rendered output is a project library asset.", inputSchema: z.json().parse(z.toJSONSchema(catalogRequestSchema)) },
    { name: "hyfrme_catalog", description: "Browse, inspect, install and render Hyfrme motion blocks from the separate Hyfrme catalog. Use type=block. Installed HTML, JavaScript, fonts and licenses remain editable; render produces a project library asset.", inputSchema: z.json().parse(z.toJSONSchema(catalogRequestSchema)) },
  );

  const runTool = async (path: string, name: string, args: unknown, signal?: AbortSignal): Promise<CodexToolResult> => {
    signal?.throwIfAborted();
    if (name === "project_animations") {
      const request = animationRequestSchema.parse({ ...z.record(z.string(), z.unknown()).parse(args), dir: path });
      const data = request.action === "list" || request.action === "cancel"
        ? await handleAnimationRequest(request, undefined, signal)
        : await codex.withProjectMutation(path, (dir) => {
          signal?.throwIfAborted();
          return handleAnimationRequest({ ...request, dir }, undefined, signal);
        });
      const summary = "tree" in data ? (({ tree, ...summary }) => summary)(data) : data;
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(summary) }] };
    }
    return codex.withProjectMutation(path, async (dir): Promise<CodexToolResult> => {
      signal?.throwIfAborted();
      if (name === "manim_animations") {
        const input = z.record(z.string(), z.unknown()).parse(args);
        const data = await handleManimRequest({ ...input, dir }, signal);
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] };
      }
      if (name === "asset_search" || name === "asset_import" || name === "hyperframes_catalog" || name === "hyfrme_catalog") {
        const input = z.record(z.string(), z.unknown()).parse(args);
        const data = name === "asset_search" ? await searchAssets(assetSearchRequestSchema.parse(input))
          : name === "asset_import" ? await importAsset(assetImportRequestSchema.parse({ ...input, dir }))
          : await handleCatalogRequest({ ...input, dir }, name === "hyfrme_catalog" ? "hyfrme" : "hyperframes", signal);
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] };
      }
      const tool = editorToolSchema.parse({ name, args });
      const window = getWindow();
      if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) throw new Error("Editor is not ready");
      const id = randomUUID();
      return new Promise<CodexToolResult>((resolve) => {
        const finish = (result: CodexToolResult) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          window.webContents.off("did-start-navigation", onNavigate);
          window.webContents.off("render-process-gone", onGone);
          window.off("closed", onClosed);
          resolve(result);
        };
        const fail = (text: string) => finish({ success: false, contentItems: [{ type: "inputText", text }] });
        const onNavigate = (event: WebContentsDidStartNavigationEventParams) => {
          if (event.isMainFrame && !event.isSameDocument) fail("The editor reloaded before replying");
        };
        const onGone = () => fail("The editor renderer crashed before replying");
        const onClosed = () => fail("The editor window closed before replying");
        const timer = setTimeout(() => fail("Editor did not respond within 60 seconds"), 60_000);
        pending.set(id, finish);
        window.webContents.on("did-start-navigation", onNavigate);
        window.webContents.on("render-process-gone", onGone);
        window.on("closed", onClosed);
        try {
          mainBridge.emit(window, MAIN_CHANNELS.EDITOR_TOOL, { ...tool, id, dir });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
    });
  };

  const restoreProject = async (dir: string, id: string) => {
    unwatchProject(dir);
    try {
      return await restoreCheckpoint(dir, id);
    } finally {
      // A refresh failure must not make a completed restore retryable.
      try { watchProject(getWindow(), dir); }
      catch (error) { console.error("[projects] Could not restart watching after restore", error); }
      try { mainBridge.emit(getWindow(), MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path: "package.json" }); }
      catch (error) { console.error("[projects] Could not refresh editor after restore", error); }
    }
  };

  const codex = new CodexService({
    dataDir, tools, runTool,
    restoreCheckpoint: restoreProject,
    onEvent: (event) => mainBridge.emit(getWindow(), MAIN_CHANNELS.CODEX_EVENT, event),
    importGenerated: async (dir, image) => z.json().parse(await importGeneratedAsset({
      dir, prompt: image.prompt || "Codex generated image",
      ...(image.savedPath ? { savedPath: image.savedPath } : { result: image.result }),
    })),
  });

  mainBridge.handle(MAIN_CHANNELS.AGENT_TOOL_CALL, ({ dir, name, args }) => runTool(dir, name, args));
  mainBridge.handle(MAIN_CHANNELS.CODEX_REQUEST, (request) => codex.request(request));
  mainBridge.handle(MAIN_CHANNELS.CHECKPOINTS_LIST, ({ dir }) => listCheckpoints(dir));
  mainBridge.handle(MAIN_CHANNELS.CHECKPOINTS_CREATE, ({ dir, label }) => codex.withProjectIdle(dir, (path) => createCheckpoint(path, label)));
  mainBridge.handle(MAIN_CHANNELS.CHECKPOINTS_RESTORE, ({ dir, id }) => codex.withProjectIdle(dir, (path) => restoreProject(path, id)));
  mainBridge.handle(MAIN_CHANNELS.HYPERFRAMES_REQUEST, (request) => "dir" in request ? codex.withProjectMutation(request.dir, (dir) => handleCatalogRequest({ ...request, dir })) : handleCatalogRequest(request));
  mainBridge.handle(MAIN_CHANNELS.HYFRME_REQUEST, (request) => "dir" in request ? codex.withProjectMutation(request.dir, (dir) => handleCatalogRequest({ ...request, dir }, "hyfrme")) : handleCatalogRequest(request, "hyfrme"));
  mainBridge.handle(MAIN_CHANNELS.MANIM_REQUEST, (request) => request.action === "render" ? codex.withProjectMutation(request.dir, (dir) => handleManimRequest({ ...request, dir })) : handleManimRequest(request));
  mainBridge.handle(MAIN_CHANNELS.ANIMATION_REQUEST, (request) => {
    if (request.action === "list" || request.action === "cancel") return handleAnimationRequest(request);
    return codex.withProjectMutation(request.dir, (dir) => handleAnimationRequest({ ...request, dir }, async ({ defaultPath, transparent }) => {
      const options = {
        title: "Export animation", defaultPath,
        filters: transparent ? [{ name: "QuickTime with alpha", extensions: ["mov"] }] : [{ name: "MP4 video", extensions: ["mp4"] }],
      };
      const window = getWindow();
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      return result.canceled ? null : result.filePath ?? null;
    }));
  });
  mainBridge.handle(MAIN_CHANNELS.ASSETS_SEARCH, (request) => searchAssets(request));
  mainBridge.handle(MAIN_CHANNELS.ASSETS_IMPORT, (request) => codex.withProjectMutation(request.dir, (dir) => importAsset({ ...request, dir })));
  mainBridge.handle(MAIN_CHANNELS.EDITOR_TOOL_RESULT, ({ id, result }) => {
    pending.get(id)?.(result);
  });
  return {
    dispose: () => {
      for (const finish of pending.values()) finish({ success: false, contentItems: [{ type: "inputText", text: "The editor stopped before replying" }] });
      codex.dispose();
    },
    runTool,
    prepareTurn: ({ cwd, text }: { cwd: string; text: string }) => codex.prepareExternalTurn(cwd, text),
  };
}
