import { existsSync } from "node:fs";
import { join } from "node:path";

function existingDirectory(root: string, legacyName: string): string {
  const current = join(root, "Frameyard");
  const legacy = join(root, legacyName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

// Reuse the fork's saved state and project library without moving user files.
export function userDataDirectory(root: string): string {
  return existingDirectory(root, "Diffusion Studio Linux");
}

export function projectsDirectory(root: string): string {
  return existingDirectory(root, "Diffusion Studio");
}
