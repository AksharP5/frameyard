import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", isPackaged: true },
  utilityProcess: { fork: vi.fn() },
}));

import { utilityProcess } from "electron";
import { startAgentChat, stopAgentChat } from "./agent-chat";

class Process extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => this.emit("exit", 0));
}
let child: Process;
afterEach(() => {
  stopAgentChat();
  child?.emit("exit", 0);
  vi.clearAllMocks();
});

function start(prepareTurn: (input: { cwd: string; text: string }) => Promise<() => void>) {
  child = new Process();
  vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as ReturnType<typeof utilityProcess.fork>);
  startAgentChat({ dataDir: "/data", mcpUrl: null, version: "test", prepareTurn });
  child.emit("message", { type: "prepare-turn", id: "turn", cwd: "/project", text: "Edit" });
  return child;
}

it.each(["release", "exit"])("releases the project on host %s", async (ending) => {
  const release = vi.fn();
  const prepare = vi.fn(async () => release);
  const proc = start(prepare);
  await vi.waitFor(() => expect(proc.postMessage).toHaveBeenCalledWith({ type: "turn-prepared", id: "turn" }));
  expect(prepare).toHaveBeenCalledWith({ cwd: "/project", text: "Edit" });
  if (ending === "release") proc.emit("message", { type: "release-turn", id: "turn" });
  else proc.emit("exit", 1);
  expect(release).toHaveBeenCalledTimes(1);
});

it("releases preparation that finishes after the host exits", async () => {
  const pending = Promise.withResolvers<() => void>();
  const release = vi.fn();
  const proc = start(() => pending.promise);
  proc.emit("exit", 1);
  pending.resolve(release);
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(proc.postMessage).not.toHaveBeenCalled();
});

it("returns checkpoint failures to the host without acknowledging a ready turn", async () => {
  const proc = start(async () => { throw new Error("Checkpoint failed"); });
  await vi.waitFor(() => expect(proc.postMessage).toHaveBeenCalledWith({
    type: "turn-prepared", id: "turn", error: "Checkpoint failed",
  }));
  expect(proc.postMessage).toHaveBeenCalledTimes(1);
});
