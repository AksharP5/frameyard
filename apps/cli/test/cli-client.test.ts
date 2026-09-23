import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function loadClient() {
  const bundle = await build({
    stdin: {
      contents: `export { call } from './cli-client'; export { requests } from '@modelcontextprotocol/sdk/client/index.js';`,
      resolveDir: new URL("../src/", import.meta.url).pathname,
    },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "mcp-client", setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\// }, ({ path }) => ({ path, namespace: "mcp-client" }));
      builder.onLoad({ filter: /.*/, namespace: "mcp-client" }, ({ path }) => ({
        contents: path.endsWith("/index.js") ? `
          export const requests = [];
          export class Client {
            async connect() {}
            async close() {}
            async callTool(request, schema, options) {
              requests.push({ ...request, timeout: options.timeout });
              if (request.arguments.name === 'editor_update') return {
                isError: true,
                content: [{ type: 'text', text: 'Element not found: title' }],
                structuredContent: { success: false, contentItems: [{ type: 'inputText', text: 'Element not found: title' }] },
              };
              if (request.arguments.name === 'unknown') return {
                isError: true, content: [{ type: 'text', text: 'Unknown editor tool' }],
              };
              return { structuredContent: {} };
            }
          }
        ` : `export class StreamableHTTPClientTransport { async terminateSession() {} async close() {} }`,
        loader: "js",
      }));
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as {
    call: typeof import("../src/cli-client").call;
    requests: Array<{ name: string; timeout: number }>;
  };
}

test("editor-tool renders receive the same long timeout as exports", async () => {
  const client = await loadClient();
  client.requests.length = 0;
  await client.call("agent_tool", { name: "project_animations", args: { action: "render", id: "intro" } });
  await client.call("export", { id: "intro" });
  await client.call("whoami", {});
  assert.deepEqual(client.requests.map(({ name, timeout }) => ({ name, timeout })), [
    { name: "agent_tool", timeout: 3_600_000 },
    { name: "export", timeout: 3_600_000 },
    { name: "whoami", timeout: 60_000 },
  ]);
});

test("editor failures retain structured CLI output while other MCP errors throw", async () => {
  const client = await loadClient();
  assert.deepEqual(await client.call("agent_tool", { name: "editor_update", args: { id: "title" } }), {
    success: false,
    contentItems: [{ type: "inputText", text: "Element not found: title" }],
  });
  await assert.rejects(client.call("agent_tool", { name: "unknown", args: {} }), /Unknown editor tool/);
});
