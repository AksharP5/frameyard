/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, OggOutputFormat,
  canEncodeAudio, canEncodeVideo,
} from "mediabunny";
import { AUDIO_CODEC_OPTIONS, VIDEO_CODEC_OPTIONS, getDefaultExportTemplate } from "../components/sidebar-right/inspector/export-templates";
import type { ContainerFormat, ExportConfig } from "./project-config";
import { isFrameRate } from '@diffusionstudio/jsx';

const formats = {
  mp4: new Mp4OutputFormat(),
  mov: new MovOutputFormat(),
  webm: new WebMOutputFormat(),
  ogg: new OggOutputFormat(),
};

/** Preserve a scene's settings and inherit its frame rate wherever none was saved. */
export function resolveExportSettings(settings: ExportConfig | null | undefined, frameRate: number): ExportConfig {
  const config = settings ?? getDefaultExportTemplate();
  return { ...config, video: { ...config.video, fps: settings?.video?.fps ?? frameRate } };
}

/** Offer codecs the selected container can actually hold. */
export function getExportCodecs(format: ContainerFormat) {
  const output = Object.hasOwn(formats, format) ? formats[format] : undefined;
  return {
    video: VIDEO_CODEC_OPTIONS.filter((codec) => output?.getSupportedVideoCodecs().includes(codec)),
    audio: AUDIO_CODEC_OPTIONS.filter((codec) => output?.getSupportedAudioCodecs().includes(codec)),
  };
}

/** Only an explicit format change replaces an incompatible codec. Other settings stay intact. */
export function changeExportFormat(config: ExportConfig, format: ContainerFormat): ExportConfig {
  const codecs = getExportCodecs(format);
  const output = formats[format];
  const video = config.video?.codec ?? "avc";
  const audio = config.audio?.codec ?? "aac";
  return {
    ...config,
    format,
    video: codecs.video.length ? { ...config.video, codec: output.getSupportedVideoCodecs().includes(video) ? video : codecs.video[0] } : config.video,
    audio: { ...config.audio, codec: output.getSupportedAudioCodecs().includes(audio) ? audio : codecs.audio[0] },
  };
}

/** Validate stored settings without rewriting them, before opening a destination or starting capture. */
export async function getExportError(config: ExportConfig, size: { width: number; height: number }): Promise<string | undefined> {
  const format = config.format ?? "mp4";
  const output = Object.hasOwn(formats, format) ? formats[format] : undefined;
  if (!output) return `Unknown export format: ${format}. Choose MP4, MOV, WebM or OGG.`;

  const videoEnabled = format !== "ogg" && config.video?.enabled !== false;
  const audioEnabled = format === "ogg" || config.audio?.enabled !== false;
  if (!videoEnabled && !audioEnabled) return "Enable video or audio before exporting.";
  if (videoEnabled && config.video?.fps !== undefined && !isFrameRate(config.video.fps)) return "Export frame rate must be between 1 and 240 fps.";

  const videoCodec = config.video?.codec ?? "avc";
  const audioCodec = config.audio?.codec ?? "aac";
  if (videoEnabled && !output.getSupportedVideoCodecs().includes(videoCodec)) {
    return `${format.toUpperCase()} cannot contain ${videoCodec.toUpperCase()} video. Choose a compatible video codec or format.`;
  }
  if (audioEnabled && !output.getSupportedAudioCodecs().includes(audioCodec)) {
    return `${format.toUpperCase()} cannot contain ${audioCodec.toUpperCase()} audio. Choose a compatible audio codec or format.`;
  }

  try {
    if (videoEnabled && !await canEncodeVideo(videoCodec, { ...size, bitrate: config.video?.bitrate ?? 10e6 })) {
      return `Cannot encode ${videoCodec.toUpperCase()} at ${size.width}×${size.height}. Choose another video codec or a lower resolution or bitrate.`;
    }
    // AAC has a bundled software encoder, registered lazily when export starts.
    if (audioEnabled && audioCodec !== "aac" && !await canEncodeAudio(audioCodec, {
      numberOfChannels: 2,
      sampleRate: config.audio?.sampleRate ?? 48000,
      bitrate: config.audio?.bitrate ?? 128e3,
    })) {
      return `Cannot encode ${audioCodec.toUpperCase()} at ${(config.audio?.sampleRate ?? 48000) / 1000} kHz. Choose another audio codec or sample rate.`;
    }
  } catch (error) {
    return `Could not check export settings: ${error instanceof Error ? error.message : String(error)}`;
  }
}
