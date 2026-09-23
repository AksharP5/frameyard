import { expect, it } from "vitest";
import { allowsMediaCheck, allowsMediaRequest, isEditorUrl, isExternalWebUrl } from "./window-security";

it("allows only the editor document to navigate within its origin", () => {
  const editor = "http://localhost:5173/";
  expect(isEditorUrl("http://localhost:5173/#/project/one", editor)).toBe(true);
  expect(isEditorUrl("http://localhost:5173/other", editor)).toBe(false);
  expect(isEditorUrl("https://example.com/", editor)).toBe(false);
  expect(isEditorUrl("file:///other/index.html", "file:///opt/frameyard/web/index.html")).toBe(false);
  expect(isEditorUrl("file:///opt/frameyard/web/index.html#/project/one", "file:///opt/frameyard/web/index.html")).toBe(true);
});

it("opens web links externally but rejects local and script URLs", () => {
  expect(isExternalWebUrl("https://github.com/AksharP5/frameyard")).toBe(true);
  expect(isExternalWebUrl("file:///tmp/secret")).toBe(false);
  expect(isExternalWebUrl("javascript:alert(1)")).toBe(false);
});

it("permits microphone requests without granting camera access", () => {
  expect(allowsMediaRequest(["audio"])).toBe(true);
  expect(allowsMediaRequest(["video"])).toBe(false);
  expect(allowsMediaRequest(["audio", "video"])).toBe(false);
  expect(allowsMediaRequest()).toBe(false);
  expect(allowsMediaCheck("audio")).toBe(true);
  expect(allowsMediaCheck("video")).toBe(false);
});
