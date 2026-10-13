import { grab } from "./grab";

/** Compatibility name for existing agent clients and projects. */
export const mediaGrab = { ...grab, name: "media_grab" } as const;
