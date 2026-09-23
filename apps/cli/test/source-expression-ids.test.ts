import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { transformSync, type PluginObj } from '@babel/core';

const built = await build({
  stdin: { contents: `export { stampProject, applyEdits } from './edit'; export { sourcePlugin } from './source';`, resolveDir: fileURLToPath(new URL('../../desktop/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['ts-morph'],
});
const module = { exports: {} as Pick<typeof import('../../desktop/src/edit'), 'stampProject' | 'applyEdits'> & Pick<typeof import('../../desktop/src/source'), 'sourcePlugin'> };
runInNewContext(`(function(require,module,exports){"use strict";${built.outputFiles[0].text}\n})`)(createRequire(import.meta.url), module, module.exports);

test('static expression IDs survive repeated compile preparation and remain writable by their authored identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-expression-id-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = 'export default () => <stage id={"root"}><scene id="scene" width={640} height={360}><path id={"path-layer"} d="M0 0L30 30"/></scene></stage>;\n';
  const file = join(dir, 'index.tsx');
  await writeFile(file, source);
  for (let compile = 0; compile < 2; compile++) {
    await module.exports.stampProject({ dir });
    const stamped = await readFile(file, 'utf8');
    assert.equal(stamped, source, 'a compile of fully named source must not rewrite IDs');
    const code = transformSync(stamped, { plugins: [[module.exports.sourcePlugin, { file: 'index.tsx' }]], parserOpts: { plugins: ['jsx'] }, babelrc: false, configFile: false })!.code!;
    assert.match(code, /__source="index.tsx:root"/);
    assert.match(code, /__source="index.tsx:path-layer"/);
  }
  const result = await module.exports.applyEdits({ dir }, [{ kind: 'set', source: 'index.tsx:path-layer', props: { x: 42 } }]);
  assert.equal(result.skipped.length, 0);
  const updated = await readFile(file, 'utf8');
  assert.match(updated, /x=\{42\}/);
  assert.equal([...updated.matchAll(/\bid=/g)].length, 3);
});

test('saving native path dimensions and frame-based keyframes preserves numeric precision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-source-precision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'index.tsx');
  await writeFile(file, 'export default () => <scene id="scene" />;\n');

  const numericProps = (source: string) => {
    const values: Record<string, Record<string, number | number[]>> = {};
    const plugin: PluginObj = { visitor: { JSXOpeningElement(path) {
      if (path.node.name.type !== 'JSXIdentifier') return;
      const props = values[path.node.name.name] = {};
      for (const attribute of path.node.attributes) {
        if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier' || attribute.value?.type !== 'JSXExpressionContainer') continue;
        const expression = attribute.value.expression;
        if (expression.type === 'NumericLiteral') props[attribute.name.name] = expression.value;
        if (expression.type === 'ArrayExpression' && expression.elements.every(element => element?.type === 'NumericLiteral')) {
          props[attribute.name.name] = expression.elements.map(element => element.value);
        }
      }
    } } };
    transformSync(source, { plugins: [plugin], parserOpts: { plugins: ['jsx'] }, babelrc: false, configFile: false });
    return values;
  };

  const pathProps = { width: 400.123456789, height: 0.0001, viewBox: [0, 0, 400.123456789, 0.0001] };
  const keyProps = { time: 1 / 30, value: Math.PI };
  const inserted = await module.exports.applyEdits({ dir }, [
    { kind: 'insert', source: 'pending#path', parent: 'index.tsx:scene', tag: 'path', props: { ...pathProps, d: 'M0 0L400 0' } },
    { kind: 'insert', source: 'pending#track', parent: 'pending#path', tag: 'keyframeTrack', props: { property: 'x' } },
    { kind: 'insert', source: 'pending#key', parent: 'pending#track', tag: 'keyframe', props: keyProps },
  ]);
  assert.equal(inserted.skipped.length, 0);
  const initial = numericProps(await readFile(file, 'utf8'));
  assert.deepEqual(initial.path, pathProps);
  assert.deepEqual(initial.keyframe, keyProps);

  const nextPath = { width: 1 / 3, height: 0.0000001, viewBox: [0, 0, 1 / 3, 0.0000001] };
  const nextKey = { time: 2 / 30, value: 1 / 7 };
  let previous: string | undefined;
  for (let pass = 0; pass < 2; pass++) {
    const result = await module.exports.applyEdits({ dir }, [
      { kind: 'set', source: inserted.ids!['pending#path'], props: nextPath },
      { kind: 'set', source: inserted.ids!['pending#key'], props: nextKey },
    ]);
    assert.equal(result.skipped.length, 0);
    const saved = await readFile(file, 'utf8');
    await module.exports.stampProject({ dir });
    assert.equal(await readFile(file, 'utf8'), saved);
    assert.deepEqual(numericProps(saved).path, nextPath);
    assert.deepEqual(numericProps(saved).keyframe, nextKey);
    if (previous !== undefined) assert.equal(saved, previous);
    previous = saved;
  }
});
