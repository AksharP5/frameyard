import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import type { MainContext } from "../handler";

const native = vi.hoisted(() => ({ execFile: vi.fn(), platform: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
vi.mock("node:os", () => ({ platform: native.platform }));

import { fonts } from "./fonts";

const ctx = (signal = new AbortController().signal): MainContext => ({
  signal, logs: () => [], version: "0", runAgentTool: async () => ({ success: false, contentItems: [] }),
});

const rows = [
  "Inter\tInter Regular\tInter-Regular\t80\t0",
  "Local Video Sans\tLocal Video Sans Bold Italic\tLocalVideoSans-BoldItalic\t200\t100",
  "Local Video Serif\tLocal Video Serif Bold Italic\tLocalVideoSerif-BoldItalic\t200\t100",
  "Local Video Sans\tLocal Video Sans Regular\tLocalVideoSans-Regular\t80\t0",
].join("\n");

beforeEach(() => {
  native.platform.mockReturnValue("linux");
  native.execFile.mockReset();
  native.execFile.mockImplementation((_command, _args, _options, callback: (error: Error | null, output: string) => void) => callback(null, rows));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Font listing must not use the network"); }));
});
afterEach(() => vi.unstubAllGlobals());

it("lists the bundled Google catalog and popular order without a native process or network", async () => {
  const result = await fonts({ provider: "google", popular: true, limit: 2 }, ctx());
  expect(result.families.map(font => font.family)).toEqual(["Abril Fatface", "Anton"]);
  expect(result.total).toBeGreaterThan(result.families.length);
  expect(result.families.every(font => font.provider === "google" && font.stylesheet?.startsWith("https://fonts.googleapis.com/css2?"))).toBe(true);
  expect(native.execFile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(toolByName("fonts").output.parse(result)).toEqual(result);
});

it("prefers Google families over installed names in a mixed listing", async () => {
  const result = await fonts({ family: "inter" }, ctx());
  expect(result.families.filter(font => font.family === "Inter")).toHaveLength(1);
  expect(result.families.find(font => font.family === "Inter")?.provider).toBe("google");
  expect(native.execFile).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("filters native variants before limiting, preserving sources and total", async () => {
  const context = ctx();
  const result = await fonts({ provider: "local", family: "LOCAL VIDEO", weights: ["700"], style: "italic", limit: 1 }, context);
  expect(result).toEqual({
    families: [{ family: "Local Video Sans", provider: "local", variants: [{ weight: "700", style: "italic", source: "local('Local Video Sans Bold Italic'), local('LocalVideoSans-BoldItalic')" }] }],
    total: 2,
  });
  expect(native.execFile.mock.calls[0]?.[2].signal).toBe(context.signal);
  expect(toolByName("fonts").output.parse(result)).toEqual(result);
});

it("retains Google fonts when native enumeration is unavailable and reports explicit local failures", async () => {
  native.platform.mockReturnValue("win32");
  const result = await fonts({ family: "Bebas Neue" }, ctx());
  expect(result.families).toHaveLength(1);
  expect(result.families[0]?.provider).toBe("google");
  await expect(fonts({ provider: "local" }, ctx())).rejects.toMatchObject({ code: "unsupported" });
});

it("validates macOS native output against the shared font contract", async () => {
  native.platform.mockReturnValue("darwin");
  const local = [{ family: "Video Sans", provider: "local", variants: [{ weight: "400", style: "normal", source: "local('VideoSans-Regular')" }] }];
  native.execFile.mockImplementation((_command, _args, _options, callback: (error: Error | null, output: string) => void) => callback(null, JSON.stringify(local)));
  expect((await fonts({ provider: "local" }, ctx())).families).toEqual(local);
  expect(native.execFile.mock.calls[0]?.[0]).toBe("osascript");
  native.execFile.mockImplementation((_command, _args, _options, callback: (error: Error | null, output: string) => void) => callback(null, JSON.stringify([{ family: "Video Sans", variants: [] }])));
  await expect(fonts({ provider: "local" }, ctx())).rejects.toThrow();
});

it("does not turn canceled native enumeration into a successful Google-only result", async () => {
  const controller = new AbortController();
  native.execFile.mockImplementation((_command, _args, _options, callback: (error: Error | null, output: string) => void) => {
    controller.abort(new Error("Font listing canceled"));
    callback(new Error("Canceled native process"), "");
  });
  await expect(fonts({}, ctx(controller.signal))).rejects.toThrow("Font listing canceled");
});
