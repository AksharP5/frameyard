import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { DAPI_WIRE } from "@diffusionstudio/dapi";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), ipcMain: new EventEmitter(), BrowserWindow: { getAllWindows: () => [] } };
});

import { app, ipcMain } from "electron";
import { RendererCalls } from "./renderer-calls";

function windowFor(loading = false) {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      isCrashed: () => false,
      isLoadingMainFrame: () => loading,
      send: vi.fn(),
    }),
  });
}

beforeEach(() => { app.removeAllListeners(); ipcMain.removeAllListeners(); });

function setup(loading = false) {
  const calls = new RendererCalls();
  calls.start();
  const window = windowFor(loading);
  app.emit("browser-window-created", {}, window);
  return { calls, window };
}

it("keeps project navigation and subframe loads alive, but rejects an actual reload", async () => {
  const { calls, window } = setup();
  const pending = calls.call("open", {}, new AbortController().signal);
  await Promise.resolve();
  const [, request] = window.webContents.send.mock.calls[0]!;
  window.webContents.emit("did-start-loading");
  window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  ipcMain.emit(DAPI_WIRE.REPLY, { sender: window.webContents }, { id: request.id, ok: true, data: "opened" });
  await expect(pending).resolves.toBe("opened");

  const reload = calls.call("context", {}, new AbortController().signal);
  await Promise.resolve();
  window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await expect(reload).rejects.toThrow("reloaded");
});

it("never sends a request canceled before or during startup", async () => {
  const { calls, window } = setup(true);
  const controller = new AbortController();
  const pending = calls.call("open", {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "canceled" });
  window.webContents.emit("did-finish-load");
  await expect(calls.call("open", {}, controller.signal)).rejects.toMatchObject({ code: "canceled" });
  expect(window.webContents.send).not.toHaveBeenCalled();
  expect(window.webContents.listenerCount("did-finish-load")).toBe(0);
});

it.each(["closed", "render-process-gone"])("fails promptly when the loading window emits %s", async (event) => {
  const { calls, window } = setup(true);
  const pending = calls.call("context", {}, new AbortController().signal);
  (event === "closed" ? window : window.webContents).emit(event);
  await expect(pending).rejects.toThrow(event === "closed" ? "closed" : "crashed");
  expect(window.webContents.listenerCount("did-finish-load")).toBe(0);
  expect(window.webContents.send).not.toHaveBeenCalled();
});

it("ignores subframe load failures and preserves the main-frame load error", async () => {
  const { calls, window } = setup(true);
  const pending = calls.call("context", {}, new AbortController().signal);
  window.webContents.emit("did-fail-load", {}, -1, "child failed", "", false);
  expect(window.webContents.listenerCount("did-finish-load")).toBe(1);
  window.webContents.emit("did-fail-load", {}, -1, "ERR_CONNECTION_REFUSED", "", true);
  await expect(pending).rejects.toThrow("ERR_CONNECTION_REFUSED");
});

it("ties replies and lifecycle failures to the window answering the call", async () => {
  const { calls, window } = setup();
  const other = windowFor();
  app.emit("browser-window-created", {}, other);
  const pending = calls.call("context", {}, new AbortController().signal);
  await Promise.resolve();
  const [, request] = other.webContents.send.mock.calls[0]!;
  ipcMain.emit(DAPI_WIRE.REPLY, { sender: window.webContents }, { id: request.id, ok: true, data: "wrong" });
  window.emit("closed");
  ipcMain.emit(DAPI_WIRE.REPLY, { sender: other.webContents }, { id: request.id, ok: true, data: "right" });
  await expect(pending).resolves.toBe("right");
});

it("forwards cancellation for a dispatched call and ignores late replies", async () => {
  const { calls, window } = setup();
  const controller = new AbortController();
  const pending = calls.call("export", {}, controller.signal);
  await Promise.resolve();
  const [, request] = window.webContents.send.mock.calls[0]!;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "canceled" });
  expect(window.webContents.send).toHaveBeenLastCalledWith(DAPI_WIRE.CANCEL, { id: request.id });
  ipcMain.emit(DAPI_WIRE.REPLY, { sender: window.webContents }, { id: request.id, ok: true, data: "late" });
});
