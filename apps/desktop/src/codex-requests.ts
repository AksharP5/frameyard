import { z } from "zod";

const identity = z.object({ threadId: z.string().min(1), turnId: z.string().nullable().optional() });
const option = z.object({ label: z.string(), description: z.string() });
const question = z.object({ id: z.string().min(1), header: z.string(), question: z.string(), isOther: z.boolean(), isSecret: z.boolean(), options: z.array(option).nullable() });
const inputParams = identity.extend({ questions: z.array(question).min(1), isBlocking: z.boolean().optional() });
const specialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(), z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(), z.object({ kind: z.literal("slash_tmp") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("unknown"), path: z.string(), subpath: z.string().nullable() }).strict(),
]);
const filePath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string() }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }).strict(),
  z.object({ type: z.literal("special"), value: specialPath }).strict(),
]);
const permissions = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(),
  fileSystem: z.object({
    read: z.array(z.string()).nullable(), write: z.array(z.string()).nullable(),
    globScanMaxDepth: z.number().int().nonnegative().optional(),
    entries: z.array(z.object({ path: filePath, access: z.enum(["read", "write", "deny"]) }).strict()).optional(),
  }).strict().nullable(),
}).strict();
const permissionParams = identity.extend({ cwd: z.string(), reason: z.string().nullable(), permissions });
const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]);
const fieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  title: z.string().optional(), description: z.string().optional(), default: valueSchema.optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  enum: z.array(z.string()).optional(), enumNames: z.array(z.string()).optional(),
  oneOf: z.array(z.object({ const: z.string(), title: z.string() }).strict()).optional(),
  items: z.union([
    z.object({ type: z.literal("string").optional(), enum: z.array(z.string()) }).strict(),
    z.object({ anyOf: z.array(z.object({ const: z.string(), title: z.string() }).strict()) }).strict(),
  ]).optional(),
}).strict().superRefine((field, context) => {
  const common = ["type", "title", "description", "default"];
  const constraints = field.type === "string" ? ["minLength", "maxLength", "format", "enum", "enumNames", "oneOf"]
    : field.type === "array" ? ["items", "minItems", "maxItems"]
    : field.type === "number" || field.type === "integer" ? ["minimum", "maximum"] : [];
  for (const key of Object.keys(field)) {
    if (![...common, ...constraints].includes(key)) context.addIssue({ code: "custom", message: `Unsupported ${key} constraint for ${field.type}` });
  }
  if (field.enum && field.oneOf) context.addIssue({ code: "custom", message: "Conflicting enum choices" });
  if (field.enumNames && field.enumNames.length !== field.enum?.length) context.addIssue({ code: "custom", message: "Enum labels must match choices" });
  if (field.type === "array" && !field.items) context.addIssue({ code: "custom", message: "Array fields need enumerated choices" });
  if (field.type !== "array" && field.items) context.addIssue({ code: "custom", message: "Only arrays can contain items" });
});
const formSchema = z.object({ $schema: z.string().optional(), type: z.literal("object"), properties: z.record(z.string(), fieldSchema), required: z.array(z.string()).optional(), additionalProperties: z.literal(false).optional() }).strict()
  .refine((schema) => (schema.required ?? []).every((key) => Object.hasOwn(schema.properties, key)), "Required field is missing from properties");
const elicitationParams = identity.extend({ mode: z.enum(["form", "openai/form", "openaiForm", "url"]), serverName: z.string(), message: z.string(), requestedSchema: z.unknown().optional(), url: z.string().optional() });
export type CodexFormField = z.infer<typeof fieldSchema>;
export type CodexFormValue = z.infer<typeof valueSchema>;
type RequestIdentity = { id: string; threadId: string; turnId: string | null };
export type CodexPendingRequest = RequestIdentity & (
  | { kind: "input"; questions: z.infer<typeof question>[]; isBlocking: boolean }
  | { kind: "permissions"; cwd: string; reason: string | null; permissions: z.infer<typeof permissions> }
  | { kind: "form"; serverName: string; message: string; schema: z.infer<typeof formSchema> }
  | { kind: "url"; serverName: string; message: string; url: string }
  | { kind: "unsupported"; serverName: string; message: string; error: string }
);
export const codexRequestResponseSchema = z.union([
  z.object({ action: z.enum(["cancel", "decline"]) }).strict(),
  z.object({ action: z.literal("accept"), answers: z.record(z.string(), z.array(z.string())).optional(), content: z.record(z.string(), valueSchema).optional(), scope: z.enum(["turn", "session"]).optional() }).strict(),
]);
export type CodexRequestResponse = z.infer<typeof codexRequestResponseSchema>;

export function formChoices(field: CodexFormField): { value: string; label: string }[] | undefined {
  if (field.type === "array" && field.items) {
    if ("enum" in field.items) return field.items.enum.map((value) => ({ value, label: value }));
    return field.items.anyOf.map((item) => ({ value: item.const, label: item.title }));
  }
  if (field.enum) return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  return field.oneOf?.map((item) => ({ value: item.const, label: item.title }));
}

function validateField(name: string, field: CodexFormField, value: CodexFormValue): void {
  const fail = (message: string): never => { throw new Error(`${name}: ${message}`); };
  const choices = formChoices(field);
  if (field.type === "array") {
    if (!Array.isArray(value)) return fail("Select the requested values");
    const values = value;
    if (new Set(values).size !== values.length || values.some((entry) => !choices?.some((choice) => choice.value === entry))) fail("Invalid selection");
    if (field.minItems !== undefined && values.length < field.minItems) fail(`Select at least ${field.minItems}`);
    if (field.maxItems !== undefined && values.length > field.maxItems) fail(`Select at most ${field.maxItems}`);
    return;
  }
  if (field.type === "boolean") { if (typeof value !== "boolean") fail("Choose yes or no"); return; }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("Enter a number");
    const number = value;
    if (field.type === "integer" && !Number.isInteger(number)) fail("Enter a whole number");
    if (field.minimum !== undefined && number < field.minimum) fail(`Minimum is ${field.minimum}`);
    if (field.maximum !== undefined && number > field.maximum) fail(`Maximum is ${field.maximum}`);
    return;
  }
  if (typeof value !== "string") return fail("Enter text");
  const text = value;
  if (choices && !choices.some((choice) => choice.value === text)) fail("Invalid selection");
  if (field.minLength !== undefined && text.length < field.minLength) fail(`Use at least ${field.minLength} characters`);
  if (field.maxLength !== undefined && text.length > field.maxLength) fail(`Use at most ${field.maxLength} characters`);
  if (field.format === "email" && !z.string().email().safeParse(text).success) fail("Enter an email address");
  if (field.format === "uri" && !z.string().url().safeParse(text).success) fail("Enter a URI");
  if (field.format === "date" && !z.string().date().safeParse(text).success) fail("Enter a date as YYYY-MM-DD");
  if (field.format === "date-time" && !z.string().datetime({ offset: true }).safeParse(text).success) fail("Enter a date and time with a timezone");
}

function nativeResponse(request: CodexPendingRequest, response: CodexRequestResponse): unknown {
  if (request.kind === "input") {
    if (response.action !== "accept") return { answers: {} };
    const answers = response.answers ?? {};
    if (Object.keys(answers).some((key) => !request.questions.some((question) => question.id === key))) throw new Error("Unknown question");
    for (const question of request.questions) {
      const values = answers[question.id];
      if (!values?.length || values.some((value) => !value.trim())) throw new Error(`Answer ${question.header || question.id}`);
      if (question.options?.length && !question.isOther && values.some((value) => !question.options?.some((option) => option.label === value))) throw new Error(`Choose an option for ${question.header || question.id}`);
    }
    return { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) };
  }
  if (request.kind === "permissions") return {
    permissions: response.action === "accept" ? {
      ...(request.permissions.network ? { network: request.permissions.network } : {}),
      ...(request.permissions.fileSystem ? { fileSystem: request.permissions.fileSystem } : {}),
    } : {}, scope: response.action === "accept" ? response.scope ?? "turn" : "turn",
  };
  if (response.action !== "accept") return { action: response.action, content: null, _meta: null };
  if (request.kind === "unsupported") throw new Error(request.error);
  if (request.kind === "url") return { action: "accept", content: null, _meta: null };
  const content = response.content ?? {};
  if (Object.keys(content).some((key) => !Object.hasOwn(request.schema.properties, key))) throw new Error("Unknown form field");
  for (const [name, field] of Object.entries(request.schema.properties)) {
    const value = content[name];
    if (value === undefined) {
      if (request.schema.required?.includes(name)) throw new Error(`Answer ${field.title ?? name}`);
      continue;
    }
    validateField(field.title ?? name, field, value);
  }
  return { action: "accept", content, _meta: null };
}

export class CodexRequests {
  private pending = new Map<string, { request: CodexPendingRequest; resolve: (reply: unknown) => void }>();
  private onChange: () => void;

  constructor(onChange: () => void = () => {}) { this.onChange = onChange; }

  request(id: string, method: string, params: unknown): Promise<unknown> {
    if (this.pending.has(id)) throw new Error("Duplicate Codex request ID");
    const context = identity.parse(params);
    const base = { id, threadId: context.threadId, turnId: context.turnId ?? null };
    let request: CodexPendingRequest;
    if (method === "item/tool/requestUserInput") {
      const input = inputParams.parse(params);
      if (new Set(input.questions.map((question) => question.id)).size !== input.questions.length) throw new Error("Duplicate question ID");
      request = { ...base, kind: "input", questions: input.questions, isBlocking: input.isBlocking ?? true };
    } else if (method === "item/permissions/requestApproval") {
      const input = permissionParams.parse(params);
      request = { ...base, kind: "permissions", cwd: input.cwd, reason: input.reason, permissions: input.permissions };
    } else if (method === "mcpServer/elicitation/request") {
      const input = elicitationParams.parse(params);
      const details = { ...base, serverName: input.serverName, message: input.message };
      if (input.mode === "url") {
        const url = z.string().url().parse(input.url);
        request = /^https?:\/\//i.test(url)
          ? { ...details, kind: "url", url }
          : { ...details, kind: "unsupported", error: "This MCP request uses an unsupported URL scheme." };
      } else {
        const schema = formSchema.safeParse(input.requestedSchema);
        request = schema.success
          ? { ...details, kind: "form", schema: schema.data }
          : { ...details, kind: "unsupported", error: `This MCP form is not supported: ${schema.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
      }
    } else throw new Error(`Unsupported Codex request: ${method}`);
    return new Promise((resolve) => {
      this.pending.set(id, { request, resolve });
      this.onChange();
    });
  }

  list(threadId: string): CodexPendingRequest[] {
    return [...this.pending.values()].filter(({ request }) => request.threadId === threadId).map(({ request }) => request);
  }

  respond(id: string, value: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("This request is no longer pending");
    const reply = nativeResponse(entry.request, codexRequestResponseSchema.parse(value));
    this.pending.delete(id);
    entry.resolve(reply);
    this.onChange();
  }

  cancel(threadId?: string, turnId?: string): void {
    for (const [id, entry] of this.pending) {
      if (threadId !== undefined && entry.request.threadId !== threadId) continue;
      if (turnId !== undefined && entry.request.turnId !== turnId) continue;
      this.respond(id, { action: "cancel" });
    }
  }
}
