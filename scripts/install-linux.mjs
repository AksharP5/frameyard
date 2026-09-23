import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('This installer targets Linux.');

const root = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
const install = join(data, 'diffusion-studio');
const bin = join(homedir(), '.local/bin');
const built = join(root, 'apps/desktop/out', `Frameyard-linux-${process.arch}`);

function checkLink(path, allowedRoot) {
  try {
    const previous = lstatSync(path);
    if (!previous.isSymbolicLink()) throw new Error(`Refusing to replace ${path}: it is not a symlink.`);
    const previousTarget = resolve(dirname(path), readlinkSync(path));
    if (previousTarget !== allowedRoot && !previousTarget.startsWith(`${allowedRoot}/`)) {
      throw new Error(`Refusing to replace unrelated link ${path} -> ${previousTarget}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.new-${process.pid}`;
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}

const links = [
  [join(install, 'current/frameyard'), join(bin, 'frameyard')],
  [join(install, 'current/frameyard'), join(bin, 'diffusion-studio')],
  [join(install, 'current/resources/cli/bin/dapi'), join(bin, 'dapi')],
];
for (const directory of ['.codex/skills', '.agents/skills', '.claude/skills']) {
  const parent = join(homedir(), directory);
  if (!existsSync(parent)) continue;
  links.push([join(install, 'current/resources/skills/frameyard'), join(parent, 'frameyard')]);
  const legacy = join(parent, 'diffusion-studio');
  if (lstatSync(legacy, { throwIfNoEntry: false })) links.push([join(install, 'current/resources/skills/frameyard'), legacy]);
}
for (const [, path] of links) checkLink(path, install);
checkLink(join(install, 'current'), join(install, 'releases'));

const desktopEntry = join(data, 'applications/frameyard.desktop');
const legacyDesktopEntry = join(data, 'applications/diffusion-studio.desktop');
const previousEntries = [];
for (const path of [desktopEntry, legacyDesktopEntry]) {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error(`Refusing to replace non-file ${path}`);
    const text = readFileSync(path, 'utf8');
    if (!text.includes('X-Frameyard-Managed=true') && !text.includes('X-Diffusion-Studio-Managed=true')) {
      throw new Error(`Refusing to replace unmanaged ${path}`);
    }
    previousEntries.push({ path, text });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Build before touching an existing installation. Each installation is retained
// so switching the current symlink back restores the previous working version.
execFileSync('npm', ['run', 'package', '--workspace=@diffusionstudio/desktop'], { cwd: root, stdio: 'inherit' });
if (!existsSync(join(built, 'frameyard'))) throw new Error(`Missing packaged executable in ${built}`);
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const release = join(install, 'releases', `${revision}-${Date.now()}`);
mkdirSync(dirname(release), { recursive: true });
cpSync(built, release, { recursive: true });

const quote = (value) => `"${value.replace(/[\\"`$]/g, '\\$&')}"`;
mkdirSync(dirname(desktopEntry), { recursive: true });
for (const [index, entry] of previousEntries.entries()) {
  writeFileSync(join(release, `previous-desktop-entry-${index}.desktop`), entry.text);
}
const desktopTemporary = `${desktopEntry}.new-${process.pid}`;
writeFileSync(desktopTemporary, `[Desktop Entry]\nType=Application\nName=Frameyard\nComment=Local video and motion editing with agents\nExec=${quote(join(bin, 'frameyard'))} %U\nIcon=${join(install, 'current/resources/app/web/frameyard.svg')}\nTerminal=false\nCategories=AudioVideo;Video;\nStartupWMClass=frameyard\nMimeType=x-scheme-handler/diffusion;\nX-Frameyard-Managed=true\n`, { flag: 'wx' });
renameSync(desktopTemporary, desktopEntry);

for (const [target, path] of links) link(target, path);
link(release, join(install, 'current'));
if (previousEntries.some(({ path }) => path === legacyDesktopEntry)) unlinkSync(legacyDesktopEntry);

console.log(JSON.stringify({ executable: join(bin, 'frameyard'), cli: join(bin, 'dapi'), release, desktopEntry }));
