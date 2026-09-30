/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

export const ProjectPath = z.string().min(1)
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, "project must be an absolute directory path")
  .refine(value => !value.includes("\0"), "project path must not contain a null byte");

const projectField = ProjectPath.optional().describe(
  "absolute project directory; targets its independent workspace instead of the session's bound project or the app's default project",
);

/**
 * Which process answers the tool. Renderer tools need the open project's
 * world, the engine, or browser media APIs; main tools need the file system
 * or a child process and run without a window.
 */
export type Environment = "renderer" | "main";

export interface Tool<
  Name extends string = string,
  Input extends z.ZodObject = z.ZodObject,
  Output extends z.ZodObject = z.ZodObject,
  Result extends z.ZodType = Output,
> {
  /** MCP tool name: `[a-z0-9_]`, unique across the catalog. */
  readonly name: Name;
  /** Short human label, a few words. */
  readonly title: string;
  /** What the tool does, for an agent choosing between tools. */
  readonly description: string;
  /** Always an object: MCP tool arguments are a JSON object by definition. */
  readonly input: Input;
  /** What the caller receives: a JSON object, the tool's structured content. */
  readonly output: Output;
  /**
   * What the handler returns, when that is not the output: image tools hand
   * back bytes, and the server presents them as files and inline images;
   * transcribe hands back the transcript, and the server writes it to a file.
   * Same as `output` when omitted.
   */
  readonly result?: Result;
  readonly environment: Environment;
}

/** A tool with its specifics erased, for code that iterates the catalog. */
export type GenericTool = Tool<string, z.ZodObject, z.ZodObject, z.ZodType>;

/** Add project targeting once, preserving each tool's fields and refinements. */
export function defineTool<
  const Name extends string,
  Input extends z.ZodObject,
  Output extends z.ZodObject,
  Result extends z.ZodType = Output,
>(tool: Tool<Name, Input, Output, Result>): Tool<Name, z.ZodObject<Input["shape"] & { project: typeof projectField }>, Output, Result> {
  return {
    ...tool,
    input: tool.input.safeExtend({ project: projectField }) as z.ZodObject<Input["shape"] & { project: typeof projectField }>,
  };
}
