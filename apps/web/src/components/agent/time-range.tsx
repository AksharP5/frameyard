import { Show, createMemo, createSignal } from "solid-js";
import { timeRangeSchema, type TimeRange } from "@desktop/annotation-contracts";
import { getEditorContext } from "@/dapi/handlers/context";
import { editorSession } from "@/dapi/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";

export async function captureTimeRangeContext() {
  const context = await getEditorContext(editorSession);
  if (!context.sceneTiming) {
    throw new Error("Select a scene before attaching a time range");
  }
  return context.sceneTiming;
}

export function TimeRangePicker(props: {
  snapshot: Awaited<ReturnType<typeof captureTimeRangeContext>>;
  initial?: TimeRange;
  onAttach: (range: TimeRange) => void;
  onClose: () => void;
}) {
  const scene = props.snapshot;
  const initial = props.initial?.sceneId === scene.sceneId ? props.initial : scene.timelineRange;
  const initialStart = initial?.start ?? Math.max(0, scene.currentTime);
  const displayTime = (seconds: number) => String(Number(seconds.toFixed(6)));
  const [start, setStart] = createSignal(displayTime(initialStart));
  const [end, setEnd] = createSignal(displayTime(initial?.end ?? initialStart + 1));
  const range = createMemo(() => timeRangeSchema.safeParse({
    sceneId: scene.sceneId,
    sceneName: scene.sceneName,
    frameRate: scene.frameRate,
    start: start().trim() ? Math.round(Number(start()) * scene.frameRate) / scene.frameRate : NaN,
    end: end().trim() ? Math.round(Number(end()) * scene.frameRate) / scene.frameRate : NaN,
  }));

  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogPortal>
      <DialogContent class="sm:max-w-sm gap-4">
        <DialogTitle>Time range</DialogTitle>
        <DialogDescription class="text-xs">Time an edit or place new content in {scene.sceneName}.</DialogDescription>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-xs space-y-1.5">Start (seconds)<input aria-label="Range start in seconds" type="number" min="0" step={1 / scene.frameRate} value={start()} onInput={(event) => setStart(event.currentTarget.value)} class="block w-full rounded-md border border-border-input bg-secondary px-2 py-2 outline-none focus-visible:ring-1 focus-visible:ring-primary" /></label>
          <label class="text-xs space-y-1.5">End (seconds)<input aria-label="Range end in seconds" type="number" min="0" step={1 / scene.frameRate} value={end()} onInput={(event) => setEnd(event.currentTarget.value)} class="block w-full rounded-md border border-border-input bg-secondary px-2 py-2 outline-none focus-visible:ring-1 focus-visible:ring-primary" /></label>
        </div>
        <Show when={scene.timelineRange}>{(timeline) => <Button variant="secondary" onClick={() => { setStart(displayTime(timeline().start)); setEnd(displayTime(timeline().end)); }}>Use timeline range · {timeline().start.toFixed(2)} to {timeline().end.toFixed(2)}s</Button>}</Show>
        <p class="text-xs text-muted-foreground">Shift-drag the timeline ruler to mark a range, or enter times here. Times snap to frames.</p>
        <p class="text-xs text-muted-foreground">Edits use this interval. New content starts at the beginning and keeps its full length unless you ask it to fit. The scene extends as needed.</p>
        <Show when={!range().success}><p role="alert" class="text-xs text-destructive">Choose a nonnegative start and an end at least one frame later.</p></Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={!range().success} onClick={() => { const result = range(); if (result.success) props.onAttach(result.data); }}>Attach range</Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
