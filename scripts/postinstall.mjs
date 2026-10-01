import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const patchPackage = join(root, 'node_modules', 'patch-package', 'index.js');

function applyPatches(...args) {
  const result = spawnSync(process.execPath, [patchPackage, '--error-on-fail', ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

applyPatches();
if (existsSync(join(root, 'node_modules', 'appdmg', 'package.json'))) {
  applyPatches('--patch-dir', 'patches-macos');
}
