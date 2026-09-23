import { listAnimations, renderAnimation } from "../../cli/src/animation";
import { manimRequestSchema } from "./manim-contracts";

export async function handleManimRequest(input: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const request = manimRequestSchema.parse(input);
  if (request.action === "render") await renderAnimation(request.id, request.dir, "manim", signal);
  return { items: await listAnimations(request.dir, "manim") };
}
