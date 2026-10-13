import { listen } from "./listen";

/** Compatibility name for existing agent clients and projects. */
export const mediaListen = { ...listen, name: "media_listen" } as const;
