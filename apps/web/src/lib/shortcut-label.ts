/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JSX } from "solid-js";

const keyLabels: Record<string, string> = {
  "⌘": "Ctrl+",
  "⌃": "Ctrl+",
  "⌥": "Alt+",
  "⇧": "Shift+",
  "⌫": "Backspace",
  "⌦": "Delete",
  "⎋": "Esc",
  "↩": "Enter",
  "←": "Left",
  "→": "Right",
  "↑": "Up",
  "↓": "Down",
};

export function shortcutLabel(value: JSX.Element, platform = window.desktop?.platform ?? navigator.platform): JSX.Element {
  if (typeof value !== "string" || /^(darwin|mac)/i.test(platform)) return value;
  return value.replace(/\uFE0E/g, "").replace(/[⌘⌃⌥⇧⌫⌦⎋↩←→↑↓]/g, (key) => keyLabels[key]);
}
