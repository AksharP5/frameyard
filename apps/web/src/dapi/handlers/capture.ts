/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createImageEncoder, decodePng } from "@diffusionstudio/encoder";
import { DapiError } from "@diffusionstudio/dapi";
import { FrameRate, Hidden, Workarea } from "@diffusionstudio/runtime";
import { createCapture } from "@/engine/capture";
import { resolveNode } from "../lib/nodes";
import { requireScene } from "../lib/scene";
import { SheetCollector } from "../lib/sheets";

import type { ToolHandler } from "../handler";
import type { EditorSession } from "../session";

// Ceiling on the height a sheet cell renders a node at.
const SHEET_CAPTURE_HEIGHT = 1080;

export const capture: ToolHandler<"capture"> = async ({ id, sceneTime, times, separate, perSheet }, ctx) => {
  ctx.signal.throwIfAborted();
  const { world, project } = ctx.requireSession();
  const scene = requireScene(world, id, "capture");

  // The project re-rendered into a world of its own, reduced to this scene:
  // the same arrangement an export runs against, and the encoder's to draw.
  const target = await createCapture(world, scene, { dir: project.dir() });
  let cancel: (() => void) | undefined;
  try {
    ctx.signal.throwIfAborted();
    // Positions arrive in seconds; frame indices use the capture world's rate.
    // None given means the export's first frame (the workarea's start).
    const frameRate = target.world.get(FrameRate)?.value ?? 30;
    const shots = times && times.length > 0 ? times.map((t) => Math.round(t * frameRate)) : [0];
    if (sceneTime) target.node.remove(Workarea);
    const encoder = await createImageEncoder(target.world, { frames: shots, resolution: 720 });
    cancel = encoder.cancel;
    ctx.signal.addEventListener("abort", cancel, { once: true });
    ctx.signal.throwIfAborted();

    // Sheets render at their cell size instead of the flat 720p: with a few
    // frames that is sharper than a standalone capture, never coarser. A
    // scene is drawn, not decoded, so a small one is worth rendering past
    // its own size; beyond SHEET_CAPTURE_HEIGHT that only costs tokens.
    let sheets: SheetCollector | undefined;
    if (!separate) {
      const aspect = encoder.bounds.width / encoder.bounds.height;
      const height = Math.max(encoder.bounds.height, SHEET_CAPTURE_HEIGHT);
      sheets = new SheetCollector(shots.length, { width: height * aspect, height }, perSheet);
      encoder.resize(sheets.cellHeight);
    }

    const result = await encoder.render();
    ctx.signal.throwIfAborted();
    if (result.type === "canceled") throw new DapiError("canceled", "Capture canceled");
    if (result.type === "error") throw result.error;
    if (!sheets) return result.data;

    for (const [index, { timecode, png }] of result.data.entries()) {
      ctx.signal.throwIfAborted();
      await sheets.add(index, { at: shots[index]!, timecode, image: await decodePng(png) });
    }
    ctx.signal.throwIfAborted();
    return sheets.result();
  } finally {
    if (cancel) ctx.signal.removeEventListener("abort", cancel);
    target.dispose();
  }
};

/** Scene-clock capture used by the fork's native chat attachments. */
export async function captureSceneFrames(
  session: EditorSession,
  id: string,
  frames: number[],
  options: { sceneTime?: boolean; exclude?: string[] } = {},
): Promise<Array<{ timecode: string; base64: string }>> {
  const scene = requireScene(session.world, id, "capture");
  const target = await createCapture(session.world, scene, { dir: session.project.dir() });
  try {
    for (const source of options.exclude ?? []) resolveNode(target.world, source).add(Hidden);
    if (options.sceneTime) target.node.remove(Workarea);
    const encoder = await createImageEncoder(target.world, { frames, resolution: 720 });
    const result = await encoder.render();
    if (result.type === "canceled") throw new DapiError("canceled", "Capture canceled");
    if (result.type === "error") throw result.error;
    return result.data.map(({ timecode, png }) => ({ timecode, base64: bytesToBase64(png) }));
  } finally {
    target.dispose();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
