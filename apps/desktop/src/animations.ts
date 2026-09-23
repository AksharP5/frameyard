import { join, resolve } from "node:path";
import { cancelAnimation, convertAnimation, exportAnimation, listAnimations, renderAnimation } from "../../cli/src/animation";
import { animationRequestSchema, type AnimationResponse } from "./animation-contracts";

type ChooseOutput = (options: { defaultPath: string; transparent: boolean }) => Promise<string | null>;

export async function handleAnimationRequest(input: unknown, chooseOutput?: ChooseOutput, signal?: AbortSignal): Promise<AnimationResponse> {
  signal?.throwIfAborted();
  const request = animationRequestSchema.parse(input);
  if (request.action === "editable") return convertAnimation(request.id, request.dir, { allowPartial: request.allowPartial, signal });
  if (request.action === "cancel") return { cancelled: await cancelAnimation(request.id, request.dir) };
  if (request.action === "export") {
    let output = request.output;
    if (!output) {
      if (!chooseOutput) throw new Error("Specify output for animation export, for example exports/title.mov.");
      const animation = (await listAnimations(request.dir)).find((item) => item.id === request.id);
      if (!animation) throw new Error(`Unknown animation: ${request.id}`);
      if (!("engine" in animation)) throw new Error(animation.error);
      const selected = await chooseOutput({
        defaultPath: join(resolve(request.dir), "exports", `${animation.id}.${animation.transparent ? "mov" : "mp4"}`),
        transparent: animation.transparent,
      });
      if (!selected) return { path: null };
      output = selected;
    }
    const result = await exportAnimation(request.id, request.dir, output, { overwrite: request.output ? request.overwrite : true, signal });
    return { path: result.output };
  }
  if (request.action === "render") await renderAnimation(request.id, request.dir, undefined, signal);
  return { items: await listAnimations(request.dir) };
}
