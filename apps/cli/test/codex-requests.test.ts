import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexRequests } from "../../desktop/src/codex-requests.ts";

const context = { threadId: "thread", turnId: "turn" };
const input = { ...context, questions: [{ id: "choice", header: "Choice", question: "Choose a mode", isOther: true, isSecret: false, options: [{ label: "Fast", description: "Fewer steps" }] }], isBlocking: false };
const form = { ...context, mode: "form", serverName: "server", message: "Your details", requestedSchema: {
  type: "object", properties: { age: { type: "integer", minimum: 18 }, email: { type: "string", format: "email" }, topics: { type: "array", minItems: 1, items: { anyOf: [{ const: "code", title: "Code" }] } } }, required: ["age", "email", "topics"],
} };

test("user input remains pending after invalid responses and maps custom answers to the native protocol", async () => {
  const broker = new CodexRequests();
  const reply = broker.request("input", "item/tool/requestUserInput", input);
  assert.equal(broker.list("thread")[0]?.kind, "input");
  assert.throws(() => broker.respond("input", { action: "accept", answers: {} }), /Answer Choice/);
  assert.throws(() => broker.respond("input", { action: "accept", answers: { wrong: ["Fast"] } }), /Unknown question/);
  assert.equal(broker.list("thread").length, 1);
  broker.respond("input", { action: "accept", answers: { choice: ["Take your time"] } });
  assert.deepEqual(await reply, { answers: { choice: { answers: ["Take your time"] } } });
  assert.throws(() => broker.respond("input", { action: "accept" }), /no longer pending/);
});

test("permissions grant only the exact requested profile and only after explicit acceptance", async () => {
  const broker = new CodexRequests();
  const permissions = { network: { enabled: true }, fileSystem: { read: ["/assets"], write: null, entries: [{ path: { type: "glob_pattern", pattern: "/assets/*.png" }, access: "read" }] } };
  const params = { ...context, cwd: "/project", reason: "Read assets", permissions };
  const accepted = broker.request("accept", "item/permissions/requestApproval", params);
  assert.throws(() => broker.respond("accept", { action: "accept", permissions: { fileSystem: { write: ["/"] } } }));
  broker.respond("accept", { action: "accept", scope: "session" });
  assert.deepEqual(await accepted, { permissions, scope: "session" });
  const declined = broker.request("decline", "item/permissions/requestApproval", params);
  broker.cancel("thread");
  assert.deepEqual(await declined, { permissions: {}, scope: "turn" });
});

test("MCP forms validate required values, constraints and enum membership before sending content", async () => {
  const broker = new CodexRequests();
  const reply = broker.request("form", "mcpServer/elicitation/request", form);
  const content = { age: 20, email: "person@example.com", topics: ["code"] };
  assert.throws(() => broker.respond("form", { action: "accept", content: { ...content, age: 17 } }), /Minimum/);
  assert.throws(() => broker.respond("form", { action: "accept", content: { ...content, age: 18.5 } }), /whole number/);
  assert.throws(() => broker.respond("form", { action: "accept", content: { ...content, email: "invalid" } }), /email address/);
  assert.throws(() => broker.respond("form", { action: "accept", content: { ...content, topics: ["unknown"] } }), /Invalid selection/);
  assert.throws(() => broker.respond("form", { action: "accept", content: { ...content, extra: true } }), /Unknown form field/);
  broker.respond("form", { action: "accept", content });
  assert.deepEqual(await reply, { action: "accept", content, _meta: null });
});

test("unsupported MCP forms fail visibly and can be declined, never accepted as an empty form", async () => {
  const broker = new CodexRequests();
  const reply = broker.request("unsupported", "mcpServer/elicitation/request", { ...form, mode: "openai/form", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } });
  assert.equal(broker.list("thread")[0]?.kind, "unsupported");
  assert.throws(() => broker.respond("unsupported", { action: "accept", content: {} }), /not supported/);
  broker.respond("unsupported", { action: "decline" });
  assert.deepEqual(await reply, { action: "decline", content: null, _meta: null });
});

test("MCP URL requests support nullable turn IDs and refuse executable URL schemes", async () => {
  const broker = new CodexRequests();
  const params = { threadId: "thread", turnId: null, mode: "url", serverName: "server", message: "Connect account", url: "https://example.com/auth", elicitationId: "auth" };
  const reply = broker.request("url", "mcpServer/elicitation/request", params);
  assert.equal(broker.list("thread")[0]?.kind, "url");
  broker.respond("url", { action: "accept" });
  assert.deepEqual(await reply, { action: "accept", content: null, _meta: null });
  const rejected = broker.request("unsafe", "mcpServer/elicitation/request", { ...params, url: "javascript:alert(1)" });
  assert.equal(broker.list("thread")[0]?.kind, "unsupported");
  assert.throws(() => broker.respond("unsafe", { action: "accept" }), /URL scheme/);
  broker.cancel("thread");
  assert.deepEqual(await rejected, { action: "cancel", content: null, _meta: null });
});

test("cancellation is scoped to the requested thread and turn", async () => {
  const broker = new CodexRequests();
  const first = broker.request("first", "item/tool/requestUserInput", input);
  const second = broker.request("second", "item/tool/requestUserInput", { ...input, turnId: "other" });
  const third = broker.request("third", "item/tool/requestUserInput", { ...input, threadId: "other" });
  broker.cancel("thread", "turn");
  assert.deepEqual(await first, { answers: {} });
  assert.equal(broker.list("thread").length, 1);
  assert.equal(broker.list("other").length, 1);
  broker.cancel();
  assert.deepEqual(await second, { answers: {} });
  assert.deepEqual(await third, { answers: {} });
});
