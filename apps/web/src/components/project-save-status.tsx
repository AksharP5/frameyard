import { Show, createSignal, onCleanup } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { toast } from 'somoto';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { discardProjectRecovery, getProjectRecovery, getProjectSaveState, retryProjectEdits, subscribeProjectSaveState } from '@/projects/edits';
import { useLibrary } from '@/engine/library';

export function ProjectSaveStatus(props: { onReload: () => Promise<void> }) {
  const world = useWorld();
  const library = useLibrary();
  const [state, setState] = createSignal(getProjectSaveState(world));
  const [open, setOpen] = createSignal(false);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  onCleanup(subscribeProjectSaveState(world, setState));
  const sourceFailure = () => { const current = state(); return current.status === 'failed' ? current : undefined; };
  const mediaFailure = () => { const current = library()?.saveState(); return current?.status === 'failed' ? current : undefined; };
  const failure = () => sourceFailure() ?? mediaFailure();
  const saving = () => state().status === 'saving' || library()?.saveState().status === 'saving';
  const saved = () => state().status === 'saved' && (library()?.saveState().status ?? 'saved') === 'saved';
  const canRetry = () => !!mediaFailure() || !!sourceFailure()?.retryable;
  const fail = (error: unknown) => toast.error('Could not recover project', { description: error instanceof Error ? error.message : String(error) });

  const retry = async () => {
    setBusy(true);
    try {
      await library()?.settle();
      if (sourceFailure()?.retryable) { await retryProjectEdits(world); await props.onReload(); }
      if (!failure()) setOpen(false);
    }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true);
    try { discardProjectRecovery(world); await props.onReload(); setOpen(false); setConfirmDiscard(false); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const download = () => {
    const recovery = getProjectRecovery(world);
    if (!recovery) return;
    const url = URL.createObjectURL(new Blob([recovery], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `project-recovery-${new Date().toISOString().replaceAll(':', '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <>
    <button class="text-xxs px-2 py-1 rounded bg-background/90" classList={{ 'text-destructive': !!failure(), 'text-muted-foreground': !failure() }}
      disabled={!failure()} onClick={() => { setConfirmDiscard(false); setOpen(true); }} title={failure()?.error} aria-label="Project save status">
      {failure() ? 'Unsaved changes' : saved() ? 'Saved' : saving() ? 'Saving…' : 'Unsaved'}
    </button>
    <Dialog open={open()} onOpenChange={(value) => { if (!busy()) setOpen(value); }}>
      <DialogPortal><DialogContent class="sm:max-w-md">
        <DialogTitle>{confirmDiscard() ? 'Use the saved project?' : 'Unsaved changes'}</DialogTitle>
        <DialogDescription>{confirmDiscard() ? 'This discards the unsaved edits in memory and reloads the project from disk. Download recovery edits first if you want to keep a copy.' : failure()?.error}</DialogDescription>
        <div class="flex flex-wrap justify-end gap-2">
          <Show when={sourceFailure()}><Button variant="ghost" disabled={busy()} onClick={download}>Download recovery</Button></Show>
          <Show when={!confirmDiscard()} fallback={<><Button variant="ghost" disabled={busy()} onClick={() => setConfirmDiscard(false)}>Cancel</Button><Button disabled={busy()} onClick={() => void discard()}>Discard unsaved edits</Button></>}>
            <Show when={sourceFailure()}><Button variant="ghost" disabled={busy()} onClick={() => setConfirmDiscard(true)}>Use saved project</Button></Show>
            <Show when={canRetry()}><Button disabled={busy()} onClick={() => void retry()}>Retry saving</Button></Show>
          </Show>
        </div>
      </DialogContent></DialogPortal>
    </Dialog>
  </>;
}
