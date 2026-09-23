import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { ProjectContextValue } from '../../web/src/context/project.tsx';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/context/project.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view',
  plugins: [{ name: 'project-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true }); } }],
});
function fixture() {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  let project: ProjectContextValue | undefined;
  const world = { get: (trait: string) => ({ settle: async () => { events.push(trait); } }) };
  const session = { world, project: { dir: () => '/before' } };
  const deps: Record<string, unknown> = {
    'solid-js': { createContext: () => ({ Provider: 'provider' }), createMemo: (fn: () => unknown) => fn, createSignal: (initial: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = next; }]; } },
    '@/projects': { renameProject: async () => { events.push('rename'); return { id: 'id', dir: '/after', displayName: 'After' }; } },
    '@/projects/edits': { flushProjectEdits: async () => { events.push('edits'); await gate.promise; } },
    '@/dapi/session': { editorSession: () => session },
    '@diffusionstudio/runtime': { Library: 'library' },
    '@/engine/traits': { ProjectConfig: 'config' },
  };
  const module = { exports: {} as typeof import('../../web/src/context/project.tsx') };
  runInThisContext(`(function(require,module,exports,view){${built.outputFiles[0].text}\n})`)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports, (_tag: unknown, props: { value: ProjectContextValue }) => { project = props.value; });
  module.exports.ProjectProvider({ project: { id: 'id', dir: '/before', displayName: 'Before', name: 'before', entry: 'index.tsx', createdAt: '', modifiedAt: '' }, children: undefined });
  assert.ok(project);
  return { project, gate, events };
}

test('renaming waits for pending source, asset and settings saves before moving the folder', async () => {
  const f = fixture();
  const renamed = f.project.rename('After');
  await setImmediate();
  assert.deepEqual(f.events, ['edits']);
  await assert.rejects(f.project.rename('Another name'), /already in progress/);
  f.gate.resolve();
  await renamed;
  assert.equal(f.events.at(-1), 'rename');
  assert.ok(f.events.includes('library'));
  assert.ok(f.events.includes('config'));
  assert.equal(f.project.dir(), '/after');
});

test('a failed source save keeps the project at its existing folder', async () => {
  const f = fixture();
  const renamed = f.project.rename('After');
  f.gate.reject(new Error('Disk full'));
  await assert.rejects(renamed, /Disk full/);
  assert.deepEqual(f.events, ['edits']);
  assert.equal(f.project.dir(), '/before');
});
