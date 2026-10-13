import { probe } from "./probe";

/** Compatibility name for existing agent clients and projects. */
export const mediaProbe = { ...probe, name: "media_probe" } as const;
