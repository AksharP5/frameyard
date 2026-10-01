/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalog, isToolName, toolByName } from "./catalog";
import { JSON_SCHEMA_DIALECT, toolJsonSchemas } from "./json-schema";

describe("catalog", () => {
  it("has unique MCP-legal names", () => {
    const names = catalog.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it("describes every tool for an agent, not just a label", () => {
    for (const tool of catalog) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("takes an object as every tool's input, as MCP requires", () => {
    for (const tool of catalog) {
      expect(tool.input, tool.name).toBeInstanceOf(z.ZodObject);
    }
  });

  it("converts every input and output to JSON Schema, as MCP tools/list does", () => {
    for (const tool of catalog) {
      expect(() => z.toJSONSchema(tool.input, { io: "input" }), `${tool.name} input`).not.toThrow();
      expect(() => z.toJSONSchema(tool.output), `${tool.name} output`).not.toThrow();
      expect(tool.output, `${tool.name} output must be an object for structured content`).toBeInstanceOf(z.ZodObject);
    }
  });

  it("publishes every schema as JSON Schema 2020-12, the dialect MCP clients validate", () => {
    for (const tool of catalog) {
      const { inputSchema, outputSchema } = toolJsonSchemas(tool);
      expect(inputSchema.$schema, `${tool.name} input`).toBe(JSON_SCHEMA_DIALECT);
      expect(outputSchema.$schema, `${tool.name} output`).toBe(JSON_SCHEMA_DIALECT);
      expect(inputSchema.type, `${tool.name} input`).toBe("object");
      expect(outputSchema.type, `${tool.name} output`).toBe("object");
    }
  });

  it("looks tools up by name", () => {
    expect(toolByName("capture").environment).toBe("renderer");
    expect(toolByName("fonts").environment).toBe("main");
    expect(toolByName("logs").environment).toBe("main");
    expect(toolByName("window").environment).toBe("main");
    expect(isToolName("media_grab")).toBe(true);
    expect(isToolName("media.frame")).toBe(false);
  });

  it("offers optional absolute project targeting on every tool", () => {
    for (const tool of catalog) {
      const project = tool.input.shape.project;
      expect(project.safeParse(undefined).success, tool.name).toBe(true);
      expect(project.parse("/projects/intro"), tool.name).toBe("/projects/intro");
      expect(project.parse("C:\\projects\\intro"), tool.name).toBe("C:\\projects\\intro");
      expect(project.safeParse("intro").success, tool.name).toBe(false);
      expect(project.safeParse("/intro\0").success, tool.name).toBe(false);
      const schema = toolJsonSchemas(tool).inputSchema;
      expect(schema.required ?? [], tool.name).not.toContain("project");
    }
  });

  it("retains field transforms, defaults, and cross-field checks with project targeting", () => {
    const capture = toolByName("capture").input;
    expect(capture.parse({ id: "intro", times: ["45f"], project: "/projects/intro" }).times).toEqual([1.5]);
    expect(capture.safeParse({ id: "intro", separate: true, perSheet: 2, project: "/projects/intro" }).success).toBe(false);
    expect(toolByName("agent_tool").input.parse({ name: "editor_context", project: "/projects/intro" })).toEqual({
      name: "editor_context", args: {}, project: "/projects/intro",
    });
    const workspace = toolByName("workspace").input;
    expect(workspace.parse({ action: "send", message: "  Make an intro  ", project: "/projects/intro" }).message).toBe("Make an intro");
    expect(workspace.safeParse({ action: "send", project: "/projects/intro" }).success).toBe(false);
    expect(workspace.safeParse({ action: "send", message: "   " }).success).toBe(false);
    expect(workspace.parse({ action: "list" })).toEqual({ action: "list" });
  });
});
