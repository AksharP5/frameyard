/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PromptInput } from "../genai/prompt-input";
import { ActionBar } from "../genai/action-bar";
import { For, Show } from "solid-js";
import { Tool, ToolType } from "@diffusionstudio/runtime";
import { useWorld } from "@diffusionstudio/koota-solid";
import { useTool } from "@/engine";
import { usePromptInput } from "@/context/prompt-input";
import { localMode } from "@/lib/local-mode";

const canvasTools = [
  {
    type: ToolType.MOVE,
    icon: "move",
    label: "Move",
    shortcut: "V",
    description: "Move. Alt-click to select overlapping layers",
  },
  {
    type: ToolType.HAND,
    icon: "hand",
    label: "Hand",
    shortcut: "H",
    description: "Pan the canvas",
  },
  {
    type: ToolType.SCENE,
    icon: "frame",
    label: "Frame",
    shortcut: "F",
    description: "Frame",
  },
  {
    type: ToolType.RECT,
    icon: "tool.rectangle",
    label: "Rectangle",
    shortcut: "R",
    description: "Rectangle",
  },
  {
    type: ToolType.TEXT,
    icon: "tool.text",
    label: "Text",
    shortcut: "T",
    description: "Text",
  },
] as const;

export function Toolbar() {
  const {
    promptInputOpen,
    promptInputConfig,
    openPromptInput,
    setPromptInputOpen,
  } = usePromptInput();

  return (
    <>
      <Show when={promptInputOpen() && !localMode}>
        <PromptInput initialConfig={promptInputConfig()} />
      </Show>
      <Show when={!promptInputOpen()}>
        <ActionBar openPromptInput={openPromptInput} />
      </Show>
      <Show when={!localMode}>
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl p-1.5 bg-background border border-border-strong flex gap-1 items-center z-10">
          <CanvasTools />
          <Separator
            orientation="vertical"
            class="data-[orientation=vertical]:h-5 rounded-md"
          />
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon-square"
              class={
                promptInputOpen() ? "text-foreground" : "text-muted-foreground"
              }
              variant={promptInputOpen() ? "default" : "ghost"}
              onClick={() => setPromptInputOpen(!promptInputOpen())}
            >
              <Icon name="ai-generate" class="size-7" />
            </TooltipTrigger>
            <TooltipContent>AI generate</TooltipContent>
          </Tooltip>
        </div>
      </Show>
    </>
  );
}

export function CanvasTools(props: { rail?: boolean }) {
  const world = useWorld();
  const selectedTool = useTool();

  const handleToolChange = (tool: ToolType) => {
    world.set(Tool, { value: tool });
  };

  return (
    <div
      role="group"
      aria-label="Canvas tools"
      class={props.rail ? "focus-canvas-tools" : "flex items-center gap-1"}
    >
      <For each={canvasTools}>
        {(tool) => (
          <>
            <Show when={!props.rail && tool.type === ToolType.SCENE}>
              <Separator orientation="vertical" class="min-h-5 mx-1" />
            </Show>
            <Tooltip placement={props.rail ? "right" : "top"}>
              <TooltipTrigger
                as={Button}
                size="icon-square"
                aria-label={tool.label}
                aria-keyshortcuts={tool.shortcut}
                aria-pressed={selectedTool() === tool.type}
                class={
                  props.rail
                    ? "focus-tool"
                    : selectedTool() === tool.type
                      ? "text-foreground"
                      : "text-muted-foreground"
                }
                variant={selectedTool() === tool.type ? "default" : "ghost"}
                onClick={() => handleToolChange(tool.type)}
              >
                <Icon
                  name={tool.icon}
                  class={props.rail ? "size-6" : "size-5"}
                />
                <Show when={props.rail}>
                  <span>{tool.label}</span>
                </Show>
              </TooltipTrigger>
              <TooltipContent shortcut={tool.shortcut}>
                {tool.description}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </For>
    </div>
  );
}
