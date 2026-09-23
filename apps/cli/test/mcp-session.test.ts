import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function serve(t: TestContext) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const settings = { rejectInitialized: false, deleteStatus: 200, hangDelete: false };
  let nextId = 0;
  const http = createServer(async (req, res) => {
    if (req.method === "DELETE" && settings.hangDelete) return;
    if (req.method === "DELETE" && settings.deleteStatus !== 200) {
      res.writeHead(settings.deleteStatus).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (settings.rejectInitialized && body?.method === "notifications/initialized") {
      res.writeHead(500).end("Initialization failed");
      return;
    }
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? sessions.get(id) : undefined;
    if (!transport && id) {
      res.writeHead(404).end();
      return;
    }
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => String(++nextId),
        onsessioninitialized: (id) => { sessions.set(id, transport!); },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      const server = new McpServer({ name: "cleanup-test", version: "1" });
      server.registerTool("whoami", {}, async () => ({ content: [], structuredContent: { version: "test" } }));
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await Promise.all([...sessions.values()].map((transport) => transport.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}/mcp`, sessions, settings };
}

async function bundle(url: string, contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: new URL("../src/", import.meta.url).pathname },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "test-endpoint", setup(builder) {
      builder.onResolve({ filter: /^@diffusionstudio\/dapi$/ }, () => ({ path: "dapi", namespace: "test-endpoint" }));
      builder.onLoad({ filter: /.*/, namespace: "test-endpoint" }, () => ({
        contents: `export {toolByName} from ${JSON.stringify(new URL("../../../packages/dapi/src/index.ts", import.meta.url).pathname)}; export const MCP_URL = ${JSON.stringify(url)};`,
        loader: "js", resolveDir: new URL("../src/", import.meta.url).pathname,
      }));
    } }],
  });
  return result.outputFiles[0].text;
}

async function loadClient(url: string) {
  const source = await bundle(url, `export {call, ping} from './cli-client';`);
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(createRequire(import.meta.url), module, module.exports);
  return module.exports as Pick<typeof import("../src/cli-client"), "call" | "ping">;
}

test("CLI calls and pings delete their HTTP sessions, including failed initialization", async (t) => {
  const server = await serve(t);
  // SDK close alone leaves the server session allocated.
  const sdk = new Client({ name: "baseline", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url));
  await sdk.connect(transport);
  await sdk.close();
  assert.equal(server.sessions.size, 1);
  await fetch(server.url, { method: "DELETE", headers: { "mcp-session-id": transport.sessionId! } });
  assert.equal(server.sessions.size, 0);

  const client = await loadClient(server.url);
  await client.ping();
  assert.equal(server.sessions.size, 0);
  assert.deepEqual(await client.call("whoami", {}), { version: "test" });
  assert.equal(server.sessions.size, 0);
  await assert.rejects(client.call("context", {}), /not found/);
  assert.equal(server.sessions.size, 0);
  server.settings.rejectInitialized = true;
  await assert.rejects(client.ping(), /Initialization failed/);
  assert.equal(server.sessions.size, 0);
});

test("failed or stalled session deletion preserves results and bounds shutdown", { timeout: 5_000 }, async (t) => {
  const server = await serve(t);
  const client = await loadClient(server.url);
  server.settings.deleteStatus = 503;
  assert.deepEqual(await client.call("whoami", {}), { version: "test" });
  await assert.rejects(client.call("context", {}), /not found/);
  server.settings.hangDelete = true;
  const start = Date.now();
  await client.ping();
  assert.ok(Date.now() - start < 3_000, "cleanup must not wait indefinitely for DELETE");
});

test("stdio proxy deletes sessions on agent EOF, SIGINT, and SIGTERM", { timeout: 10_000 }, async (t) => {
  const server = await serve(t);
  const directory = await mkdtemp(join(tmpdir(), "frameyard-proxy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "proxy.cjs");
  await writeFile(path, await bundle(server.url, `import {runProxy} from './mcp-proxy'; runProxy().catch(error => { console.error(error); process.exitCode = 1; });`));
  for (const signal of [undefined, "SIGINT", "SIGTERM"] as const) {
    const client = new Client({ name: "proxy-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path], stderr: "pipe" });
    t.after(() => client.close());
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await client.connect(transport);
    assert.equal(server.sessions.size, 1, "the probe session must already be deleted");
    await client.ping();
    if (signal) {
      const closed = new Promise<void>((resolve) => { client.onclose = resolve; });
      assert.ok(transport.pid);
      process.kill(transport.pid, signal);
      await closed;
    } else {
      await client.close();
    }
    assert.equal(server.sessions.size, 0, stderr || `upstream session leaked after ${signal ?? "stdin EOF"}`);
  }
});
