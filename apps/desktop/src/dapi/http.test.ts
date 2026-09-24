/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authenticatedMcpUrl } from "@diffusionstudio/dapi/mcp-auth-node";
import { DapiHttpServer } from "./http";

// An ephemeral port: the fixed one may be held by a running app.
const PORT = 45000 + Math.floor(Math.random() * 1000);
const PATH = "/mcp";
const TOKEN = "a".repeat(64);
let server: DapiHttpServer;
let firstConnections = 0;
let sessionsCreated = 0;

beforeAll(async () => {
  server = new DapiHttpServer({
    host: "127.0.0.1",
    port: PORT,
    path: PATH,
    token: TOKEN,
    onFirstConnection: () => void firstConnections++,
    createSession() {
      sessionsCreated++;
      const session = new McpServer({ name: "test", version: "0.0.0" }, { instructions: "Test instructions." });
      session.registerTool(
        "echo",
        { inputSchema: z.object({ text: z.string() }), outputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: "text", text }], structuredContent: { text } }),
      );
      session.registerResource("note", "dapi://note", { mimeType: "text/plain" }, async () => ({
        contents: [{ uri: "dapi://note", mimeType: "text/plain", text: "hello" }],
      }));
      return session;
    },
  });
  await server.start();
});

afterAll(() => server.stop());

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(authenticatedMcpUrl(TOKEN, server.url))));
  return client;
}

describe("mcp over http", () => {
  it("rejects missing, incorrect, and duplicate credentials before creating a session", async () => {
    const before = sessionsCreated;
    for (const url of [server.url, authenticatedMcpUrl("b".repeat(64), server.url), `${authenticatedMcpUrl(TOKEN, server.url)}&token=${TOKEN}`]) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
    }
    expect(sessionsCreated).toBe(before);
  });

  it("serves a session: instructions, tools, resources", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe("Test instructions.");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.structuredContent).toEqual({ text: "hi" });
    const note = await client.readResource({ uri: "dapi://note" });
    expect(note.contents[0]).toMatchObject({ text: "hello" });
    await client.close();
  });

  it("accepts a bearer credential without putting it in the URL", async () => {
    const client = new Client({ name: "bearer-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
    expect((await client.listTools()).tools[0]?.name).toBe("echo");
    await client.close();
  });

  it("gives each client its own session and reports the first once", async () => {
    const before = sessionsCreated;
    const a = await connect();
    const b = await connect();
    expect(sessionsCreated - before).toBe(2);
    expect(firstConnections).toBe(1);
    await a.close();
    await b.close();
  });

  it("rejects a stale session id and a non-mcp path", async () => {
    const stale = await fetch(authenticatedMcpUrl(TOKEN, server.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(stale.status).toBe(404);
    const elsewhere = await fetch(`http://127.0.0.1:${PORT}/other`);
    expect(elsewhere.status).toBe(404);
  });

  it("rejects a request whose Host is not loopback (dns rebinding)", async () => {
    // node's fetch drops a custom Host header, so go through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: PORT, path: `${PATH}?token=${TOKEN}`, method: "POST", headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }));
    });
    expect(status).toBe(403);
  });
});
