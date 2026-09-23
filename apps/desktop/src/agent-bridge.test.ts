import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { MAIN_CHANNELS, MAIN_WIRE } from "./main-channels";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter(), dialog: {} };
});
vi.mock("./codex", () => ({ CodexService: class {
  async withProjectMutation<T>(dir: string, operation: (dir: string) => Promise<T>) { return operation(dir); }
  dispose() {}
} }));
vi.mock("./projects", () => ({ unwatchProject() {}, watchProject() {} }));
vi.mock("./checkpoints", () => ({ createCheckpoint() {}, listCheckpoints() {}, restoreCheckpoint() {} }));
vi.mock("./agent-assets", () => ({ importAsset() {}, importGeneratedAsset() {}, searchAssets() {} }));
vi.mock("./hyperframes-catalog", () => ({ handleCatalogRequest() {} }));
vi.mock("./manim", () => ({ handleManimRequest() {} }));
vi.mock("./animations", () => ({ handleAnimationRequest() {} }));

import { ipcMain } from "electron";
import { registerAgentBridge } from "./agent-bridge";
import { mainBridge } from "./main-manager";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoading: () => true,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
    }),
  });
  mainBridge.authorizeSender((event) => event.sender === (window.webContents as unknown as WebContents));
  const bridge = registerAgentBridge("/unused", () => window as unknown as BrowserWindow);
  return { window, bridge };
}

it("delivers tools through the real IPC sender while a child frame loads", async () => {
  const { window, bridge } = setup();
  const pending = bridge.runTool("/project", "editor_context", {});
  const [wire, envelope] = window.webContents.send.mock.calls[0]!;
  expect(wire).toBe(MAIN_WIRE.EVENT);
  expect(envelope.channel).toBe(MAIN_CHANNELS.EDITOR_TOOL);
  window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  const result = { success: true, contentItems: [{ type: "inputText", text: "ready" }] };
  ipcMain.emit(MAIN_WIRE.REQUEST, { sender: window.webContents }, {
    id: "reply", channel: MAIN_CHANNELS.EDITOR_TOOL_RESULT, data: { id: envelope.data.id, result },
  });
  await expect(pending).resolves.toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
  expect(window.listenerCount("closed")).toBe(0);
  expect(window.webContents.listenerCount("did-start-navigation")).toBe(0);
  bridge.dispose();
});

it.each(["reload", "crash", "close", "dispose", "send failure"])("fails promptly and cleans pending tools on %s", async (failure) => {
  const { window, bridge } = setup();
  if (failure === "send failure") window.webContents.send.mockImplementation(() => { throw new Error("IPC unavailable"); });
  const pending = bridge.runTool("/project", "editor_context", {});
  if (failure === "reload") window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  if (failure === "crash") window.webContents.emit("render-process-gone");
  if (failure === "close") window.emit("closed");
  if (failure === "dispose") bridge.dispose();
  await expect(pending).resolves.toMatchObject({ success: false, contentItems: [{ type: "inputText", text: expect.any(String) }] });
  expect(vi.getTimerCount()).toBe(0);
  expect(window.listenerCount("closed")).toBe(0);
  expect(window.webContents.eventNames()).toEqual([]);
  bridge.dispose();
});
