import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { Library } from "@diffusionstudio/runtime";
import type { Checkpoint } from "@desktop/checkpoint-contracts";
import { mainBridge } from "@/lib/ipc";
import { useProject } from "@/context/project";
import { editorSession, requireEditorSession } from "@/dapi/session";
import { flushProjectEdits } from "@/projects/edits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";

export async function saveProjectCheckpoint(label: string) {
  const session = requireEditorSession();
  const dir = session.project.dir();
  await flushProjectEdits(session.world, { allowUnloaded: true });
  await session.world.get(Library)?.settle();
  if (editorSession() !== session || session.project.dir() !== dir) throw new Error("The project changed before saving its checkpoint");
  return mainBridge.call(MAIN_CHANNELS.CHECKPOINTS_CREATE, { dir, label });
}

export function CheckpointPanel(props: { active: boolean; disabled?: boolean; revision: number; onBusyChange: (busy: boolean) => void }) {
  const project = useProject();
  const [items, setItems] = createSignal<Checkpoint[]>([]);
  const [label, setLabel] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [working, setWorking] = createSignal("");
  const [error, setError] = createSignal("");
  const [restoring, setRestoring] = createSignal<Checkpoint>();
  let disposed = false;
  let generation = 0;
  onCleanup(() => { disposed = true; props.onBusyChange(false); });
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  const refresh = async () => {
    const current = ++generation;
    setLoading(true);
    setError("");
    try {
      const checkpoints = await mainBridge.call(MAIN_CHANNELS.CHECKPOINTS_LIST, { dir: project.dir() });
      if (!disposed && current === generation) setItems(checkpoints);
    } catch (cause) { if (!disposed && current === generation) fail(cause); }
    finally { if (!disposed && current === generation) setLoading(false); }
  };
  createEffect(() => { props.revision; if (props.active) void refresh(); });

  const save = async () => {
    if (working() || props.disabled) return;
    setWorking("Saving checkpoint…");
    props.onBusyChange(true);
    setError("");
    try {
      await saveProjectCheckpoint(label().trim() || "Manual checkpoint");
      if (!disposed) { setLabel(""); await refresh(); }
    } catch (cause) { if (!disposed) fail(cause); }
    finally { setWorking(""); props.onBusyChange(false); }
  };

  const restore = async () => {
    const checkpoint = restoring();
    if (!checkpoint || working() || props.disabled) return;
    const session = requireEditorSession();
    const dir = project.dir();
    setWorking("Restoring checkpoint…");
    props.onBusyChange(true);
    setError("");
    try {
      await flushProjectEdits(session.world, { allowUnloaded: true });
      await session.world.get(Library)?.settle();
      if (editorSession() !== session || project.dir() !== dir) throw new Error("The project changed before restoring its checkpoint");
      await mainBridge.call(MAIN_CHANNELS.CHECKPOINTS_RESTORE, { dir, id: checkpoint.id });
      if (!disposed && project.dir() === dir) window.location.reload();
    } catch (cause) {
      if (!disposed) { setRestoring(undefined); await refresh(); fail(cause); }
    } finally { setWorking(""); props.onBusyChange(false); }
  };

  return <div class="flex flex-col h-full min-h-0">
    <div class="p-3 border-b border-border space-y-3 shrink-0">
      <p class="text-xs text-muted-foreground">Saved before agent turns and transcript edits, plus every five minutes while editing. The latest ten automatic recoveries are kept.</p>
      <form class="flex gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input aria-label="Checkpoint name" placeholder="Checkpoint name" maxLength={160} class="min-w-0 flex-1 bg-background border border-border-input rounded px-2 py-1.5 text-xs" value={label()} disabled={props.disabled || !!working()} onInput={(event) => setLabel(event.currentTarget.value)} />
        <Button type="submit" variant="secondary" disabled={props.disabled || !!working()}>Save</Button>
      </form>
      <div class="flex items-center gap-2"><span class="text-xxs text-muted-foreground flex-1">{items().length} checkpoints</span><Button variant="ghost" disabled={loading() || !!working()} onClick={() => void refresh()}>Refresh</Button></div>
    </div>
    <Show when={error()}><p role="alert" class="px-3 py-2 text-xs text-destructive whitespace-pre-wrap">{error()}</p></Show>
    <div class="flex-1 min-h-0 overflow-y-auto px-3" aria-label="Project checkpoints" aria-busy={loading()}>
      <Show when={!items().length}><p class="py-6 text-xs text-muted-foreground">{loading() ? "Loading checkpoints…" : "Save a checkpoint to keep this version."}</p></Show>
      <For each={items()}>{(item) => <div class="py-3 border-b border-border flex gap-2 items-center">
        <div class="min-w-0 flex-1"><p class="text-xs break-words">{item.label}</p><p class="text-xxs text-muted-foreground mt-1">{new Date(item.createdAt).toLocaleString()} · {item.fileCount} files</p></div>
        <Button variant="ghost" disabled={props.disabled || !!working()} aria-label={`Restore ${item.label}`} onClick={() => setRestoring(item)}>Restore</Button>
      </div>}</For>
    </div>
    <Dialog open={!!restoring() || !!working()} onOpenChange={(open) => { if (!open && !working()) setRestoring(undefined); }}>
      <DialogPortal><DialogContent class="sm:max-w-sm" showCloseButton={!working()} onEscapeKeyDown={(event) => { if (working()) event.preventDefault(); }} onInteractOutside={(event) => { if (working()) event.preventDefault(); }}>
        <DialogTitle>{working() || "Restore checkpoint?"}</DialogTitle>
        <DialogDescription>{working() ? "Keep the editor open while project files are saved." : `Restore “${restoring()?.label}” and reload the editor. Your current project files will be saved as a recovery checkpoint first. Unsent chat drafts and attachments stay.`}</DialogDescription>
        <Show when={!working()}><div class="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRestoring(undefined)}>Cancel</Button><Button disabled={props.disabled} onClick={() => void restore()}>Restore checkpoint</Button></div></Show>
      </DialogContent></DialogPortal>
    </Dialog>
  </div>;
}
