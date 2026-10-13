import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused", getVersion: () => "0.211.0" },
}));
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("No install marker")),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { stat, writeFile } from "node:fs/promises";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it.each([undefined, "true"])("does not upload, mark or schedule analytics in local mode %s", async (mode) => {
  vi.stubEnv("VITE_LOCAL_MODE", mode);
  vi.useFakeTimers();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const analytics = await import("./analytics");
  analytics.configureAnalytics({ apiUrl: "https://example.invalid", token: null });
  await analytics.startAnalytics(() => true);
  analytics.track("app_opened");
  analytics.countCanvasEdits(["prop"]);
  analytics.countCodeChange("private.tsx");
  await vi.advanceTimersByTimeAsync(60_000);

  expect(fetch).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("sends batches only when hosted mode is explicitly enabled", async () => {
  vi.stubEnv("VITE_LOCAL_MODE", "false");
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const analytics = await import("./analytics");
  analytics.configureAnalytics({ apiUrl: "https://example.invalid", token: "test-token" });
  await analytics.startAnalytics(() => true);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://example.invalid/api/v2/trpc/events.track");
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.events.map((event: { name: string }) => event.name)).toEqual(["app_installed", "app_opened"]);
  expect(writeFile).toHaveBeenCalledTimes(1);
});
