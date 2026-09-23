/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PresetDefinition } from "./presets";

export const PRESET_CATALOG: readonly PresetDefinition[] = [
  {
    id: "frameyard-pixelate",
    title: "Pixelate Region",
    category: "effect",
    collection: "Frameyard",
    description: "Pixelate a rectangular part of the picture.",
    controls: ["region", "amount"],
    defaults: { region: [0.25, 0.25, 0.5, 0.5], amount: 24 },
    labels: { amount: "Cell size" },
  },
];
