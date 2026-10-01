import { expect, it, vi } from "vitest";
import { window as windowTool } from "./window";
import type { MainContext } from "../handler";

it("reports and changes window visibility through the host", async () => {
  let visible = false;
  const show = vi.fn(async () => { visible = true; });
  const hide = vi.fn(() => { visible = false; });
  const ctx: MainContext = {
    signal: new AbortController().signal,
    logs: () => [],
    version: "test",
    runAgentTool: async () => ({ success: false, contentItems: [] }),
    window: { visible: () => visible, show, hide },
  };

  expect(await windowTool({}, ctx)).toEqual({ visible: false });
  expect(await windowTool({ visible: true }, ctx)).toEqual({ visible: true });
  expect(await windowTool({ visible: false }, ctx)).toEqual({ visible: false });
  expect(show).toHaveBeenCalledOnce();
  expect(hide).toHaveBeenCalledOnce();
});
