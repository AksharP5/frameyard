import { transcribe } from "./transcribe";

/** Compatibility name for existing agent clients and projects. */
export const mediaTranscribe = { ...transcribe, name: "media_transcribe" } as const;
