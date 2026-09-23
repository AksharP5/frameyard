import { z } from "zod";
import { ANIMATABLE_PROPERTIES, COMPOSITION_TAGS, LIGHT_TYPES, LOOP_ATTR, MESH_SHAPES, SOURCE_ATTR, SPATIAL_ARRAYS, SPATIAL_PARAMETERS, type AuthoredTree, type SpatialParameter } from "@diffusionstudio/jsx";
import { regionSchema } from "./annotation-contracts";
import { addHighlightSchema, highlightOptionsSchema } from "./highlight-contracts";

import { addPresetSchema, updatePresetSchema } from "./preset-contracts";

const motionProperties: Record<string, z.ZodOptional<z.ZodType<number | string | number[]>>> = Object.fromEntries(
  Object.keys(ANIMATABLE_PROPERTIES).map(property => {
    if (property === "d" || property === "color") return [property, z.string().optional()];
    if (SPATIAL_ARRAYS.some(name => name === property)) return [property, z.array(z.number().finite()).optional()];
    let value = z.number().finite();
    if (Object.hasOwn(SPATIAL_PARAMETERS, property)) {
      const [, min, max] = SPATIAL_PARAMETERS[property as SpatialParameter];
      if (Number.isFinite(min)) value = value.min(min);
      if (Number.isFinite(max)) value = value.max(max);
    }
    return [property, value.optional()];
  }),
);
const nodeId = z.string().min(1);
const nativeTreeSchema: z.ZodType<AuthoredTree> = z.lazy(() => z.object({
  tag: z.enum(COMPOSITION_TAGS).exclude(["stage"]),
  props: z.record(z.string(), z.json()).default({}).refine(props => !(SOURCE_ATTR in props) && !(LOOP_ATTR in props), "Source stamps are assigned by the editor"),
  text: z.string().optional(),
  children: z.array(nativeTreeSchema).default([]),
}).strict());
export const addNativeSchema = z.object({ parentId: nodeId.optional(), tree: nativeTreeSchema }).strict();
export const editorToolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("editor_context"), args: z.object({}) }),
  z.object({ name: z.literal("editor_capture"), args: z.object({
    sceneId: nodeId.optional(),
    time: z.number().finite().min(0).optional(),
  }).strict() }),
  z.object({ name: z.literal("editor_add"), args: addNativeSchema }),
  z.object({ name: z.literal("editor_update"), args: z.object({
    id: nodeId,
    props: z.object({
      ...motionProperties,
      d: z.string().optional(),
      color: z.string().optional(),
      shape: z.enum(MESH_SHAPES).optional(),
      type: z.enum(LIGHT_TYPES).optional(),
      indices: z.array(z.number().int().nonnegative()).optional(),
      normals: z.array(z.number().finite()).optional(),
      uv: z.array(z.number().finite()).optional(),
      lit: z.boolean().optional(), wireframe: z.boolean().optional(),
      castShadow: z.boolean().optional(), receiveShadow: z.boolean().optional(), depthTest: z.boolean().optional(),
      emissive: z.string().optional(), fogColor: z.string().optional(),
      physics: z.union([z.boolean(), z.record(z.string(), z.json())]).optional(),
      rigidBody: z.union([z.boolean(), z.record(z.string(), z.json())]).optional(),
      src: z.string().optional(),
      value: z.union([z.number().finite(), z.string(), z.array(z.number().finite())]).optional(),
      time: z.number().finite().min(0).optional(),
      easing: z.string().optional(),
      gradientSpace: z.enum(["local", "screen"]).optional(),
      cap: z.enum(["butt", "round", "square"]).optional(),
      join: z.enum(["miter", "round", "bevel"]).optional(),
      miterLimit: z.number().finite().positive().optional(),
      dash: z.array(z.number().finite().nonnegative()).optional(),
      fillRule: z.enum(["nonzero", "evenodd"]).optional(),
      depthSort: z.enum(["layer", "camera"]).optional(),
      viewBox: z.tuple([z.number().finite(), z.number().finite(), z.number().positive(), z.number().positive()]).optional(),
      flipX: z.boolean().optional(), flipY: z.boolean().optional(),
      hidden: z.boolean().optional(), locked: z.boolean().optional(),
      x: z.number().optional(), y: z.number().optional(),
      width: z.number().positive().optional(), height: z.number().positive().optional(),
      rotation: z.number().optional(), opacity: z.number().min(0).max(1).optional(),
      fill: z.string().optional(), fontSize: z.number().positive().optional(),
      fontFamily: z.string().optional(), fontWeight: z.union([z.string(), z.number().finite()]).optional(),
      start: z.number().min(0).optional(), end: z.number().positive().optional(),
      name: z.string().optional(),
      region: regionSchema.optional(),
      ...highlightOptionsSchema.shape,
    }).strict().optional(),
    text: z.string().optional(),
  }).strict() }),
  z.object({ name: z.literal("editor_insert_asset"), args: z.object({
    path: z.string().min(1),
    start: z.number().min(0).optional(),
    fit: z.literal("contain").optional(),
  }).strict() }),
  z.object({ name: z.literal("editor_add_highlight"), args: addHighlightSchema }),
  z.object({ name: z.literal("editor_effects"), args: z.object({ id: z.string().min(1).optional(), query: z.string().max(200).optional() }).strict() }),
  z.object({ name: z.literal("editor_add_preset"), args: addPresetSchema }),
  z.object({ name: z.literal("editor_update_preset"), args: updatePresetSchema }),
]);

export type EditorTool = z.infer<typeof editorToolSchema>;
export type AddNativeInput = z.infer<typeof addNativeSchema>;
export type EditorToolRequest = { id: string; dir: string } & EditorTool;
