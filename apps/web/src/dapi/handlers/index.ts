/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { open } from "./open";
import { context } from "./context";
import { capture } from "./capture";
import { check } from "./check";
import { exportScene } from "./export";
import { models } from "./models";
import { voices } from "./voices";
import { whoami } from "./whoami";
import { screenshot } from "./screenshot";
import { probe } from "./probe";
import { transcribe } from "./transcribe";
import { filmstrip } from "./filmstrip";
import { waveform } from "./waveform";
import { listen } from "./listen";
import { mediaSegment } from "./media-segment";
import { generate, job } from "./generate";

import type { Handlers } from "../handler";

/** Every tool the renderer answers, keyed by its catalog name. */
export const handlers: Handlers = {
  open,
  context,
  capture,
  check,
  export: exportScene,
  models,
  voices,
  whoami,
  screenshot,
  probe,
  grab: async (...args) => (await import("./grab")).grab(...args),
  transcribe,
  filmstrip,
  waveform,
  listen,
  generate,
  job,
  media_probe: (args, ctx) => probe(args, ctx),
  media_grab: async (...args) => (await import("./grab")).grab(...args),
  media_transcribe: (args, ctx) => transcribe(args, ctx),
  media_filmstrip: (args, ctx) => filmstrip(args, ctx),
  media_waveform: (args, ctx) => waveform(args, ctx),
  media_listen: (args, ctx) => listen(args, ctx),
  media_segment: mediaSegment,
};
