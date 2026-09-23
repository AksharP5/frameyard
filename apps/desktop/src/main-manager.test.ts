import { ipcMain } from "electron";
import { expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { MAIN_CHANNELS, MAIN_WIRE } from "./main-channels";
import { mainBridge } from "./main-manager";

vi.mock("electron", () => ({ ipcMain: { on: vi.fn() } }));

it("accepts main-window requests and ignores other senders and malformed messages", async () => {
  const trusted = { isDestroyed: () => false, send: vi.fn() };
  const other = { isDestroyed: () => false, send: vi.fn() };
  const handler = vi.fn(() => true);
  mainBridge.authorizeSender((event) => event.sender === (trusted as unknown as WebContents));
  mainBridge.handle(MAIN_CHANNELS.WINDOW_IS_FULLSCREEN, handler);

  const listener = vi.mocked(ipcMain.on).mock.calls.find(([channel]) => channel === MAIN_WIRE.REQUEST)?.[1];
  expect(listener).toBeDefined();
  const request = { id: "one", channel: MAIN_CHANNELS.WINDOW_IS_FULLSCREEN, data: undefined };
  await listener!({ sender: other } as never, request);
  await listener!({ sender: trusted } as never, null as never);
  expect(handler).not.toHaveBeenCalled();
  expect(other.send).not.toHaveBeenCalled();

  await listener!({ sender: trusted } as never, request);
  expect(handler).toHaveBeenCalledOnce();
  expect(trusted.send).toHaveBeenCalledWith(MAIN_WIRE.RESPONSE, { id: "one", ok: true, data: true });
});
