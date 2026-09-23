/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { secondsToFrames } from "@diffusionstudio/runtime";

export const RULER_INTERVALS = [
  {
    numerator: secondsToFrames(600),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(300),
    denominator: 5,
  },
  {
    numerator: secondsToFrames(120),
    denominator: 4,
  },
  {
    numerator: secondsToFrames(60),
    denominator: 6,
  },
  {
    numerator: secondsToFrames(30),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(10),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(5),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(3),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(2),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(1),
    denominator: 10,
  },
  {
    numerator: 15,
    denominator: 5,
  },
  {
    numerator: 10,
    denominator: 10,
  },
  {
    numerator: 5,
    denominator: 5,
  },
];

export const COLORS = {
  selection: {
    foreground: '#352a1b',
    muted: '#42382b',
  },
  background: {
    default: '#222321',
    muted: '#30322f',
    accent: '#30322f',
  },
  border: {
    darker: '#222321',
    input: '#484b45',
    ring: '#e5c39f',
    scrubber: '#cf877c', // ambient red
  },
  ruler: {
    tick: '#454841',
    text: '#92968d',
  },
  clip: {
    group: {
      background: '#3b403b',
      primary: '#51584f',
      foreground: '#e1e5dc',
    },
    video: {
      background: '#35434a',
      primary: '#a0b8c2', // Waveform
      foreground: '#e1e9ec', // Label
    },
    audio: {
      background: '#34483d',
      primary: '#a1bea4',
      foreground: '#dfebe0',
    },
    caption: {
      background: '#4c3f49',
      primary: '#816b7b', // Word background
      foreground: '#ece0e8',
    },
    image: {
      background: '#484737',
      foreground: '#ebe8d5',
    },
    text: {
      background: '#444941',
      foreground: '#e9eddf',
    },
    shape: {
      background: '#49423b',
      foreground: '#ede4d9',
    },
    scene: {
      background: '#3c4746',
      primary: '#8ca49e',
      foreground: '#dce7e2',
    },
    mask: {
      background: '#484353',
      foreground: '#e8e1f0',
    },
    adjustment: {
      background: '#494050',
      foreground: '#e6ddea',
    },
    html: {
      background: '#3c474b',
      foreground: '#e1e9ec',
    },
    failed: {
      background: '#2E1D1D',
      foreground: '#FF8A8A',
    },
  },
} as const;
