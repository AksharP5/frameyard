import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/sidebar-left/project-menu/file-menu.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view', jsxFragment: 'Fragment',
  plugins: [{ name: 'project-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true }); } }],
});

function fixture(deleteError?: Error) {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  let remove: (() => Promise<void>) | undefined;
  const project = { dir: () => '/project', id: () => 'id' };
  const world = { get: (trait: string) => ({ settle: async () => { events.push(trait); } }) };
  const session = { world, project };
  const deps: Record<string, unknown> = {
    '@solidjs/router': { useNavigate: () => () => { events.push('navigate'); }, useLocation: () => ({}) },
    '@/context/project': { useProject: () => project },
    '@/context/layout': { useLayout: () => ({}) },
    '@/engine/library': { useLibrary: () => () => null },
    '@/dapi/session': { editorSession: () => session },
    '@diffusionstudio/runtime': { Library: 'library' },
    '@/engine/traits': { ProjectConfig: 'config' },
    '@/projects/edits': { flushProjectEdits: async () => { events.push('edits'); await gate.promise; } },
    '@/projects': { deleteProject: async (dir: string) => { assert.equal(dir, '/project'); events.push('delete'); if (deleteError) throw deleteError; } },
    '@/lib/db': { forgetProjectBundle: () => { events.push('forget'); } },
    '@/components/ui/dropdown-menu': { DropdownMenuItem: 'item' },
    somoto: { toast: { error: (_title: string, { description }: { description: string }) => { events.push(description); } } },
  };
  const module = { exports: {} as typeof import('../../web/src/components/sidebar-left/project-menu/file-menu.tsx') };
  runInThisContext(`(function(require,module,exports,view,Fragment){${built.outputFiles[0].text}\n})`)(
    (name: string) => deps[name] ?? {}, module, module.exports,
    (tag: unknown, props: { onSelect?: () => Promise<void> } | null, ...children: unknown[]) => {
      if (tag === 'item' && children.includes('Delete project')) remove = props?.onSelect;
    }, null,
  );
  module.exports.FileMenu();
  assert.ok(remove);
  return { remove, gate, events };
}

test('deleting from the editor saves source, assets and settings before moving its folder', async () => {
  const f = fixture();
  const deleting = f.remove();
  await setImmediate();
  assert.deepEqual(f.events, ['edits']);
  f.gate.resolve();
  await deleting;
  assert.deepEqual(f.events, ['edits', 'library', 'config', 'edits', 'delete', 'forget', 'navigate']);
});

test('failed saves and refused deletion keep the editor and remembered project intact', async () => {
  const save = fixture();
  const deleting = save.remove();
  save.gate.reject(new Error('Disk full'));
  await deleting;
  assert.deepEqual(save.events, ['edits', 'Disk full']);

  const busy = fixture(new Error('Project is busy'));
  busy.gate.resolve();
  await busy.remove();
  assert.deepEqual(busy.events, ['edits', 'library', 'config', 'edits', 'delete', 'Project is busy']);
});
