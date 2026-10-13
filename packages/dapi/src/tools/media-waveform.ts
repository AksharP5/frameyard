import { waveform } from "./waveform";

/** Compatibility name for existing agent clients and projects. */
export const mediaWaveform = { ...waveform, name: "media_waveform" } as const;
