/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length) {
    throw new Error(`${path} has unsupported fields: ${unsupported.join(", ")}. Import source cuts only; add effects and overlays in the editor.`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${path} must be a nonempty string without null bytes.`);
  }
  return value;
}

function seconds(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite, nonnegative number of seconds.`);
  }
  return value;
}

function parsePlan(input: unknown, base: string) {
  const plan = Array.isArray(input) ? undefined : record(input, "Plan");
  if (plan) fields(plan, ["sources", "ranges"], "Plan");
  const sources = plan ? record(plan.sources, "Plan.sources") : undefined;
  const ranges: unknown = plan ? plan.ranges : input;
  if (!Array.isArray(ranges) || !ranges.length) {
    throw new Error("Plan must contain at least one source cut.");
  }

  const ids = new Set(["edit-plan"]);
  const occurrences = new Map<string, number>();
  let duration = 0;
  const clips = ranges.map((value: unknown, index) => {
    const path = `Cut ${index + 1}`;
    const cut = record(value, path);
    fields(cut, sources
      ? ["source", "start", "end", "id", "label", "beat", "note"]
      : ["source", "in", "out", "id", "label"], path);
    const source = text(cut.source, `${path}.source`);
    const file = sources
      ? text(Object.hasOwn(sources, source) ? sources[source] : undefined, `Plan.sources[${JSON.stringify(source)}]`)
      : source;
    const src = resolve(base, file);
    const sourceIn = seconds(sources ? cut.start : cut.in, `${path}.${sources ? "start" : "in"}`);
    const sourceOut = seconds(sources ? cut.end : cut.out, `${path}.${sources ? "end" : "out"}`);
    if (sourceOut <= sourceIn) throw new Error(`${path} must end after it starts.`);

    const key = createHash("sha256").update(JSON.stringify([src, sourceIn, sourceOut])).digest("hex").slice(0, 12);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const id = cut.id === undefined ? `cut-${key}-${occurrence}` : text(cut.id, `${path}.id`);
    // The source writer locates literal JSX ids, so keep these safe to quote directly.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${path}.id may contain only letters, digits, underscores, and hyphens.`);
    if (ids.has(id)) throw new Error(`${path}.id is duplicated or reserved: ${id}`);
    ids.add(id);
    const label = cut.label ?? cut.beat ?? cut.note;
    const name = label === undefined ? undefined : text(label, `${path}.label`);
    const start = duration;
    duration += sourceOut - sourceIn;
    if (!Number.isFinite(duration)) throw new Error("Total edit duration is too large.");
    return { id, name, src, sourceIn, sourceOut, start };
  });
  return { clips, duration };
}

/** Writes editable cuts to a new component; existing JSX and source media are never overwritten. */
export async function writeEditPlan(planPath: string, outputPath: string) {
  const output = resolve(outputPath);
  if (extname(output).toLowerCase() !== ".tsx") throw new Error("Output must be a new .tsx file.");
  const input: unknown = JSON.parse(await readFile(planPath, "utf8"));
  const plan = parsePlan(input, dirname(resolve(planPath)));

  for (const src of new Set(plan.clips.map((clip) => clip.src))) {
    const info = await stat(src);
    if (!info.isFile()) throw new Error(`Source must be a file: ${src}`);
  }

  const clips = plan.clips.map((clip) => {
    const name = clip.name === undefined ? "" : ` name={${JSON.stringify(clip.name)}}`;
    return `      <video id="${clip.id}"${name} src={${JSON.stringify(clip.src)}} start={${clip.start}} sourceIn={${clip.sourceIn}} sourceOut={${clip.sourceOut}} width={1920} height={1080} />`;
  });
  const source = [
    "export default function EditPlan() {",
    "  return (",
    '    <sequence id="edit-plan" name="Edit plan">',
    ...clips,
    "    </sequence>",
    "  );",
    "}",
    "",
  ].join("\n");
  await writeFile(output, source, { flag: "wx" }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Output already exists: ${output}. Choose a new file to preserve manual edits.`);
    }
    throw error;
  });
  return { output, clips: plan.clips.length, duration: plan.duration };
}
