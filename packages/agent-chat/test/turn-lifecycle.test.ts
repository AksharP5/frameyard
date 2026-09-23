import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { AgentHost, type AgentHostOptions } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import { FakeHarness } from "../src/host/fake";
import type { HostMsg } from "../src/protocol";

async function fixture(prepareTurn: AgentHostOptions["prepareTurn"]) {
  const dir = await mkdtemp(join(tmpdir(), "chat-lifecycle-"));
  const harness = new FakeHarness({ tickMs: 1 });
  const store = new ChatStore(dir);
  const host = new AgentHost({
    store, harnesses: [harness],
    env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null,
    version: "test", prepareTurn,
  });
  await host.start();
  onTestFinished(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  const messages: HostMsg[] = [];
  const connection = { send: (message: HostMsg) => { messages.push(message); } };
  const send = (text: string, options: { chatId?: string; cwd?: string } = {}) => host.handle(connection, "turn.send", {
    projectId: "project", cwd: "/project", model: { harness: "claude", model: "fake-fast" }, text,
    ...options,
  });
  return { host, harness, store, messages, connection, send };
}

it("waits for project preparation before opening the harness and releases after completion", async () => {
  const ready = Promise.withResolvers<() => void>();
  const release = vi.fn();
  const prepare = vi.fn(() => ready.promise);
  const f = await fixture(prepare);
  await f.send("Edit the video");
  expect(prepare).toHaveBeenCalledWith({ cwd: "/project", text: "Edit the video" });
  expect(f.harness.sessions).toHaveLength(0);
  ready.resolve(release);
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(f.harness.sessions).toHaveLength(1);
});

it("checkpoint failure never opens the harness", async () => {
  const f = await fixture(async () => { throw new Error("Checkpoint failed"); });
  await f.send("Edit the video");
  await vi.waitFor(() => expect(f.messages.some((message) => message.t === "event"
    && message.event.type === "turn.completed" && message.event.status === "failed"
    && message.event.error === "Checkpoint failed")).toBe(true));
  expect(f.harness.sessions).toHaveLength(0);
});

it.each(["fail the turn", "slow reply"])("releases the project after %s", async (text) => {
  const release = vi.fn();
  const f = await fixture(async () => release);
  const { chatId } = await f.send(text);
  if (text.startsWith("slow")) {
    await vi.waitFor(() => expect(f.harness.sessions).toHaveLength(1));
    await f.host.handle(f.connection, "turn.interrupt", { chatId });
  }
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
});

it("interrupting during checkpoint preparation releases without starting a harness", async () => {
  const ready = Promise.withResolvers<() => void>();
  const release = vi.fn();
  const f = await fixture(() => ready.promise);
  const { chatId } = await f.send("Edit the video");
  const interrupted = f.host.handle(f.connection, "turn.interrupt", { chatId });
  ready.resolve(release);
  await interrupted;
  expect(f.harness.sessions).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it("interrupting while the harness opens prevents its first send", async () => {
  const ready = Promise.withResolvers<void>();
  const release = vi.fn();
  const f = await fixture(async () => release);
  const open = f.harness.open.bind(f.harness);
  const send = vi.fn();
  vi.spyOn(f.harness, "open").mockImplementation(async (options) => {
    const session = await open(options);
    session.send = send;
    await ready.promise;
    return session;
  });
  const { chatId } = await f.send("Edit the video");
  await vi.waitFor(() => expect(f.harness.sessions).toHaveLength(1));
  const interrupted = f.host.handle(f.connection, "turn.interrupt", { chatId });
  ready.resolve();
  await interrupted;
  expect(send).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it("rejects a second send while the existing chat is saving its next turn", async () => {
  const release = vi.fn();
  const f = await fixture(async () => release);
  const { chatId } = await f.send("First turn");
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const write = f.store.writeMeta.bind(f.store);
  vi.spyOn(f.store, "writeMeta").mockImplementationOnce(async (meta) => {
    entered.resolve();
    await ready.promise;
    await write(meta);
  });
  const first = f.send("Second turn", { chatId });
  await entered.promise;
  const second = f.send("Overlapping turn", { chatId }).then(() => "accepted", (error: Error) => error.message);
  ready.resolve();
  await first;
  expect(await second).toMatch(/already running/);
});

it("reopens a live harness in the renamed project directory before its next turn", async () => {
  const release = vi.fn();
  const prepare = vi.fn(async () => release);
  const f = await fixture(prepare);
  const { chatId } = await f.send("First turn");
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  await f.send("Second turn", { chatId, cwd: "/renamed" });
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  expect(prepare).toHaveBeenLastCalledWith({ cwd: "/renamed", text: "Second turn" });
  expect(f.harness.sessions.at(-1)?.opened.cwd).toBe("/renamed");
});

it("a failed initial save does not leave the existing chat reserved", async () => {
  const release = vi.fn();
  const f = await fixture(async () => release);
  const { chatId } = await f.send("First turn");
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  vi.spyOn(f.store, "writeMeta").mockRejectedValueOnce(new Error("Disk is full"));
  await expect(f.send("Unsent turn", { chatId })).rejects.toThrow("Disk is full");
  await expect(f.send("Retried turn", { chatId })).resolves.toEqual({ chatId });
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
});

it("a final metadata save failure releases the project and leaves the chat usable", async () => {
  const release = vi.fn();
  const f = await fixture(async () => release);
  const write = f.store.writeMeta.bind(f.store);
  let fail = true;
  vi.spyOn(f.store, "writeMeta").mockImplementation(async (meta) => {
    if (meta.status === "idle" && fail) { fail = false; throw new Error("Disk is full"); }
    await write(meta);
  });
  const { chatId } = await f.send("First turn");
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(f.messages.some((message) => message.t === "event" && message.event.type === "item.completed"
    && message.event.item.kind === "notice" && message.event.item.text === "Could not save chat: Disk is full")).toBe(true);
  await expect(f.send("Second turn", { chatId })).resolves.toEqual({ chatId });
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
});
