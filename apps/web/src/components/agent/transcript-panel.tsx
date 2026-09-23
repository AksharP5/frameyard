import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { useQuery } from "@diffusionstudio/koota-solid";
import { Active, AssetId, FrameRate, Library, Source, getActiveEntity, getSceneAncestor, isScene, setPlayhead } from "@diffusionstudio/runtime";
import { Captions, authoredElement } from "@diffusionstudio/reconciler";
import { editorLoadState, editorSession } from "@/dapi/session";
import { getDocumentEditor } from "@/engine/editor";
import { isClipLocked } from "@/engine/clip-links";
import { getEditHistory } from "@/engine/history";
import { flushProjectEdits } from "@/projects/edits";
import { Button } from "@/components/ui/button";
import { captureFullTranscript, type FullTranscriptAttachment } from "./full-transcript";
import { correctTranscriptWord, transcriptSentences } from "./transcript-data";
import { applyTranscriptCut, planTranscriptCut } from "./transcript-cut";
import { cachedTranscript, readTranscriptAsset, saveTranscriptAsset, sceneTranscriptCaptions, transcriptAttachment, transcriptCacheKey, transcriptSceneSignature, usesSceneTranscriptTiming } from "./transcript-document";
import type { Asset, Transcript } from "@diffusionstudio/assets";

type TranscriptDocument = { asset: Asset; transcript: Transcript; signature: string; key: string; projectDir: string; sceneId: string };

const timestamp = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;

export function TranscriptPanel(props: {
  beforeEdit: (label: string) => Promise<void>;
  onAttach: (attachment: FullTranscriptAttachment) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  editingDisabled?: boolean;
}) {
  const active = useQuery(Active);
  const [revision, setRevision] = createSignal(0);
  const [document, setDocument] = createSignal<TranscriptDocument>();
  const [selection, setSelection] = createSignal<{ anchor: number; end: number }>();
  const [replacement, setReplacement] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  let disposed = false;
  let load = 0;
  onCleanup(() => { disposed = true; load++; props.onBusyChange?.(false); });

  const context = createMemo(() => {
    active();
    const session = editorSession();
    const state = editorLoadState();
    if (!session || state?.world !== session.world || state.status !== "ready") return;
    const scene = getActiveEntity(session.world);
    if (!scene || !isScene(scene) || !scene.get(Source)?.value) return;
    return { ...session, scene, projectDir: session.project.dir(), sceneId: scene.get(Source)!.value };
  });
  createEffect(() => {
    const current = context();
    if (!current) return;
    onCleanup(getDocumentEditor(current.world).onEdit(() => setRevision((value) => value + 1)));
    onCleanup(current.world.onChange(AssetId, (entity) => {
      if (getSceneAncestor(entity) === current.scene) setRevision((value) => value + 1);
    }));
  });
  const signature = createMemo(() => {
    revision();
    const current = context();
    return current && transcriptSceneSignature(current.world, current.scene);
  });
  const captionSources = createMemo(() => {
    revision();
    const current = context();
    return current && JSON.stringify(sceneTranscriptCaptions(current.world, current.scene).map((caption) => [
      authoredElement(caption)?.props.src ?? false, caption.get(AssetId)?.value,
    ]));
  });
  const stale = () => !document() || document()!.signature !== signature() || document()!.projectDir !== context()?.projectDir;
  const transcript = createMemo(() => transcriptSentences(document()?.transcript ?? []));
  const range = createMemo(() => {
    const selected = selection();
    if (!selected) return;
    const first = Math.min(selected.anchor, selected.end);
    const last = Math.max(selected.anchor, selected.end);
    const words = transcript().words;
    if (!words[first] || !words[last]) return;
    return { first, last, start: words[first].start, end: Math.max(...words.slice(first, last + 1).map((word) => word.end)) };
  });

  createEffect(on([context, signature, captionSources], ([current, source]) => {
    const request = ++load;
    if (!current || !source) return;
    if (document()?.projectDir !== current.projectDir || document()?.sceneId !== current.sceneId) {
      setDocument(undefined);
      setSelection(undefined);
      setError("");
    }
    void transcriptCacheKey(source).then(async (key) => {
      const asset = cachedTranscript(current.world, current.scene, key);
      if (!asset || request !== load || disposed) return;
      if (document()?.asset.id === asset.id && document()?.signature === source) return;
      const words = await readTranscriptAsset(asset);
      if (request !== load || disposed) return;
      setDocument({ asset, transcript: words, signature: source, key, projectDir: current.projectDir, sceneId: current.sceneId });
      setSelection(undefined);
      setError("");
    }).catch((cause) => { if (request === load && !disposed) setError(String(cause)); });
  }));

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy() || props.disabled) return;
    load++;
    setBusy(label);
    props.onBusyChange?.(true);
    setError("");
    try { await action(); }
    catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!disposed) { setBusy(""); props.onBusyChange?.(false); } }
  };
  const requireCurrent = () => {
    const current = context();
    const source = signature();
    const editRevision = revision();
    if (!current || !source) throw new Error("Open a scene and wait for it to finish loading.");
    const check = (allowOwnEdits = false) => {
      if (disposed || context()?.world !== current.world || context()?.scene !== current.scene || context()?.projectDir !== current.projectDir || signature() !== source || !allowOwnEdits && revision() !== editRevision) {
        throw new Error("The scene changed. Reload its transcript before editing.");
      }
    };
    return { ...current, signature: source, check };
  };
  const generate = () => run("Transcribing…", async () => {
    const current = requireCurrent();
    const result = await captureFullTranscript();
    current.check();
    const library = current.world.get(Library)!;
    const asset = library.get(result.assetPath);
    if (!asset) throw new Error("The transcript was not saved to the project.");
    const words = await readTranscriptAsset(asset);
    const key = await transcriptCacheKey(current.signature);
    current.check();
    library.update(asset, { generation: { key } });
    await library.settle();
    current.check();
    setDocument({ asset, transcript: words, signature: current.signature, key, projectDir: current.projectDir, sceneId: current.sceneId });
    setSelection(undefined);
  });
  const choose = (index: number, extend = false) => {
    if (stale() || busy()) return;
    const current = context();
    if (!current) return;
    setSelection({ anchor: extend ? selection()?.anchor ?? index : index, end: index });
    setReplacement(transcript().words[index].text);
    setPlayhead(current.world, current.scene, transcript().words[index].start * (current.world.get(FrameRate)?.value ?? 30));
  };
  const correct = () => run("Saving…", async () => {
    if (props.editingDisabled) return;
    const current = requireCurrent();
    const previous = document();
    const selected = range();
    if (!previous || stale() || !selected || selected.first !== selected.last) throw new Error("Select one word to correct.");
    const words = correctTranscriptWord(previous.transcript, selected.first, replacement());
    if (JSON.stringify(words) === JSON.stringify(previous.transcript)) return;
    const captions = sceneTranscriptCaptions(current.world, current.scene).filter((caption) =>
      caption.get(AssetId)?.value === previous.asset.id
      || !authoredElement(caption)?.props.src && usesSceneTranscriptTiming(current.world, current.scene, caption));
    if (captions.some(isClipLocked)) throw new Error("Unlock the linked captions before correcting their transcript.");
    await props.beforeEdit("Correct transcript word");
    current.check();
    const asset = await saveTranscriptAsset(current.world.get(Library)!, words, previous.key);
    current.check();
    const editor = getDocumentEditor(current.world);
    const history = getEditHistory(current.world);
    history.beginGesture();
    try {
      for (const caption of captions) editor.editProperty(caption, "src", asset.path);
    } finally { history.endGesture(); }
    await flushProjectEdits(current.world);
    current.check(true);
    setDocument({ ...previous, asset, transcript: words });
  });
  const captions = () => run("Applying captions…", async () => {
    if (props.editingDisabled) return;
    const current = requireCurrent();
    const source = document();
    if (!source || stale()) throw new Error("Generate a current transcript first.");
    const existing = sceneTranscriptCaptions(current.world, current.scene);
    if (existing.some((caption) => !usesSceneTranscriptTiming(current.world, current.scene, caption))) {
      throw new Error("Existing captions have custom timing or nesting. Remove them before applying a new full-scene transcript.");
    }
    if (isClipLocked(current.scene) || existing.some(isClipLocked)) throw new Error("Unlock the scene and its captions before applying a transcript.");
    await props.beforeEdit("Apply transcript captions");
    current.check();
    const editor = getDocumentEditor(current.world);
    const history = getEditHistory(current.world);
    history.beginGesture();
    try {
      if (existing.length) for (const caption of existing) editor.editProperty(caption, "src", source.asset.path);
      else editor.insertElement(current.scene, () => <Captions src={source.asset.path} />);
    } finally { history.endGesture(); }
    await flushProjectEdits(current.world);
  });
  const cut = () => run("Cutting…", async () => {
    if (props.editingDisabled) return;
    const current = requireCurrent();
    const selected = range();
    if (stale() || !selected) throw new Error("Select words from the current transcript.");
    const fps = current.world.get(FrameRate)?.value ?? 30;
    const plan = planTranscriptCut(current.world, current.scene, Math.floor(selected.start * fps), Math.ceil(selected.end * fps));
    await props.beforeEdit(`Cut transcript ${timestamp(selected.start)} to ${timestamp(selected.end)}`);
    current.check();
    applyTranscriptCut(current.world, plan);
    setSelection(undefined);
    await flushProjectEdits(current.world);
  });

  return <div class="flex h-full min-h-0 flex-col text-xs">
    <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button variant="secondary" disabled={!context() || !!busy() || props.disabled} onClick={() => void generate()}>{busy() || (document() ? "Regenerate" : "Generate transcript")}</Button>
      <Button variant="ghost" disabled={stale() || !!busy() || props.disabled || props.editingDisabled} onClick={() => void captions()}>Apply captions</Button>
      <Button variant="ghost" disabled={stale() || !!busy() || props.disabled} onClick={() => {
        const current = context(); const source = document();
        if (current && source && !stale()) props.onAttach(transcriptAttachment(current.world, current.scene, current.projectDir, source.asset));
      }}>Attach to chat</Button>
    </div>
    <Show when={error()}><p role="alert" class="px-3 py-2 text-destructive">{error()}</p></Show>
    <Show when={document()} fallback={<p class="px-3 py-4 text-muted-foreground">Generate the full scene transcript to seek, correct words, or cut sentences.</p>}>
      <p class="px-3 py-2 text-muted-foreground">{stale() ? "Scene changed. Regenerate to edit or attach this transcript." : "Click a word to seek. Shift-click to select a range."}</p>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Scene transcript">
        <For each={transcript().sentences}>{(sentence) => <div class="group flex items-start gap-2 border-b border-border/50 py-3">
          <button type="button" class="mt-1 shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={stale() || !!busy()} aria-label={`Select sentence at ${timestamp(transcript().words[sentence.first].start)}`} onClick={() => { choose(sentence.first); setSelection({ anchor: sentence.first, end: sentence.last }); }}>{timestamp(transcript().words[sentence.first].start)}</button>
          <p class="leading-7"><For each={transcript().words.slice(sentence.first, sentence.last + 1)}>{(word, offset) => {
            const index = () => sentence.first + offset();
            const selected = () => !!range() && index() >= range()!.first && index() <= range()!.last;
            return <><button type="button" class="rounded-sm px-0.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary disabled:opacity-50" classList={{ "bg-primary/20 text-primary": selected() }} aria-pressed={selected()} disabled={stale() || !!busy()} onClick={(event) => choose(index(), event.shiftKey)}>{word.text}</button>{" "}</>;
          }}</For></p>
        </div>}</For>
      </div>
      <Show when={range()}>{(selected) => <div class="space-y-2 border-t p-3">
        <div class="flex items-center justify-between gap-2"><span class="text-muted-foreground">{timestamp(selected().start)} to {timestamp(selected().end)} · {(selected().end - selected().start).toFixed(2)}s</span><Button variant="destructive" disabled={stale() || !!busy() || props.disabled || props.editingDisabled} onClick={() => void cut()}>Cut selection</Button></div>
        <Show when={selected().first === selected().last}><form class="flex gap-2" onSubmit={(event) => { event.preventDefault(); void correct(); }}><input class="min-w-0 flex-1 rounded border border-border-input bg-transparent px-2 py-1 outline-none focus:border-primary" aria-label="Correct selected word" value={replacement()} onInput={(event) => setReplacement(event.currentTarget.value)} disabled={stale() || !!busy() || props.disabled || props.editingDisabled} /><Button type="submit" variant="secondary" disabled={stale() || !!busy() || props.disabled || props.editingDisabled || !replacement().trim()}>Save word</Button></form></Show>
        <p class="text-[10px] text-muted-foreground">Cuts remove this time from every track and close the gap. A checkpoint is saved first.</p>
      </div>}</Show>
    </Show>
  </div>;
}
