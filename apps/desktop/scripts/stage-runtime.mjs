/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stages the main process's external dependencies into apps/desktop/runtime
// so electron-forge can ship them as an app resource (Contents/Resources/
// runtime). A packaged app has no node_modules of its own: everything else
// is bundled into dist/main.js, but esbuild (native binary) and the babel
// toolchain stay external and are loaded from here at run time (see `load`
// in src/projects.ts). The staged layout:
//   runtime/package.json   the externals, pinned to the workspace's versions
//   runtime/node_modules   a lockfile-reproducible install of them
//
// The list of externals is read from the build:main script so that it cannot
// drift from what the bundle actually leaves unresolved.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(desktopDir, "runtime");
const manifestDir = join(desktopDir, "runtime-deps");
const require = createRequire(join(desktopDir, "package.json"));

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const externals = [...pkg.scripts["build:main"].matchAll(/--external:(\S+)/g)]
  .map((match) => match[1])
  // Electron is provided by the host binary, not installed.
  .filter((name) => name !== "electron");

const manifest = JSON.parse(readFileSync(join(manifestDir, "package.json"), "utf8"));
if (externals.sort().join(",") !== Object.keys(manifest.dependencies).sort().join(",")) {
  throw new Error("Desktop runtime dependencies must match the build:main externals");
}
for (const name of externals) {
  if (require(`${name}/package.json`).version !== manifest.dependencies[name]) {
    throw new Error(`${name} does not match runtime-deps/package.json; update the runtime lockfile or run npm ci`);
  }
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(join(manifestDir, "package.json"), join(stageDir, "package.json"));
cpSync(join(manifestDir, "package-lock.json"), join(stageDir, "package-lock.json"));

execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: stageDir,
  stdio: "inherit",
});

// Mach-O files inside Resources are not reached by the app-bundle signing
// pass, and notarization rejects unsigned executables; sign them here.
// esbuild's postinstall hard-links the native binary over its bin/esbuild
// shim, so the same executable can sit in two places.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);
function isMachO(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && MACHO_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

const esbuildDir = join(stageDir, "node_modules", "@esbuild");
const binaries = [
  join(stageDir, "node_modules", "esbuild", "bin", "esbuild"),
  ...(existsSync(esbuildDir) ? readdirSync(esbuildDir).map((name) => join(esbuildDir, name, "bin", "esbuild")) : []),
].filter((path) => existsSync(path) && isMachO(path));

if (process.platform === "darwin" && !process.env.SKIP_SIGN) {
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const identity = identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (identity) {
    for (const bin of binaries) {
      execFileSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, bin], {
        stdio: "inherit",
      });
    }
  } else {
    console.warn("stage-runtime: no Developer ID identity found, leaving esbuild binaries unsigned");
  }
}

console.log(`stage-runtime: staged ${externals.join(", ")} at ${stageDir}`);
