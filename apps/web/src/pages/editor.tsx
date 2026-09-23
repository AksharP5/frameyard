/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal, onMount } from "solid-js";
import { createWindowSize } from '@solid-primitives/resize-observer';
import { Canvas } from "@/components/canvas";
import { leftSidebarWidth } from "@/agent-chat";
import { Timeline, Layers } from "@/components/timeline";
import { Soundboard, Inspector } from "@/components/sidebar-right";
import { FloatingProjectHeader, SidebarLeft } from "@/components/sidebar-left";
import { useLayout, MIN_TIMELINE_HEIGHT } from "@/context/layout";
import { useEditorApi } from "@/dapi";
import { RULER_HEIGHT } from "@/engine/timeline";
import { createEffect, onCleanup, untrack } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@diffusionstudio/koota-solid';
import { mount } from '@diffusionstudio/reconciler';
import { Computed, FrameRate, ProjectFrameRate, Scene, Selected, Source, Root, clearVideoTrackCache, disposeDecoders, invalidateAssetFile, setPlayhead } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '@/engine/editor';
import { getEditHistory } from '@/engine/history';
import { timelineEditing } from '@/engine/timeline-editing';
import { setInspectEntries } from '@/engine/inspect';
import { attachLibrary, isLibraryFile } from '@/engine/library';
import { attachAi } from '@/utils/gen-ai';
import { attachProjectConfig, isProjectConfigFile } from '@/engine/project-config';
import { loadProjectBundle, rememberProjectBundle } from '@/lib/db';
import { isCacheFile } from '@diffusionstudio/assets';
import { createEditWriter, getProjectRecovery, waitForProjectEdits } from '@/projects/edits';
import { recoveryJson } from '@/projects/edit-recovery';
import { compileProject, refreshProject, watchProject } from '@/projects/host';
import { isProjectSourceFile } from '@/projects/change-batch';
import { captureProjectCover } from '@/projects/cover';
import { useProject } from "@/context/project";
import { useEngineContext } from "@/engine";
import { setEditorLoadState } from "@/dapi/session";
import { localMode } from "@/lib/local-mode";
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { PreviewControls } from '@/components/canvas/preview-controls';
import { ProjectSaveStatus } from '@/components/project-save-status';
import { MediaPortability } from '@/components/media-portability';
import { FocusEditor } from "@/components/editor/focus-editor";
import { PanelResizer } from '@/components/ui/panel-resizer';

import type { Mount } from '@diffusionstudio/reconciler';
import type { EditWriter } from '@/projects/edits';

const MIN_CANVAS_HEIGHT = 200;
const MIN_CANVAS_WIDTH = 200;
const MIN_PANEL_WIDTH = 220;
const MIN_AGENT_WIDTH = 300;
const MIN_EDITOR_WIDTH = MIN_PANEL_WIDTH + MIN_AGENT_WIDTH + MIN_CANVAS_WIDTH + 2;
const MIN_EDITOR_HEIGHT = 480;

export function EditorPage() {
  const {
    uiVisible, timelineMinimized, timelineHeight, setTimelineHeight,
    leftPanelWidth, setLeftPanelWidth,
  } = useLayout();
  const { isDesktop, isFullscreen } = useEditorApi();
  const viewport = createWindowSize();
  const viewportWidth = () => localMode ? Math.max(MIN_EDITOR_WIDTH, viewport.width) : viewport.width;
  const viewportHeight = () => localMode ? Math.max(MIN_EDITOR_HEIGHT, viewport.height) : viewport.height;
  const project = useProject();
  const world = useWorld();
  const engine = useEngineContext();
  const [reload, setReload] = createSignal<() => Promise<void>>(async () => {});
  const panels = createMemo(() => {
    const right = 264;
    const available = Math.max(MIN_PANEL_WIDTH, viewportWidth() - MIN_CANVAS_WIDTH - right - 2);
    const savedLeft = leftPanelWidth();
    const left = Math.max(MIN_PANEL_WIDTH, Math.min(available, Number.isFinite(savedLeft) ? Math.max(savedLeft, leftSidebarWidth()) : leftSidebarWidth()));
    return { left, leftMax: available };
  });
  const maxTimelineHeight = () => Math.max(MIN_TIMELINE_HEIGHT, viewportHeight() - MIN_CANVAS_HEIGHT - 1);
  const visibleTimelineHeight = () => Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxTimelineHeight(), timelineHeight()));

  // Keyed on the folder, not the project: a rename moves it, and everything
  // below holds a path — the watcher, the library, the writer — so all of it
  // is torn down and re-attached where the project now is.
  createEffect(() => {
    const dir = project.dir();
    if (!dir) return;

    let mounted: Mount | undefined;
    let mountedCode: string | undefined;
    let writer: EditWriter | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let generation = 0;
    let revision = 0;
    let hasFreshBundle = false;

    // The library first: a mounted project's `src` values name its assets.
    const library = attachLibrary(world, dir);
    // The generation service over it: what `generate.*` sources resolve through.
    attachAi(world, library, dir);
    // The project's own settings (package.json `diffusion`), next to the scene.
    const config = attachProjectConfig(world, dir);

    const unmount = (): void => {
      // Before the entities go: what the editor changed is still owed to the
      // file, whatever happens to the scene that showed it.
      unlisten?.();
      unlisten = undefined;
      writer?.dispose();
      writer = undefined;
      mounted?.dispose();
      mounted = undefined;
      mountedCode = undefined;
      // The entries hold the dead mount's signals; the inspector must not.
      setInspectEntries(world, []);
    };

    /** Puts `code` on the stage, unless it is what is there already. */
    const applyBundle = (code: string): void => {
      const frameRate = config.frameRate();
      if (code === mountedCode && world.get(FrameRate)?.value === frameRate) return;
      const preserveSelection = hasFreshBundle || revision > 0;
      const times = new Map(world.query(Scene, Source).map((scene) => [scene.get(Source)!.value, scene.get(Computed)?.localTimeInSeconds ?? 0]));
      const selected = new Set(world.query(Selected, Source).map((entity) => entity.get(Source)!.value));
      const editor = getDocumentEditor(world);
      const primary = editor.primarySelection();
      const primarySource = primary?.isAlive() ? primary.get(Source)?.value : undefined;
      const linked = editor.linkedSelection;
      const editing = timelineEditing(world);
      const target = editing.target();
      const targetSource = target?.isAlive() ? target.get(Source)?.value : undefined;
      const syncSources = new Set([...editing.syncTracks()].filter(entity => entity.isAlive()).map(entity => entity.get(Source)?.value));
      // The old render goes first: there is only one stage per world.
      unmount();
      world.set(FrameRate, { value: frameRate });
      world.set(ProjectFrameRate, { value: frameRate });
      mounted = mount(code, world);
      mountedCode = code;
      for (const scene of world.query(Scene, Source)) {
        const seconds = times.get(scene.get(Source)!.value);
        if (seconds !== undefined) setPlayhead(world, scene, seconds * frameRate);
      }
      const sources = new Map(world.query(Source).map(entity => [entity.get(Source)!.value, entity]));
      // Cached JSX can carry an obsolete selection. Only live edits or a
      // previously fresh mount override the source, and always as an exact set.
      const restored = preserveSelection
        ? world.query(Source).filter(entity => selected.has(entity.get(Source)!.value))
        : [...world.query(Selected)];
      const primaryIndex = restored.findIndex(entity => entity.get(Source)?.value === primarySource);
      if (primaryIndex > 0) restored.unshift(...restored.splice(primaryIndex, 1));
      editor.select(restored, { linked });
      editing.setTarget(targetSource ? sources.get(targetSource) ?? null : null);
      editing.setSyncTracks(new Set([...syncSources].flatMap(source => source && sources.has(source) ? [sources.get(source)!] : [])));
      // The `@inspect` variables this mount declared, for the inspector.
      setInspectEntries(world, mounted.inspect);
      // The rendered scene knows which element every entity came from, so
      // from here on an edit in the editor can find its way back.
      writer = createEditWriter(dir, world);
      unlisten = editor.onEdit((edit) => { revision++; writer?.push(edit); });
      // A mount comes from the file: edits recorded against the document it
      // replaced cannot be replayed against this one.
      getEditHistory(world).reset();
    };

    const loadProject = async (): Promise<void> => {
      const current = ++generation;
      setEditorLoadState({ world, status: "loading" });
      await writer?.settleForReload();
      await waitForProjectEdits(dir);
      if (disposed || current !== generation) return;
      const compiledRevision = revision;
      const compiling = compileProject(dir);
      const loading = Promise.all([library.load(), config.ready]);

      // First open only: the bundle the last session mounted, straight from
      // the app's database, goes on the stage while the compile chews
      // through the sources — unless the compile wins the race outright. A
      // bundle the sources have outgrown can fail against today's assets;
      // the compile that is already running replaces it either way.
      if (current === 1) {
        // Neither arm may reject: the loser would be an unhandled rejection,
        // and the compile's real failure is dealt with below.
        const cached = await Promise.race([
          Promise.all([loadProjectBundle(untrack(project.id)), loading])
            .then(([code]) => code, () => null),
          compiling.then(() => null, () => null),
        ]);
        if (disposed || current !== generation) return;
        if (cached && mountedCode === undefined) {
          try {
            // Recovered edits need the current source, not a cached preview whose
            // writer would block the fresh compile with its recovery warning.
            if (recoveryJson(dir) === null) applyBundle(cached);
          } catch {
            // The compile lands next, with a toast of its own if it must.
          }
        }
      }

      const [result] = await Promise.all([compiling, loading]);
      if (disposed || current !== generation) return;

      await writer?.settleForReload();
      if (disposed || current !== generation) return;
      if (compiledRevision !== revision) return loadProject();

      // A broken edit keeps the last good render on the canvas.
      if (!result.ok) {
        setEditorLoadState({ world, status: "error", error: `Project failed to compile: ${result.error}` });
        console.error('[projects] compile failed:', result.error);
        toast.error('Project failed to compile', { description: result.error });
        return;
      }

      try {
        applyBundle(result.code);
        hasFreshBundle = true;
        setEditorLoadState({ world, status: "ready", mountedFrame: engine.frame() });
        // What an export renders a second time, and the next open's head
        // start (see `rememberProjectBundle`) — recorded only once it has
        // actually mounted, so the record never runs ahead of the canvas.
        rememberProjectBundle(untrack(project.id), result.code).catch((error) =>
          console.error('[projects] could not save the bundle', error));
      } catch (error) {
        setEditorLoadState({ world, status: "error", error: `Project failed to render: ${error instanceof Error ? error.message : String(error)}` });
        console.error('[projects] render failed:', error);
        toast.error('Project failed to render', { description: (error as Error).message });
      }
    };

    const load = (): void => {
      const current = generation + 1;
      loadProject().catch((error) => {
        if (disposed || current !== generation) return;
        setEditorLoadState({ world, status: "error", error: `Project failed to load: ${error instanceof Error ? error.message : String(error)}` });
        console.error('[projects] load failed:', error);
        toast.error('Project failed to load', { description: (error as Error).message });
      });
    };

    setReload(() => loadProject);
    load();

    let lastPreviewScale = untrack(config.previewScale);
    createEffect(() => {
      const scale = config.previewScale();
      if (scale === lastPreviewScale) return;
      lastPreviewScale = scale;
      untrack(() => {
        for (const asset of library.list()) invalidateAssetFile(asset);
        clearVideoTrackCache();
        const root = world.get(Root);
        if (root) disposeDecoders(world, root);
      });
    });

    createEffect(() => {
      const frameRate = config.frameRate();
      if (mounted && frameRate !== world.get(FrameRate)?.value) load();
    });
  
    let checkpointRevision = 0;
    let checkpointing = false;
    const recoveryTimer = setInterval(() => {
      if (disposed || checkpointing || !mounted || revision === checkpointRevision) return;
      checkpointing = true;
      const savedRevision = revision;
      void (async () => {
        // A failed save must not prevent backing up the files and pending journal.
        const saves = await Promise.allSettled([writer?.settle(), library.settle(), config.settle()]);
        if (disposed) return;
        const journal = getProjectRecovery(world);
        const saveErrors = saves.flatMap((save) => save.status === 'rejected'
          ? [save.reason instanceof Error ? save.reason.message : String(save.reason)] : []);
        await mainBridge.call(MAIN_CHANNELS.CHECKPOINTS_CREATE_RECOVERY, {
          dir, editorRecovery: journal || saveErrors.length ? { journal, saveErrors } : undefined,
        });
        checkpointRevision = savedRevision;
      })().catch((error: unknown) => {
        toast.error('Could not save a recovery checkpoint', { description: error instanceof Error ? error.message : String(error) });
      }).finally(() => { checkpointing = false; });
    }, 5 * 60 * 1000);

    const unwatch = watchProject(dir, (paths) => {
      const changed = paths.filter((path) => !isCacheFile(path));
      if (!changed.length) return;
      if (changed.every((path) => isLibraryFile(path) && !isProjectSourceFile(path))) {
        void library.load().catch((error: unknown) => {
          toast.error('Could not refresh media', { description: error instanceof Error ? error.message : String(error) });
        });
      } else {
        // package.json is the config and the record (`main`, `displayName`)
        // in one, so a hand edit to it reloads both; the app's own config
        // writes never reach here (main keeps them from the watcher).
        if (changed.some(isProjectConfigFile)) {
          void config.load().then(load).catch((error: unknown) => {
            toast.error('Could not load project settings', { description: error instanceof Error ? error.message : String(error) });
          });
          void project.refresh();
          return;
        }
        load();
      }
    });

    onCleanup(() => {
      disposed = true;
      clearInterval(recoveryTimer);
      setEditorLoadState((state) => state?.world === world ? null : state);
      captureProjectCover(dir, engine.snapshot());
      refreshProject(dir);
      unwatch();
      unmount();
      config.dispose();
      library.dispose();
    });
  });

  // The left column follows the sidebar's tab (264 px on Assets, 340 px on
  // Chat) and animates between the two — except on load, where the stored
  // tab is read before first paint and the transition only comes on after
  // the first frame. Toggling `uiVisible` changes the track count, which
  // Chromium does not interpolate, so that still snaps as before.
  const [animateColumns, setAnimateColumns] = createSignal(false);
  onMount(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    requestAnimationFrame(() => requestAnimationFrame(() => setAnimateColumns(true)));
  });

  const timelineStyles = createMemo(() => {
    if (!uiVisible()) return;

    const height = timelineMinimized() ? RULER_HEIGHT : visibleTimelineHeight();

    return {
      'grid-template-columns': `${panels().left}px 1px minmax(0, 1fr) 1px 264px`,
      'grid-template-rows': `minmax(0, 1fr) 1px ${height}px`,
      ...(animateColumns() ? { transition: 'grid-template-columns 200ms ease-out' } : {}),
    };
  });

  if (localMode) return <FocusEditor width={viewportWidth()} height={viewportHeight()} onReload={() => reload()()} />;

  return (
    <div
      class="bg-sidebar h-screen w-full overflow-hidden grid"
      classList={{
        'grid-cols-[1fr]': !uiVisible(),
        'grid-rows-[1fr]': !uiVisible(),
      }}
      style={timelineStyles()}
    >
      <Show when={isDesktop && !isFullscreen()}>
        <div class="fixed top-0 left-0 right-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <Show when={uiVisible()}>
        <SidebarLeft />
        <PanelResizer edge="left" label="Left panel width" value={panels().left} min={MIN_PANEL_WIDTH} max={panels().leftMax} onChange={setLeftPanelWidth} />
      </Show>
      <Canvas><div class="flex min-w-0 items-start justify-end gap-2"><PreviewControls /><ProjectSaveStatus onReload={() => reload()()} /></div></Canvas>
      <MediaPortability />
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <Inspector />
      </Show>
      <Show when={uiVisible()}>
        <Show when={!timelineMinimized()} fallback={<div class="col-span-full bg-border-strong" />}>
          <PanelResizer edge="bottom" label="Timeline height" value={visibleTimelineHeight()} min={MIN_TIMELINE_HEIGHT} max={maxTimelineHeight()} onChange={setTimelineHeight} class="col-span-full" />
        </Show>
      </Show>
      <Show when={uiVisible()}>
        <Layers />
        <PanelResizer edge="left" label="Layers panel width" value={panels().left} min={MIN_PANEL_WIDTH} max={panels().leftMax} onChange={setLeftPanelWidth} />
      </Show>
      <Show when={uiVisible()}>
        <Timeline />
      </Show>
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <Show when={!timelineMinimized()}>
          <Soundboard />
        </Show>
      </Show>
      <Show when={!uiVisible()}>
        <FloatingProjectHeader />
      </Show>
    </div>
  );
}
