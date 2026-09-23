import { For, Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { assetName, isUrlSource } from '@diffusionstudio/assets';
import type { Asset } from '@diffusionstudio/assets';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { useProject } from '@/context/project';
import { useLibrary } from '@/engine/library';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';

type Mode = 'relink' | 'collect';
type Missing = { asset: Asset; candidates: string[]; selected: string; error?: string };
const [mode, setMode] = createSignal<Mode>();
export const openMediaPortability = (value: Mode) => setMode(value);

export function MediaPortability() {
  const project = useProject();
  const library = useLibrary();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [missing, setMissing] = createSignal<Missing[]>([]);
  const [collected, setCollected] = createSignal(false);
  let generation = 0;
  const describe = (value: unknown) => value instanceof Error ? value.message : String(value);
  const selectedCount = () => missing().filter(row => row.selected).length;

  createEffect(() => {
    project.dir();
    setMode(undefined);
  });
  onCleanup(() => { generation++; setMode(undefined); });
  createEffect(() => {
    const current = mode();
    const token = ++generation;
    setError(''); setMessage(''); setMissing([]); setCollected(false); setBusy(false);
    if (current !== 'relink') return;
    const lib = untrack(library);
    if (!lib) return;
    const assets = untrack(() => lib.list());
    setBusy(true);
    void (async () => {
      const rows: Missing[] = [];
      for (const asset of assets) {
        if (token !== generation) return;
        if (isUrlSource(asset.source) || await lib.fs.stat(asset.source)) continue;
        rows.push({ asset, candidates: [], selected: '' });
      }
      if (token !== generation) return;
      setMissing(rows);
      setMessage(rows.length ? `${rows.length} missing media source${rows.length === 1 ? '' : 's'}` : 'All local media is available.');
    })().catch(value => { if (token === generation) setError(describe(value)); })
      .finally(() => { if (token === generation) setBusy(false); });
  });

  const search = async () => {
    const token = generation;
    setBusy(true); setError('');
    try {
      const folder = await mainBridge.call(MAIN_CHANNELS.MEDIA_PICK_FOLDER, undefined);
      if (!folder || token !== generation) return;
      setMessage('Searching…');
      const results = await mainBridge.call(MAIN_CHANNELS.MEDIA_FIND_MISSING, {
        folder, missing: missing().map(({ asset }) => ({ source: asset.source, size: asset.type === 'SEQUENCE' ? undefined : asset.stat?.size })),
      });
      if (token !== generation) return;
      const matches = new Map(results.map(row => [row.source, row.candidates]));
      setMissing(rows => rows.map(row => {
        const candidates = matches.get(row.asset.source) ?? [];
        return { ...row, candidates, selected: candidates.length === 1 ? candidates[0] : '', error: undefined };
      }));
      setMessage(`Searched ${folder}`);
    } catch (value) { if (token === generation) setError(describe(value)); }
    finally { if (token === generation) setBusy(false); }
  };

  const relink = async () => {
    const lib = library();
    if (!lib) return;
    const token = generation;
    setBusy(true); setError('');
    let count = 0;
    const remaining: Missing[] = [];
    try {
      for (const row of missing()) {
        if (token !== generation || library() !== lib) return;
        if (!row.selected) { remaining.push(row); continue; }
        try { await lib.relink(row.asset, row.selected); count++; }
        catch (value) { remaining.push({ ...row, error: describe(value) }); }
      }
      await lib.settle();
      if (token !== generation) return;
      setMissing(remaining);
      setMessage(`Relinked ${count} source${count === 1 ? '' : 's'}. ${remaining.length} remaining.`);
    } catch (value) { if (token === generation) setError(describe(value)); }
    finally { if (token === generation) setBusy(false); }
  };

  const collect = async () => {
    const lib = library();
    if (!lib) return;
    const dir = project.dir(), token = generation, assets = lib.list();
    setBusy(true); setError(''); setMessage('Copying original media…');
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.MEDIA_COLLECT, { dir, sources: [...new Set(assets.map(asset => asset.source))] });
      if (token !== generation || library() !== lib) return;
      const errors = result.failed.map(row => `${row.source}: ${row.error}`);
      let count = 0;
      for (const copy of result.copies) {
        if (token !== generation || library() !== lib) return;
        for (const asset of assets.filter(asset => asset.source === copy.source)) {
          try { await lib.relink(asset, copy.path); count++; }
          catch (value) { errors.push(`${assetName(asset)}: ${describe(value)}. Copy kept at ${copy.path}`); }
        }
      }
      await lib.settle();
      if (token !== generation) return;
      setCollected(true);
      setMessage(`${count} media source${count === 1 ? '' : 's'} stored in this project.`);
      setError(errors.join('\n'));
    } catch (value) { if (token === generation) setError(describe(value)); }
    finally { if (token === generation) setBusy(false); }
  };

  return <Dialog open={!!mode()} onOpenChange={open => { if (!open && !busy()) setMode(undefined); }}>
    <DialogPortal><DialogContent class="sm:max-w-2xl">
      <DialogTitle>{mode() === 'relink' ? 'Find missing media' : 'Collect project media'}</DialogTitle>
      <DialogDescription>{mode() === 'relink' ? 'Search a folder for matching filenames and sizes, then choose which files to relink.' : `Copy original media into this project and update its file references. Originals stay where they are. ${library()?.list().length ?? 0} media sources.`}</DialogDescription>
      <Show when={message()}><p class="text-xs break-all" role="status">{message()}</p></Show>
      <Show when={error()}><p class="text-xs text-destructive whitespace-pre-wrap max-h-40 overflow-auto" role="alert">{error()}</p></Show>
      <Show when={mode() === 'relink' && missing().length}>
        <div class="max-h-80 overflow-auto divide-y divide-border">
          <For each={missing()}>{row => <div class="py-3 space-y-1">
            <p class="text-xs font-medium">{assetName(row.asset)}</p>
            <p class="text-xxs text-muted-foreground break-all">{row.asset.source}</p>
            <select class="w-full bg-background border border-border rounded px-2 py-1 text-xs" aria-label={`Replacement for ${assetName(row.asset)}`} disabled={busy() || !row.candidates.length} value={row.selected}
              onChange={event => { const selected = event.currentTarget.value; setMissing(rows => rows.map(item => item === row ? { ...item, selected } : item)); }}>
              <option value="">{row.candidates.length ? 'Choose a file' : 'No match found'}</option>
              <For each={row.candidates}>{path => <option value={path}>{path}</option>}</For>
            </select>
            <Show when={row.error}><p class="text-xs text-destructive">{row.error}</p></Show>
          </div>}</For>
        </div>
      </Show>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy()} onClick={() => setMode(undefined)}>Close</Button>
        <Show when={mode() === 'relink'} fallback={<Button disabled={busy() || collected() || !library()?.list().length} onClick={() => void collect()}>{busy() ? 'Copying…' : 'Copy media'}</Button>}>
          <Button variant="outline" disabled={busy() || !missing().length} onClick={() => void search()}>Search folder</Button>
          <Button disabled={busy() || !selectedCount()} onClick={() => void relink()}>Relink {selectedCount() || ''} selected</Button>
        </Show>
      </div>
    </DialogContent></DialogPortal>
  </Dialog>;
}
