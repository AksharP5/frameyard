import { describe, expect, it, vi } from "vitest";

vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: vi.fn() }));
vi.mock("../lib/outputs", () => ({ storeAt: vi.fn() }));
const prepare = vi.hoisted(() => vi.fn());
vi.mock("./models", () => ({ localModels: { "sam-2.1": { prepare } } }));

import { startLocalJob } from "./jobs";
import type { ToolContext } from "../handler";
import type { LocalPlan } from "./model";

function context(controller: AbortController): ToolContext {
  return {
    signal: controller.signal,
    awaitTracking: true,
    session: () => null,
    requireSession: () => { throw new Error("No project"); },
    app: {
      openProject: async () => { throw new Error("Unused"); },
      user: () => null,
      requireUser: () => { throw new Error("Unused"); },
    },
  };
}

const request = { model: "sam-2.1", video: { path: "/clip.mp4" }, time: 0, points: [{ x: 0.5, y: 0.5 }] } as const;
const target = { kind: "disk", path: null } as const;

describe("local job workspace ownership", () => {
  it("keeps a workspace call pending until the GPU job completes", async () => {
    let finish!: (result: Awaited<ReturnType<LocalPlan["run"]>>) => void;
    prepare.mockResolvedValue({ etaSeconds: 1, run: () => new Promise((resolve) => { finish = resolve; }) } satisfies LocalPlan);
    let returned = false;
    const call = startLocalJob(request, target, context(new AbortController())).then((result) => { returned = true; return result; });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(returned).toBe(false);
    finish({ files: [] });
    expect(await call).toMatchObject({ job: { status: "succeeded", assets: [] } });
  });

  it("does not start GPU work for a workspace call already canceled", async () => {
    const run = vi.fn(async () => ({ files: [] }));
    prepare.mockResolvedValue({ etaSeconds: 1, run } satisfies LocalPlan);
    const controller = new AbortController();
    controller.abort("Workspace canceled");
    expect(await startLocalJob(request, target, context(controller))).toMatchObject({ job: { status: "canceled" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("cancels the running model before a canceled workspace call releases ownership", async () => {
    const controller = new AbortController();
    let runningSignal: AbortSignal | undefined;
    prepare.mockResolvedValue({
      etaSeconds: 1,
      run: ({ signal }) => new Promise((_, reject) => {
        runningSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    } satisfies LocalPlan);
    const call = startLocalJob(request, target, context(controller));
    await vi.waitFor(() => expect(runningSignal).toBeDefined());
    controller.abort("Workspace canceled");
    expect(await call).toMatchObject({ job: { status: "canceled", error: { code: "CANCELED" } } });
    expect(runningSignal!.aborted).toBe(true);
  });
});
