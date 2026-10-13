import { filmstrip } from "./filmstrip";

/** Compatibility name for existing agent clients and projects. */
export const mediaFilmstrip = { ...filmstrip, name: "media_filmstrip" } as const;
