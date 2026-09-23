/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `dapi` command on PATH: a symlink to the wrapper the app ships in its
// resources. macOS installs into /usr/local/bin with an admin prompt; Linux
// installs into the user's ~/.local/bin without elevation.

import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { CliInstallResult, CliStatus, CliUninstallResult } from "./main-channels";

export const CLI_LINK_PATH =
  process.platform === "linux" ? join(homedir(), ".local", "bin", "dapi") : "/usr/local/bin/dapi";

const DEV_LINK_PATH = "/opt/homebrew/bin/dapi";

function candidatePaths(): string[] {
  return process.platform === "darwin" ? [CLI_LINK_PATH, DEV_LINK_PATH] : [CLI_LINK_PATH];
}
/**
 * Whether `path` is a symlink, including a dangling one left by an old
 * bundle. `existsSync` follows links and would miss that case.
 */
function isLink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function installedPath(): string | null {
  for (const path of candidatePaths()) {
    if (isLink(path) || existsSync(path)) return path;
  }
  return null;
}

export function cliStatus(): CliStatus {
  const path = installedPath();
  if (path) return { installed: true, path, managed: isLink(path), available: true };
  const available = app.isPackaged && (process.platform === "darwin" || process.platform === "linux");
  return { installed: false, path: null, managed: false, available };
}

function elevated(shell: string): Promise<void> {
  const script = `do shell script "${shell.replaceAll('"', '\\"')}" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error) => (error ? reject(error) : resolve()));
  });
}

const cancelled = (error: unknown): boolean => ((error as Error).message ?? "").includes("-128");

async function installLinux(wrapper: string): Promise<void> {
  await mkdir(dirname(CLI_LINK_PATH), { recursive: true });
  const current = await lstat(CLI_LINK_PATH).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (current) {
    if (
      current.isSymbolicLink() &&
      resolve(dirname(CLI_LINK_PATH), await readlink(CLI_LINK_PATH)) === wrapper
    ) {
      return;
    }
    throw new Error(
      `Cannot replace ${CLI_LINK_PATH}: another file or link already exists. Move it before installing dapi.`,
    );
  }
  await symlink(wrapper, CLI_LINK_PATH);
}

export async function installCli(): Promise<CliInstallResult> {
  if (!app.isPackaged) {
    return {
      status: "error",
      error: "Installing the CLI is only available in the packaged app. Use `npm run symlink:create` in development.",
    };
  }
  const wrapper = join(process.resourcesPath, "cli", "bin", "dapi");
  try {
    if (process.platform === "linux") {
      await installLinux(wrapper);
    } else if (process.platform === "darwin") {
      await elevated(`mkdir -p /usr/local/bin && ln -sf '${wrapper}' '${CLI_LINK_PATH}'`);
    } else {
      throw new Error("CLI installation is supported on macOS and Linux.");
    }
    return { status: "installed" };
  } catch (error) {
    return cancelled(error)
      ? { status: "cancelled" }
      : { status: "error", error: (error as Error).message };
  }
}

/**
 * Takes the managed `dapi` link off PATH. A real file is left alone. Linux's
 * user link and Homebrew's user-owned bin need no prompt; macOS falls back to
 * the admin prompt when /usr/local/bin refuses the unlink.
 */
export async function uninstallCli(): Promise<CliUninstallResult> {
  const path = installedPath();
  if (!path) return { status: "absent" };
  if (!isLink(path)) {
    return { status: "error", error: `${path} is not a link, so it was left alone.` };
  }
  try {
    unlinkSync(path);
    return { status: "removed" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      return { status: "error", error: (error as Error).message };
    }
  }
  if (process.platform !== "darwin") {
    return { status: "error", error: `Could not remove ${path}.` };
  }
  try {
    await elevated(`rm -f '${path}'`);
    return { status: "removed" };
  } catch (error) {
    return cancelled(error)
      ? { status: "cancelled" }
      : { status: "error", error: (error as Error).message };
  }
}
