/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function launchApp(background: boolean): Promise<boolean> {
  const env = { ...process.env };
  // The packaged dapi wrapper uses Electron as Node; the editor must launch as
  // Electron again. Leaving this flag set silently starts the wrong process.
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "darwin") {
    const args = background ? ["-g", "-a", "Frameyard", "--args", "--hidden"] : ["-a", "Frameyard"];
    return new Promise((resolve) => execFile("open", args, { env }, (error) => resolve(!error)));
  }
  if (process.platform !== "linux") return Promise.resolve(false);

  const local = join(homedir(), ".local", "bin", "frameyard");
  const executable = process.env.DIFFUSION_APP_EXECUTABLE ?? (existsSync(local) ? local : "frameyard");
  return new Promise((resolve) => {
    const child = spawn(executable, background ? ["--hidden"] : [], { detached: true, stdio: "ignore", env });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
