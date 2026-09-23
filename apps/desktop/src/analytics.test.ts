import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused", getVersion: () => "0.205.2" },
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("No install marker")),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { access, writeFile } from "node:fs/promises";
import { trackEvent, trackInstall } from "./analytics";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([undefined, "true"])("does not upload or mark analytics in local mode %s", async (mode) => {
  vi.stubEnv("VITE_LOCAL_MODE", mode);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await trackInstall();
  await trackEvent("project_open", { project: "Private project" });

  expect(fetch).not.toHaveBeenCalled();
  expect(access).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});

it("allows analytics when hosted mode is explicitly enabled", async () => {
  vi.stubEnv("VITE_LOCAL_MODE", "false");
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);

  await trackInstall();
  await trackEvent("app_open");

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(writeFile).toHaveBeenCalledTimes(1);
});
