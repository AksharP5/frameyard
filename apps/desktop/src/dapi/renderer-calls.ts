/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain } from "electron";
import { DAPI_WIRE, DapiError } from "@diffusionstudio/dapi";

import type { DapiCall, DapiCancel, DapiReply } from "@diffusionstudio/dapi";

type InFlight = {
  window: BrowserWindow;
  resolve(data: unknown): void;
  reject(error: Error): void;
};

/**
 * Runs renderer tools from main: one `dapi:call` per request, answered by
 * `dapi:reply`, or `dapi:cancel` if the caller gives up. Calls wait for the
 * current window to finish loading; a window that reloads or dies fails the
 * calls it was answering.
 */
export class RendererCalls {
  private readonly inFlight = new Map<string, InFlight>();
  private window: BrowserWindow | null = null;

  start(): void {
    ipcMain.on(DAPI_WIRE.REPLY, (event, reply: DapiReply) => {
      const call = this.inFlight.get(reply.id);
      if (!call || event.sender !== call.window.webContents) return;
      if (reply.ok) call.resolve(reply.data);
      else call.reject(reply.error.code ? new DapiError(reply.error.code, reply.error.message) : new Error(reply.error.message));
    });

    app.on("browser-window-created", (_event, window) => this.track(window));
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) this.track(windows[windows.length - 1]!);
  }

  async call(tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const window = await this.ready(signal);
    if (signal.aborted) throw new DapiError("canceled", "The call was canceled.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.inFlight.get(id)?.reject(new DapiError("canceled", "The call was canceled."));
        if (!window.isDestroyed()) window.webContents.send(DAPI_WIRE.CANCEL, { id } satisfies DapiCancel);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.inFlight.set(id, {
        window,
        resolve: (data) => {
          this.inFlight.delete(id);
          signal.removeEventListener("abort", onAbort);
          resolve(data);
        },
        reject: (error) => {
          this.inFlight.delete(id);
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        window.webContents.send(DAPI_WIRE.CALL, { id, tool, args } satisfies DapiCall);
      } catch (error) {
        this.inFlight.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private track(window: BrowserWindow): void {
    this.window = window;
    const fail = (why: string) => () => this.failWindow(window, why);
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.failWindow(window, "The app reloaded before replying");
    });
    window.webContents.on("render-process-gone", fail("The app's renderer crashed"));
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.failWindow(window, "The app window closed before replying");
    });
  }

  private failWindow(window: BrowserWindow, message: string): void {
    for (const call of this.inFlight.values()) {
      if (call.window === window) call.reject(new Error(message));
    }
  }

  // Resolves with the current window once it has finished loading.
  private ready(signal: AbortSignal, timeoutMs = 30000): Promise<BrowserWindow> {
    if (signal.aborted) return Promise.reject(new DapiError("canceled", "The call was canceled."));
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.reject(new Error("The app has no window"));
    if (window.webContents.isCrashed()) return Promise.reject(new Error("The app's renderer crashed"));
    if (!window.webContents.isLoadingMainFrame()) return Promise.resolve(window);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The app did not become ready in time"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        window.webContents.off("did-finish-load", onLoad);
        window.webContents.off("did-fail-load", onFail);
        window.webContents.off("render-process-gone", onGone);
        window.off("closed", onClosed);
        signal.removeEventListener("abort", onAbort);
      };
      const onLoad = () => {
        cleanup();
        resolve(window);
      };
      const onFail = (_event: unknown, _code: number, description: string, _url: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        cleanup();
        reject(new Error(`The app failed to load: ${description}`));
      };
      const onGone = () => { cleanup(); reject(new Error("The app's renderer crashed")); };
      const onClosed = () => { cleanup(); reject(new Error("The app window closed before becoming ready")); };
      const onAbort = () => { cleanup(); reject(new DapiError("canceled", "The call was canceled.")); };
      window.webContents.on("did-finish-load", onLoad);
      window.webContents.on("did-fail-load", onFail);
      window.webContents.on("render-process-gone", onGone);
      window.on("closed", onClosed);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
