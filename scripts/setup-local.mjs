import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tools = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'diffusion-studio/tools');

execFileSync('bash', [join(root, 'scripts/local-media/setup.sh')], { stdio: 'inherit' });
execFileSync('npm', ['install', '--prefix', tools, 'hyperframes@0.8.59', 'hyfrme@0.4.0', '--save-exact', '--no-audit', '--no-fund'], { stdio: 'inherit' });
console.log(`Local render tools installed in ${tools}`);
