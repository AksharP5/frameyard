/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import { assert } from "@/utils";
import { createStoredSignal } from "@/lib/store";
import { store } from "@/init";
import type { TimeFormat } from "@/components/timeline/time-format";

type LayoutContextValue = {
  uiVisible: Accessor<boolean>;
  timelineMinimized: Accessor<boolean>;
  timelineHeight: Accessor<number>;
  setTimelineHeight(height: number): void;
  leftPanelWidth: Accessor<number>;
  setLeftPanelWidth(width: number): void;
  inspectorWidth: Accessor<number>;
  setInspectorWidth(width: number): void;
  agentWidth: Accessor<number>;
  setAgentWidth(width: number): void;
  libraryOpen: Accessor<boolean>;
  setLibraryOpen(open: boolean): void;
  timeFormat: Accessor<TimeFormat>;
  setTimeFormat(format: TimeFormat): void;
  toggleUI(): void;
  toggleTimeline(): void;
};

const LayoutContext = createContext<LayoutContextValue>();

export const MIN_TIMELINE_HEIGHT = 120;
export const DEFAULT_TIMELINE_HEIGHT = 234;

export function LayoutProvider(props: { children: JSX.Element }) {
  const [uiVisible, setUiVisible] = createStoredSignal(
    store.define<boolean>("layout.uiVisible", true),
  );

  const [timelineHeight, setTimelineHeight] = createStoredSignal(
    store.define<number>("layout.timelineHeight", DEFAULT_TIMELINE_HEIGHT),
  );
  const [timelineMinimized, setTimelineMinimized] = createStoredSignal(
    store.define<boolean>("layout.timelineMinimized", false),
  );
  const [leftPanelWidth, setLeftPanelWidth] = createStoredSignal(
    store.define<number>("layout.leftPanelWidth", 264),
  );
  const [inspectorWidth, setInspectorWidth] = createStoredSignal(
    store.define<number>("layout.inspectorWidth", 264),
  );
  const [agentWidth, setAgentWidth] = createStoredSignal(
    store.define<number>("layout.agentWidth", 384),
  );

  const [libraryOpen, setLibraryOpen] = createStoredSignal(
    store.define<boolean>("layout.libraryOpen", false),
  );
  const [timeFormat, setTimeFormat] = createStoredSignal(
    store.define<TimeFormat>("timeline.timeFormat", "standard"),
  );

  const toggleUI = () => setUiVisible(!uiVisible());
  const toggleTimeline = () => setTimelineMinimized(!timelineMinimized());

  return (
    <LayoutContext.Provider
      value={{
        uiVisible,
        timelineMinimized,
        timelineHeight,
        setTimelineHeight,
        leftPanelWidth,
        setLeftPanelWidth,
        inspectorWidth,
        setInspectorWidth,
        agentWidth,
        setAgentWidth,
        libraryOpen,
        setLibraryOpen,
        timeFormat,
        setTimeFormat,
        toggleUI,
        toggleTimeline,
      }}
    >
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  assert(ctx, "useLayout must be used within LayoutProvider");
  return ctx;
}
