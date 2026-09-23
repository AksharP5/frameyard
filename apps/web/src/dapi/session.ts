/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The tool handlers register once for the app's lifetime (see ./api); what
// changes as projects open and close is this slot. The editor publishes its
// world and project here while it is mounted, and project-bound handlers read
// the slot per request instead of closing over a world at registration time.

import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { DapiError } from "@diffusionstudio/dapi";

import type { Accessor } from "solid-js";
import type { World } from "koota";
import type { Engine } from "@/engine";

/**
 * The open project, as the editor knows it. Structural on purpose: this is
 * the slice of the project context the handlers read, without depending on
 * the Solid context it comes from.
 */
export type OpenProject = {
  dir: () => string;
};

/** What only an open project can offer: the world drawing it, the engine running it, and which project that is. */
export type EditorSession = { world: World; project: OpenProject; engine: Engine };

const [session, setSession] = createSignal<EditorSession | null>(null);

type EditorLoadState = { world: World } & (
  | { status: "loading" }
  | { status: "ready"; mountedFrame: number }
  | { status: "error"; error: string }
);

const [loadState, setLoadState] = createSignal<EditorLoadState | null>(null);

/** Changes whenever external source starts loading, finishes, or fails. */
export const editorLoadState = loadState;

/** The editor publishes completion of its fresh compile, not its cached preview. */
export const setEditorLoadState = setLoadState;

/** The open project's session; null at the dashboard (and between projects). */
export const editorSession: Accessor<EditorSession | null> = session;

/** Set by the editor while a project is open; cleared on its way out. */
export const setEditorSession = setSession;

/** Resolves after the requested project mounts and its engine computes the first frame. */
export function waitForEditorSession(dir: string, signal?: AbortSignal): Promise<EditorSession> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    createRoot((dispose) => {
      // A deadline cleans up the observer if navigation never reaches an editor.
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error(`Project did not become ready within 60 seconds: ${dir}`));
      }, 60_000);
      onCleanup(() => clearTimeout(timeout));
      const onAbort = () => {
        dispose();
        reject(new DapiError("canceled", "The call was canceled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      onCleanup(() => signal?.removeEventListener("abort", onAbort));

      createEffect(() => {
        const current = session();
        const state = loadState();
        if (!current || current.project.dir() !== dir || state?.world !== current.world) return;
        if (state.status === "error") {
          dispose();
          reject(new Error(state.error));
          return;
        }
        if (state.status !== "ready" || current.engine.frame() <= state.mountedFrame) return;
        dispose();
        resolve(current);
      });
    });
  });
}

/** The session, or the failure a caller can act on. */
export function requireEditorSession(): EditorSession {
  const current = session();
  if (!current) throw new DapiError("no-project", "No project open — open one first (`dapi open <dir>`).");
  return current;
}
