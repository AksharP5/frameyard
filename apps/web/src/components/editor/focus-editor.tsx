/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { Name, ToolType, isText } from "@diffusionstudio/runtime";
import { useLayout, MIN_TIMELINE_HEIGHT } from "@/context/layout";
import { useProject } from "@/context/project";
import { useEditorApi } from "@/dapi";
import {
  useActiveScene,
  useDerived,
  useSelection,
  useTimelineIndex,
  useTool,
} from "@/engine/hooks";
import { getEditHistory } from "@/engine/history";
import { RULER_HEIGHT } from "@/engine/timeline";
import { Canvas } from "@/components/canvas";
import { CanvasTools } from "@/components/canvas/toolbar";
import { PreviewControls } from "@/components/canvas/preview-controls";
import { Layers, Timeline } from "@/components/timeline";
import { Assets } from "@/components/sidebar-left/assets";
import {
  ProjectHeader,
  FloatingProjectHeader,
} from "@/components/sidebar-left/sidebar-left";
import { FileExportMenu } from "@/components/sidebar-left/project-menu/file-menu";
import { ProjectSaveStatus } from "@/components/project-save-status";
import { MediaPortability } from "@/components/media-portability";
import { AgentPanel } from "@/components/agent/agent-panel";
import { sidebarTab, setSidebarTab } from "@/agent-chat";
import type { ChatDraft } from "@/components/agent/chat-draft";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PanelResizer } from "@/components/ui/panel-resizer";
import { Transport } from "./transport";
import "./focus-editor.css";

const HEADER_HEIGHT = 62;
const RAIL_WIDTH = 72;
const MIN_PREVIEW_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 300;
const MIN_LIBRARY_WIDTH = 220;

export function FocusEditor(props: {
  width: number;
  height: number;
  onReload: () => Promise<void>;
}) {
  const world = useWorld();
  const project = useProject();
  const history = getEditHistory(world);
  const index = useTimelineIndex();
  const selected = useSelection();
  const tool = useTool();
  const activeScene = useActiveScene();
  const sceneName = useDerived(
    () => index().root?.get(Name)?.value || "Canvas",
  );
  const layout = useLayout();
  const { isDesktop, isFullscreen } = useEditorApi();
  const [workspaceOpen, setWorkspaceOpen] = createSignal(true);
  let navigateWorkspace: ((tab: ChatDraft["tab"]) => void) | undefined;
  const maxWorkspaceWidth = () =>
    Math.max(
      MIN_WORKSPACE_WIDTH,
      props.width - RAIL_WIDTH - MIN_PREVIEW_WIDTH - 24,
    );
  const workspaceWidth = () =>
    Math.max(
      MIN_WORKSPACE_WIDTH,
      Math.min(maxWorkspaceWidth(), layout.agentWidth()),
    );
  const availablePreviewWidth = () =>
    props.width - RAIL_WIDTH - (workspaceOpen() ? workspaceWidth() + 24 : 12);
  const libraryOverlay = () =>
    availablePreviewWidth() < MIN_LIBRARY_WIDTH + 12 + MIN_PREVIEW_WIDTH;
  const maxLibraryWidth = () =>
    Math.max(
      MIN_LIBRARY_WIDTH,
      availablePreviewWidth() - MIN_PREVIEW_WIDTH - 12,
    );
  const layersWidth = () =>
    Math.max(160, Math.min(props.width / 3, layout.leftPanelWidth()));
  const libraryWidth = () =>
    libraryOverlay()
      ? Math.min(300, availablePreviewWidth())
      : Math.max(
          MIN_LIBRARY_WIDTH,
          Math.min(maxLibraryWidth(), layout.leftPanelWidth()),
        );
  const maxTimelineHeight = () =>
    Math.max(MIN_TIMELINE_HEIGHT, props.height - HEADER_HEIGHT - 200);
  const timelineHeight = () =>
    layout.timelineMinimized()
      ? RULER_HEIGHT
      : Math.max(
          MIN_TIMELINE_HEIGHT,
          Math.min(maxTimelineHeight(), layout.timelineHeight()),
        );
  const showWorkspace = (tab: ChatDraft["tab"]) => {
    setWorkspaceOpen(true);
    navigateWorkspace?.(tab);
  };
  createEffect(
    on(
      [selected.first, tool],
      ([entity, selectedTool]) => {
        if (entity && (isText(entity) || selectedTool === ToolType.TEXT_EDIT))
          showWorkspace("Editor");
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      activeScene,
      (scene) => {
        if (scene && layout.timelineMinimized()) layout.toggleTimeline();
      },
      { defer: true },
    ),
  );
  const styles = createMemo(() => ({
    width: `${props.width}px`,
    height: `${props.height}px`,
    "grid-template-columns": layout.uiVisible()
      ? `60px minmax(0, 1fr) ${workspaceOpen() ? `12px ${workspaceWidth()}px` : "0px 0px"}`
      : "minmax(0, 1fr)",
    "grid-template-rows": layout.uiVisible()
      ? `${HEADER_HEIGHT}px minmax(200px, 1fr) 1px ${timelineHeight()}px`
      : "minmax(0, 1fr)",
  }));

  return (
    <div class="h-screen w-full overflow-auto">
      <main
        class="focus-editor"
        classList={{ "focus-ui-hidden": !layout.uiVisible() }}
        style={styles()}
      >
        <header
          class="focus-project-bar"
          style={{
            "-webkit-app-region":
              isDesktop && !isFullscreen() ? "drag" : "no-drag",
          }}
        >
          <div class="focus-project-identity">
            <ProjectHeader class="focus-project-name" wordmark />
            <div class="focus-history">
              <Button
                variant="ghost"
                size="icon-square"
                aria-label="Undo"
                title="Undo"
                disabled={!history.canUndo()}
                onClick={() => history.undo()}
              >
                <Icon name="undo" />
              </Button>
              <Button
                variant="ghost"
                size="icon-square"
                aria-label="Redo"
                title="Redo"
                disabled={!history.canRedo()}
                onClick={() => history.redo()}
              >
                <Icon name="undo" class="-scale-x-100" />
              </Button>
            </div>
            <ProjectSaveStatus onReload={props.onReload} />
          </div>
          <div class="focus-project-actions">
            <Button
              variant="ghost"
              class="gap-1.5"
              onClick={() => showWorkspace("Chat")}
            >
              <Icon name="ask-chat" />
              Assistant
            </Button>
            <Button
              variant="ghost"
              size="icon-square"
              aria-label={workspaceOpen() ? "Hide inspector" : "Show inspector"}
              onClick={() => setWorkspaceOpen((value) => !value)}
            >
              <Icon name="sidebar-right" />
            </Button>
            <DropdownMenu placement="bottom-end">
              <DropdownMenuTrigger
                as={Button}
                class="focus-export"
                aria-label="Export scene"
              >
                <span>Export</span>
                <Icon name="download" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent>
                  <FileExportMenu />
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </div>
        </header>
        <nav class="focus-tool-rail" aria-label="Editor tools">
          <Button
            variant="ghost"
            class="focus-tool"
            aria-label="Show media"
            aria-pressed={layout.libraryOpen()}
            onClick={() => layout.setLibraryOpen(!layout.libraryOpen())}
          >
            <Icon name="view.grid" />
            <span>Media</span>
          </Button>
          <Button
            variant="ghost"
            class="focus-tool"
            aria-label="Toggle timeline"
            aria-pressed={!layout.timelineMinimized()}
            onClick={layout.toggleTimeline}
          >
            <Icon name="sequence" />
            <span>Timeline</span>
          </Button>
          <div class="focus-rail-divider" />
          <CanvasTools rail />
        </nav>
        <div class="focus-workarea">
          <aside
            class="focus-library"
            classList={{
              hidden: !layout.libraryOpen() || !layout.uiVisible(),
              "focus-library-overlay": libraryOverlay(),
            }}
            style={{ width: `${libraryWidth()}px` }}
            aria-label="Project media"
          >
            <div class="focus-library-heading">
              <span>Project media</span>
              <Button
                variant="ghost"
                size="icon-square"
                aria-label="Hide media"
                onClick={() => layout.setLibraryOpen(false)}
              >
                <Icon name="close-remove" />
              </Button>
            </div>
            <Assets showTabs={false} />
          </aside>
          <div class="focus-preview">
            <div class="focus-preview-heading">
              <span class="focus-breadcrumb">
                <span>{sceneName()}</span>
                <Icon name="chevron-right" />
                <strong>Preview</strong>
              </span>
              <PreviewControls />
            </div>
            <div class="focus-canvas">
              <Canvas />
            </div>
            <Transport />
          </div>
        </div>
        <MediaPortability />
        <Show when={layout.uiVisible() && workspaceOpen()}>
          <PanelResizer
            edge="right"
            label="Right panel width"
            value={workspaceWidth()}
            min={MIN_WORKSPACE_WIDTH}
            max={maxWorkspaceWidth()}
            onChange={layout.setAgentWidth}
            class="focus-workspace-resizer"
          />
        </Show>
        <div
          class="focus-workspace"
          classList={{ hidden: !workspaceOpen() || !layout.uiVisible() }}
        >
          <Show when={project.dir()} keyed>
            {(_dir) => (
              <AgentPanel
                open={layout.uiVisible() && workspaceOpen()}
                onNavigationReady={(navigate) => {
                  navigateWorkspace = navigate;
                  if (navigate && sidebarTab() === "chat") {
                    showWorkspace("Chat");
                    setSidebarTab("assets");
                  }
                }}
              />
            )}
          </Show>
        </div>
        <Show when={layout.uiVisible()}>
          <Show
            when={!layout.timelineMinimized()}
            fallback={<div class="focus-timeline-resizer bg-border-strong" />}
          >
            <PanelResizer
              edge="bottom"
              label="Timeline height"
              value={timelineHeight()}
              min={MIN_TIMELINE_HEIGHT}
              max={maxTimelineHeight()}
              onChange={layout.setTimelineHeight}
              class="focus-timeline-resizer"
            />
          </Show>
          <section
            class="focus-timeline"
            aria-label="Timeline"
            style={{
              "grid-template-columns": `${layersWidth()}px 1px minmax(0, 1fr)`,
            }}
          >
            <Layers showTransport={false} />
            <PanelResizer
              edge="left"
              label="Layers panel width"
              value={layersWidth()}
              min={160}
              max={Math.max(160, props.width / 3)}
              onChange={layout.setLeftPanelWidth}
            />
            <Timeline />
          </section>
        </Show>
        <Show when={!layout.uiVisible()}>
          <FloatingProjectHeader />
        </Show>
      </main>
    </div>
  );
}
