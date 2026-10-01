/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, BrowserWindow, dialog, nativeImage, session, shell } from "electron";
import { userDataDirectory } from "./app-paths";
import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { abortFileWrite, closeFileWrite, openFileWrite } from "./file-write";
import type { OpenFileWrite } from "./file-write";
import { allowsMediaCheck, allowsMediaRequest, isEditorUrl, isExternalWebUrl } from "./window-security";
import { DapiServer } from "./dapi/server";
import { RendererCalls } from "./dapi/renderer-calls";
import { Workspaces } from "./workspaces";
import { toolByName } from "@diffusionstudio/dapi";
import type { ToolArgs, ToolOutput } from "@diffusionstudio/dapi";
import type { CodexRequest } from "./codex-contracts";
import { agentChatEndpoint, cancelProjectAgents, configureAgentChat, deleteProjectChats, stopAgentChat } from "./agent-chat";
import { cliStatus, installCli, uninstallCli } from "./cli-install";
import { applyMcp, healMcpRegistrations, mcpStatus } from "./mcp-install";
import { trackEvent, trackInstall } from "./analytics";
import { setupAppMenu } from "./menu";
import { AppTray } from "./tray";
import { transcribeLocal } from "./transcription";
import { openOriginalVideo, readOriginalVideo, closeOriginalVideo, disposeOriginalVideos, prepareOriginalAudio, listMediaStreams } from "./media-original";
import { createRecoveryCheckpoint } from "./checkpoints";
import { analyzeLoudness } from "./audio-analysis";
import { preparePlaybackCopy } from "./media-playback";
import { findMissingMedia, collectMediaSources } from "./media-portability";
import { shutdownAnimations } from "../../cli/src/animation";
import { registerAgentBridge } from "./agent-bridge";
import { mainBridge } from "./main-manager";
import { MAIN_CHANNELS } from "./main-channels";
import {
  compileProject,
  createProject,
  defaultRoot,
  deleteProject,
  duplicateProject,
  getProject,
  initProject,
  pickFolder,
  pickRoot,
  renameProject,
  resolveProject,
  scanProjects,
  unwatchAll,
  listEntries,
  realPathEntry,
  noteRenamed,
  readConfig,
  readManifest,
  removeEntry,
  statEntry,
  unwatchProject,
  watchProject,
  writeConfig,
  writeManifest,
  writeProject,
} from "./projects";
import type { DeepLinkChannel } from "./main-channels";
import type { LogEntry } from "@diffusionstudio/dapi";

const DEV_URL = process.env.FRAMEYARD_DEV_URL ?? "http://localhost:5173";
const WINDOW_IDLE_MS = 10 * 60 * 1000;
const AUTH_PROTOCOL = "diffusion";
const MACOS_CORNER_RADIUS = 18;
const MACOS_BACKDROP = { blur: 80, red: 0.07, green: 0.07, blue: 0.07, alpha: 0.9 };
const WINDOWS_OVERLAY_HEIGHT = 40;
const WINDOWS_OVERLAY_COLORS = {
  dark: { color: "#121212", symbolColor: "#a1a1a1" },
  light: { color: "#f7f7f7", symbolColor: "#737373" },
};

function editorUrl(): string {
  return app.isPackaged ? pathToFileURL(join(app.getAppPath(), "web", "index.html")).href : DEV_URL;
}

function openExternalWebUrl(url: string): void {
  if (!isExternalWebUrl(url)) return;
  void shell.openExternal(url).catch((error) => console.error("Could not open external link", error));
}

app.setName("Frameyard");
app.setPath("userData", userDataDirectory(app.getPath("appData")));
app.commandLine.appendSwitch("class", "frameyard");
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// Dawn hides shader-f16 on NVIDIA by default, but the local SAM 2.1 models need it.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-dawn-features", "vulkan_enable_f16_on_nvidia");
}

let setNativeCornerRadius: ((handle: Buffer, radius: number) => void) | null = null;
let setNativeBackdrop:
  | ((handle: Buffer, blur: number, r: number, g: number, b: number, a: number) => void)
  | null = null;

if (process.platform === "darwin") {
  ({ setCornerRadius: setNativeCornerRadius, setBackdrop: setNativeBackdrop } = require(
    join(app.getAppPath(), "dist", "corner_radius.node"),
  ));
}

function applyCornerRadius(radius: number, window = mainWindow) {
  if (!setNativeCornerRadius || !window || window.isDestroyed()) return;
  setNativeCornerRadius(window.getNativeWindowHandle(), radius);
}

function applyBackdrop(window = mainWindow) {
  if (!setNativeBackdrop || !window || window.isDestroyed()) return;
  const { blur, red, green, blue, alpha } = MACOS_BACKDROP;
  setNativeBackdrop(window.getNativeWindowHandle(), blur, red, green, blue, alpha);
}

const openWrites = new Map<string, { entry: OpenFileWrite; owner: number }>();

function ownedWrite(id: string, owner: number): OpenFileWrite | undefined {
  const write = openWrites.get(id);
  if (write && write.owner !== owner) throw new Error("This output belongs to another project window");
  return write?.entry;
}

async function abortWindowWrites(owner: number): Promise<void> {
  const writes = [...openWrites].filter(([, write]) => write.owner === owner);
  for (const [id] of writes) openWrites.delete(id);
  await Promise.all(writes.map(([, write]) => abortFileWrite(write.entry).catch(error => console.error("Could not release interrupted output", error))));
}

let mainWindow: BrowserWindow | null = null;
const editorWindows = new Set<BrowserWindow>();

// Deep links that arrived before the renderer could take them, keyed by the
// channel they belong to so auth and checkout never drain each other's link.
const pendingDeepLinks = new Map<DeepLinkChannel, string>();

// Renderer console mirror, served to the CLI via LOGS_GET. Lives in main so
// it survives reloads and captures everything the devtools console shows
// (page logs, worker logs, uncaught errors) without touching the web bundle.
const LOG_BUFFER_MAX = 2000;
const logBuffer: LogEntry[] = [];

// The docs the MCP instructions point agents at: staged into the bundle by
// scripts/stage-docs.mjs (Contents/Resources/docs) when packaged; the repo's
// own `docs/` in development, so edits show up without a staging step. Null
// when neither exists.
function docsDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, "docs") : join(app.getAppPath(), "..", "..", "docs");
  return existsSync(dir) ? dir : null;
}

function pushLog(level: LogEntry["level"], message: string, source: string) {
  logBuffer.push({ ts: Date.now(), level, message, source });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function captureConsole(window: BrowserWindow) {
  window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    pushLog(level, message, sourceId ? `${sourceId}:${lineNumber}` : "");
  });
  window.webContents.on("preload-error", (_event, path, error) => {
    pushLog("error", `Preload error: ${error.message}`, path);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    pushLog("error", `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`, "");
    void disposeOriginalVideos(window.webContents.id);
    void abortWindowWrites(window.webContents.id);
  });
}

function findProtocolUrl(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`)) ?? null;
}

function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes("--hidden");
}

// diffusion://auth/callback → auth, diffusion://checkout/callback → checkout.
function deepLinkChannel(url: string): DeepLinkChannel | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  if (host === "auth") return MAIN_CHANNELS.AUTH_CALLBACK;
  if (host === "checkout") return MAIN_CHANNELS.CHECKOUT_CALLBACK;
  return null;
}

function deliverDeepLink(url: string) {
  const channel = deepLinkChannel(url);
  if (!channel) return;

  // A link that arrives before the page can receive it is parked rather than
  // pushed: the renderer's subscription only exists once the component holding
  // it mounts, which is well after did-finish-load. Parked links are handed
  // over by the take* handlers below, which every consumer calls on mount.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
    pendingDeepLinks.set(channel, url);
    return;
  }

  mainBridge.emit(mainWindow, channel, { url });
}

function takePendingDeepLink(channel: DeepLinkChannel): string | null {
  const url = pendingDeepLinks.get(channel) ?? null;
  pendingDeepLinks.delete(channel);
  return url;
}

async function setFileInputFiles(window: BrowserWindow | null, selector: string, absolutePath: string) {
  if (!window) throw new Error("No editor window");
  const wc = window.webContents;
  // Stay attached between calls — attach/detach dominates the cost of a
  // transfer, and file materialization happens in bursts.
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const { root } = await wc.debugger.sendCommand("DOM.getDocument");
  const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`Selector not found: ${selector}`);
  await wc.debugger.sendCommand("DOM.setFileInputFiles", {
    files: [absolutePath],
    nodeId,
  });
}

function createWindow(show = true, background = false): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
          vibrancy: "sidebar" as const,
          backgroundColor: "#00000000",
        }
      : process.platform === "win32"
        ? { titleBarStyle: "hidden" as const, titleBarOverlay: { ...WINDOWS_OVERLAY_COLORS.dark, height: WINDOWS_OVERLAY_HEIGHT }, backgroundColor: WINDOWS_OVERLAY_COLORS.dark.color, autoHideMenuBar: true }
        : { backgroundColor: "#1c1c1c", autoHideMenuBar: true }),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.js"),
      // Keep the playback timer active when the compositor stops presenting frames.
      backgroundThrottling: false,
    },
  });

  if (!background) mainWindow = window;
  editorWindows.add(window);
  captureConsole(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalWebUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isEditorUrl(url, editorUrl())) return;
    event.preventDefault();
    openExternalWebUrl(url);
  });

  applyCornerRadius(MACOS_CORNER_RADIUS, window);
  applyBackdrop(window);

  window.once("ready-to-show", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS, window);
    applyBackdrop(window);

    if (show) {
      window?.show();
    }
  });

  window.on("hide", () => mainBridge.emit(window, MAIN_CHANNELS.WORKSPACE_VISIBILITY, { visible: false }));
  window.on("show", () => {
    mainBridge.emit(window, MAIN_CHANNELS.WORKSPACE_VISIBILITY, { visible: true });
    applyCornerRadius(MACOS_CORNER_RADIUS, window);
    applyBackdrop(window);
  });

  window.on("enter-full-screen", () => {
    applyCornerRadius(0, window);
    mainBridge.emit(window, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: true });
  });
  window.on("leave-full-screen", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS, window);
    mainBridge.emit(window, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: false });
  });
  const mediaOwner = window.webContents.id;
  window.webContents.once("destroyed", () => { void disposeOriginalVideos(mediaOwner); void abortWindowWrites(mediaOwner); });
  window.on("closed", () => {
    editorWindows.delete(window);
    if (mainWindow === window) mainWindow = null;
  });

  if (!app.isPackaged) {
    const url = new URL(DEV_URL);
    if (background) url.searchParams.set("workspace", "background");
    void window.loadURL(url.href);
  } else {
    void window.loadFile(join(app.getAppPath(), "web", "index.html"), background ? { query: { workspace: "background" } } : undefined);
  }
  return window;
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
    join(process.cwd(), process.argv[1]!),
  ]);
} else {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
}

if (app.requestSingleInstanceLock()) {
  let tray: AppTray | null = null;
  let quitting = false;
  let mainIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const busyWindows = new Set<BrowserWindow>();
  const presented = (window: BrowserWindow) => window.isVisible() || window.isMinimized();
  const visible = () => [...editorWindows].some(window => !window.isDestroyed() && presented(window));
  const refreshTray = () => tray?.refresh();
  const scheduleMainIdle = () => {
    if (mainIdleTimer) clearTimeout(mainIdleTimer);
    mainIdleTimer = null;
    const window = mainWindow;
    if (!window || window.isDestroyed() || presented(window) || busyWindows.has(window) || workspaces.directory(window)) return;
    mainIdleTimer = setTimeout(() => {
      mainIdleTimer = null;
      if (mainWindow === window && !window.isDestroyed() && !presented(window) && !busyWindows.has(window) && !workspaces.directory(window)) window.destroy();
    }, WINDOW_IDLE_MS);
    mainIdleTimer.unref();
  };
  const createTrackedWindow = (show = true, background = false) => {
    const window = createWindow(show, background);
    window.on("close", event => {
      if (quitting) return;
      event.preventDefault();
      if (window.isMinimized()) window.restore();
      window.hide();
    });
    window.on("show", () => { void app.dock?.show(); refreshTray(); scheduleMainIdle(); });
    window.on("hide", () => { if (!visible()) void app.dock?.hide(); refreshTray(); scheduleMainIdle(); });
    window.on("closed", () => { busyWindows.delete(window); refreshTray(); scheduleMainIdle(); });
    scheduleMainIdle();
    return window;
  };
  const showMainWindow = async () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createTrackedWindow(false);
    await app.dock?.show();
    if (window.webContents.isLoadingMainFrame()) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000);
        window.once("ready-to-show", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    refreshTray();
  };
  const hideWindows = () => {
    for (const window of editorWindows) {
      if (window.isDestroyed() || !presented(window)) continue;
      if (window.isMinimized()) window.restore();
      window.hide();
    }
    if (!visible()) void app.dock?.hide();
    refreshTray();
  };
  mainBridge.authorizeSender((event) =>
    [...editorWindows].some(window => event.sender === window.webContents) &&
    event.senderFrame === event.sender.mainFrame &&
    isEditorUrl(event.senderFrame?.url ?? "", editorUrl()));
  let legacyAgentWindow: BrowserWindow | null = null;
  let legacyAgentProject: string | undefined;
  const renderer = new RendererCalls();
  const workspaces = new Workspaces({
    createWindow: () => createTrackedWindow(false, true),
    open: async (window, dir) => toolByName("open").output.parse(await renderer.call("open", { dir }, new AbortController().signal, window)),
    changed: result => {
      for (const window of editorWindows) mainBridge.emit(window, MAIN_CHANNELS.WORKSPACES_CHANGED, result);
      refreshTray();
      scheduleMainIdle();
    },
    release: unwatchProject,
  });
  tray = new AppTray({
    visible,
    active: () => busyWindows.size > 0 || workspaces.list().workspaces.some(workspace => workspace.agentActive || workspace.jobs.length > 0),
    project: () => legacyAgentProject ?? null,
    show: () => { void showMainWindow(); },
    hide: hideWindows,
  });
  const codex = registerAgentBridge(app.getPath("userData"), dir => dir ? workspaces.getWindow(dir) : mainWindow, {
    window: (dir, signal) => workspaces.open(dir, signal),
    run: (dir, name, signal, operation, heavy) => workspaces.run(dir, name, signal, operation, heavy),
    withProjectIdle: (dir, operation) => workspaces.withProjectIdle(dir, operation),
    externalTurn: (dir, active) => workspaces.setAgent(dir, active),
    event: event => {
      if (event.type === "turn") workspaces.setAgent(event.dir, event.status === "started", event.error);
    },
  });
  const requestCodex = async (request: CodexRequest) => {
    if (request.method === "send" && !request.input.expectedTurnId) {
      const dir = await realpath(request.input.dir);
      const window = await workspaces.open(dir);
      const context = toolByName("context").output.parse(await renderer.call("context", {}, new AbortController().signal, window));
      if (!context.projectDir || await realpath(context.projectDir) !== dir) throw new Error("The editor context does not belong to the requested project");
      if (workspaces.list().workspaces.some(value => value.dir === dir && value.agentActive)) throw new Error("Another agent is already working in this project");
      request = { ...request, input: { ...request.input, dir, context: { ...context, ...request.input.context as object, projectDir: dir } } };
      workspaces.setAgent(dir, true);
      try { return await codex.request(request); }
      catch (error) { workspaces.setAgent(dir, false, error instanceof Error ? error.message : String(error)); throw error; }
    }
    return codex.request(request);
  };
  const workspaceAction = async (input: ToolArgs<"workspace">, signal = new AbortController().signal): Promise<ToolOutput<"workspace">> => {
    const request = toolByName("workspace").input.parse(input);
    if (request.action === "list") return workspaces.list();
    const dir = request.dir ?? request.project;
    if (!dir) throw new Error("Supply the project's directory");
    if (request.action === "open") await workspaces.open(dir, signal);
    if (request.action === "show") await workspaces.show(dir, signal);
    if (request.action === "cancel") {
      await Promise.all([workspaces.cancel(dir), requestCodex({ method: "cancel", input: { dir } }), cancelProjectAgents(dir)]);
    }
    if (request.action === "close") await workspaces.close(dir);
    if (request.action === "send") {
      const response = await requestCodex({ method: "send", input: { dir, text: request.message!, context: {} } });
      if (response.method !== "send") throw new Error("Codex returned an unexpected response");
      return { ...workspaces.list(), ...response.result };
    }
    return workspaces.list();
  };
  mainBridge.handle(MAIN_CHANNELS.CODEX_REQUEST, requestCodex);
  mainBridge.handle(MAIN_CHANNELS.WORKSPACES_LIST, () => workspaces.list());
  mainBridge.handle(MAIN_CHANNELS.WORKSPACES_ACTION, input => workspaceAction(input));
  const dapi = new DapiServer({
    version: app.getVersion(), logs: () => logBuffer, docsDir: docsDir(),
    runAgentTool: codex.runTool,
    window: { visible, show: showMainWindow, hide: hideWindows },
    renderer, workspaces, workspaceAction,
    getWindow: () => legacyAgentWindow && !legacyAgentWindow.isDestroyed() ? legacyAgentWindow
      : mainWindow && !mainWindow.isDestroyed() ? mainWindow : createTrackedWindow(false),
    getDefaultProject: () => legacyAgentProject,
    onOpenProject: (window, show) => { legacyAgentWindow = window; legacyAgentProject = workspaces.directory(window); if (show) { window.show(); window.focus(); } refreshTray(); },
    port: process.env.FRAMEYARD_MCP_PORT === undefined ? undefined : Number(process.env.FRAMEYARD_MCP_PORT),
  });
  app.on("second-instance", (_event, argv) => {
    const url = findProtocolUrl(argv);
    if (url) deliverDeepLink(url);
    if (!isHiddenLaunch(argv)) void showMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
    void showMainWindow();
  });

  mainBridge.handle(MAIN_CHANNELS.APP_OPEN_EXTERNAL, ({ url }) => {
    if (!isExternalWebUrl(url)) throw new Error("Only web links can be opened externally");
    return shell.openExternal(url);
  });
  mainBridge.handle(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, ({ path }) => shell.showItemInFolder(path));
  mainBridge.handle(MAIN_CHANNELS.AUDIO_ANALYZE_LOUDNESS, (input) => analyzeLoudness(input));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_TRANSCRIBE, ({ path }) => transcribeLocal(path));
  mainBridge.handle(MAIN_CHANNELS.CHECKPOINTS_CREATE_RECOVERY, ({ dir, editorRecovery }) => createRecoveryCheckpoint(dir, editorRecovery));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_LIST_STREAMS, (input) => listMediaStreams(input));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({ title: "Find missing media", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  mainBridge.handle(MAIN_CHANNELS.MEDIA_FIND_MISSING, (input) => findMissingMedia(input));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_COLLECT, (input) => collectMediaSources(input));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_PREPARE_ORIGINAL_AUDIO, (input) => prepareOriginalAudio(input));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_OPEN, (input, event) => openOriginalVideo(input, event.sender.id));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_READ, (input, event) => readOriginalVideo(input, event.sender.id));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_CLOSE, (input, event) => closeOriginalVideo(input, event.sender.id));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_PREPARE_PLAYBACK, (input, event) =>
    preparePlaybackCopy(input, (progress) => {
      if (!event.sender.isDestroyed()) mainBridge.emit(BrowserWindow.fromWebContents(event.sender), MAIN_CHANNELS.MEDIA_PLAYBACK_PROGRESS, { ...input, progress });
    }),
  );
  mainBridge.handle(MAIN_CHANNELS.ANALYTICS_TRACK, ({ event, data }) => trackEvent(event, data));
  mainBridge.handle(MAIN_CHANNELS.AUTH_GET_PENDING_CALLBACK, () =>
    takePendingDeepLink(MAIN_CHANNELS.AUTH_CALLBACK),
  );
  mainBridge.handle(MAIN_CHANNELS.CHECKOUT_GET_PENDING_CALLBACK, () =>
    takePendingDeepLink(MAIN_CHANNELS.CHECKOUT_CALLBACK),
  );
  mainBridge.handle(MAIN_CHANNELS.WINDOW_IS_FULLSCREEN, (_input, event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  mainBridge.handle(MAIN_CHANNELS.WINDOW_SET_COLOR_MODE, ({ mode }, event) => {
    if (process.platform !== "win32") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.setTitleBarOverlay({ ...WINDOWS_OVERLAY_COLORS[mode], height: WINDOWS_OVERLAY_HEIGHT });
  });
  mainBridge.handle(MAIN_CHANNELS.WINDOW_SET_BUSY, ({ busy }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (busy) busyWindows.add(window);
    else busyWindows.delete(window);
    workspaces.setBusy(window, busy);
    scheduleMainIdle();
    refreshTray();
  });
  mainBridge.handle(MAIN_CHANNELS.WINDOW_CAPTURE, async (_input, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) throw new Error("No editor window");
    const image = await window.webContents.capturePage(undefined, { stayHidden: true });
    const { width, height } = image.getSize();
    const png = image.toPNG();
    // A plain Uint8Array over the PNG, so the renderer sees bytes and not a Buffer.
    return { png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), width, height };
  });
  mainBridge.handle(MAIN_CHANNELS.LOGS_GET, () => logBuffer);
  mainBridge.handle(MAIN_CHANNELS.AGENT_CHAT_ENDPOINT, () => agentChatEndpoint());
  mainBridge.handle(MAIN_CHANNELS.MCP_STATUS, () => mcpStatus());
  mainBridge.handle(MAIN_CHANNELS.MCP_APPLY, (request) => applyMcp(request));
  mainBridge.handle(MAIN_CHANNELS.CLI_STATUS, () => cliStatus());
  mainBridge.handle(MAIN_CHANNELS.CLI_INSTALL, () => installCli());
  mainBridge.handle(MAIN_CHANNELS.CLI_UNINSTALL, () => uninstallCli());
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_ROOT, (_input, event) => pickRoot(BrowserWindow.fromWebContents(event.sender)));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, (_input, event) => pickFolder(BrowserWindow.fromWebContents(event.sender)));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, () => defaultRoot(mainWindow));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_SCAN, ({ root }) => scanProjects(root));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_GET, ({ dir }) => getProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_INIT, ({ dir }, event) => initProject(BrowserWindow.fromWebContents(event.sender), dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RESOLVE, ({ dir }) => resolveProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CREATE, ({ root, displayName }) =>
    createProject(root, displayName),
  );
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RENAME, ({ dir, displayName }, event) =>
    workspaces.rename(dir, BrowserWindow.fromWebContents(event.sender), path =>
      codex.withProjectIdle(path, async dir => {
        const result = await renameProject(dir, displayName);
        if (legacyAgentProject === dir) legacyAgentProject = result.dir;
        return result;
      })));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DUPLICATE, ({ dir }) => duplicateProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DELETE, async ({ dir }, event) => {
    const id = await workspaces.delete(dir, BrowserWindow.fromWebContents(event.sender), path =>
      codex.withProjectIdle(path, async dir => {
        const id = await deleteProject(dir);
        if (legacyAgentProject === dir) { legacyAgentProject = undefined; legacyAgentWindow = null; }
        return id;
      }));
    await deleteProjectChats(id);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_COMPILE, ({ dir }) => compileProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WRITE, ({ dir, edits }) => writeProject(dir, edits));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WATCH, async ({ dir }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("No editor window");
    await workspaces.adopt(window, dir);
    if (window === mainWindow) { legacyAgentProject = await realpath(dir); legacyAgentWindow = window; }
    watchProject(window, dir);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_UNWATCH, ({ dir }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("No editor window");
    return workspaces.detach(window, dir);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_READ, ({ dir }) => readManifest(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE, ({ dir, manifest }) => writeManifest(dir, manifest));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_READ, ({ dir }) => readConfig(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_WRITE, ({ dir, config }) => writeConfig(dir, config));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_LIST, ({ dir, source }) => listEntries(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_STAT, ({ dir, source }) => statEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REMOVE, ({ dir, path }) => removeEntry(dir, path));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, ({ dir, source }) => realPathEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.FILE_TRANSFER, ({ selector, absolutePath }, event) =>
    setFileInputFiles(BrowserWindow.fromWebContents(event.sender), selector, absolutePath),
  );

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_OPEN, async ({ path, exclusive }, event) => {
    if (!isAbsolute(path)) throw new Error(`The output path must be absolute (got "${path}").`);
    // Bytes stay in a temp file until publishing. An exclusive write fails if
    // another process claims the output name while encoding.
    const entry = await openFileWrite(path, exclusive === true);
    const id = randomUUID();
    openWrites.set(id, { entry, owner: event.sender.id });
    return { id };
  });

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CHUNK, async ({ id, data, position }, event) => {
    const entry = ownedWrite(id, event.sender.id);
    if (!entry) throw new Error(`No open file for write id ${id}`);
    await entry.handle.write(data, 0, data.byteLength, position);
  });

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CLOSE, async ({ id }, event) => {
    const entry = ownedWrite(id, event.sender.id);
    if (!entry) return;
    openWrites.delete(id);
    await closeFileWrite(entry, noteRenamed);
  });

  // Abort drops only the temp file. A destination created during encoding
  // belongs to the other writer and is left alone.
  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_ABORT, async ({ id }, event) => {
    const entry = ownedWrite(id, event.sender.id);
    if (!entry) return;
    openWrites.delete(id);
    await abortFileWrite(entry);
  });

  app.whenReady().then(() => {
    if (!app.isPackaged && process.platform === "darwin") {
      const devIcon = nativeImage.createFromPath(join(app.getAppPath(), "assets", "frameyard.png"));
      if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
    }

    setupAppMenu();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const trusted = [...editorWindows].some(window => contents === window.webContents) && details.isMainFrame && isEditorUrl(details.requestingUrl, editorUrl());
      const types = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(trusted && (permission !== "media" || allowsMediaRequest(types)));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
      const trusted = !!contents && [...editorWindows].some(window => contents === window.webContents) && details.isMainFrame &&
        isEditorUrl(details.requestingUrl ?? contents.getURL(), editorUrl());
      return trusted && (permission !== "media" || allowsMediaCheck(details.mediaType));
    });
    session.defaultSession.setDevicePermissionHandler(() => false);

    const url = findProtocolUrl(process.argv);
    if (url) deliverDeepLink(url);

    dapi.start();
    // Chat starts its host only when a user opens it.
    dapi.mcpUrl().then((url) =>
      configureAgentChat({
        dataDir: join(app.getPath("userData"), "agent-chat"),
        mcpUrl: url,
        version: app.getVersion(),
        prepareTurn: codex.prepareTurn,
      }),
    );
    healMcpRegistrations();
    trackInstall();
    tray?.start();
    if (isHiddenLaunch(process.argv)) void app.dock?.hide();
    else void showMainWindow();
  });

  let shutdown: "running" | "stopping" | "ready" = "running";
  app.on("before-quit", (event) => {
    if (shutdown === "ready") return;
    event.preventDefault();
    if (shutdown === "stopping") return;
    shutdown = "stopping";
    workspaces.dispose();
    if (mainIdleTimer) clearTimeout(mainIdleTimer);
    codex.dispose();
    unwatchAll();
    stopAgentChat();
    dapi.stop();
    tray?.destroy();
    void Promise.allSettled([shutdownAnimations(), disposeOriginalVideos()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("[shutdown] Cleanup failed:", result.reason);
      }
      shutdown = "ready";
      quitting = true;
      app.quit();
    });
  });

  app.on("window-all-closed", () => {});

  app.on("activate", () => { void showMainWindow(); });
} else {
  app.quit();
}
