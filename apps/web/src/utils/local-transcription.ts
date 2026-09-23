/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { createProjectFS } from "@/projects/fs";

/** Uses the native file when available; generated mixes stream to a temporary project file. */
export async function transcribeFile(file: File, dir?: string) {
  const path = window.desktop?.getPathForFile(file);
  if (path) return mainBridge.call(MAIN_CHANNELS.MEDIA_TRANSCRIBE, { path });

  const root = dir ?? await mainBridge.call(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, undefined);
  if (!root) throw new Error("Choose a project folder before transcribing generated audio.");
  const fs = createProjectFS(root);
  const temporary = `.diffusion/transcription/${crypto.randomUUID()}.ogg`;
  try {
    await fs.write(temporary, file);
    return await mainBridge.call(MAIN_CHANNELS.MEDIA_TRANSCRIBE, { path: `${root}/${temporary}` });
  } finally {
    await fs.remove(temporary);
  }
}
