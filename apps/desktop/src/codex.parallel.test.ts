import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  notify: (_method: string, _params: Record<string, unknown>) => {},
  requests: [] as { method: string; params: Record<string, unknown> }[],
}));
vi.mock("./checkpoints", () => ({ createCheckpoint: async () => ({ id: "00000000-0000-4000-8000-000000000001" }) }));
vi.mock("./codex-protocol", async importOriginal => {
  const original = await importOriginal<typeof import("./codex-protocol")>();
  let counter = 0;
  return { ...original, CodexAppServer: class {
    constructor(options: { notification: typeof fake.notify }) { fake.notify = options.notification; }
    async request(method: string, params: Record<string, unknown>) {
      fake.requests.push({ method, params });
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") return { thread: { id: `thread-${++counter}`, cwd: params.cwd, turns: [] } };
      if (method === "turn/start") {
        const turn = { id: `turn-${params.threadId}` };
        fake.notify("turn/started", { threadId: params.threadId, turn });
        return { turn };
      }
      if (method === "turn/interrupt") { fake.notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } }); return {}; }
      throw new Error(`Unexpected method ${method}`);
    }
    dispose() {}
  } };
});
import { CodexService } from "./codex";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); fake.requests.length = 0; });

it("runs three native Codex projects independently and cancels only one", async () => {
  const root = await mkdtemp(join(tmpdir(), "frameyard-codex-parallel-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = [join(root,"a"),join(root,"b"),join(root,"c")];
  await Promise.all(dirs.map(dir=>mkdir(dir)));
  const event = vi.fn();
  const service = new CodexService({ dataDir: root, onEvent: event, runTool: async () => ({ success: true, contentItems: [] }) });
  const turns = await Promise.all(dirs.map(dir => service.request({ method: "send", input: { dir, text: "Build this video", context: {} } })));
  expect(turns.every(turn=>turn.method === "send")).toBe(true);
  expect(fake.requests.filter(request=>request.method === "turn/start")).toHaveLength(3);
  await expect(service.request({ method: "send", input: { dir: dirs[0]!, text:"Again", context:{} } })).rejects.toThrow("already working");
  await service.request({ method: "cancel", input: { dir: dirs[1]! } });
  await vi.waitFor(()=>expect(event).toHaveBeenCalledWith(expect.objectContaining({ dir:dirs[1],type:"turn",status:"interrupted" })));
  for (const dir of [dirs[0]!,dirs[2]!]) await expect(service.request({ method:"new",input:{dir} })).rejects.toThrow("already working");
  service.dispose();
});
