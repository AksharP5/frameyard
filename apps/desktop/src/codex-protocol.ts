import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Codex response object");
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}

export const optionalString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

type RpcId = string | number;
type RpcMessage =
  | { kind: "response"; id: RpcId; result: unknown; error?: string }
  | { kind: "request"; id: RpcId; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> };

function parseMessage(line: string): RpcMessage {
  const value = object(JSON.parse(line));
  const id = typeof value.id === "string" || typeof value.id === "number" ? value.id : undefined;
  if (typeof value.method === "string") {
    const params = value.params === undefined ? {} : object(value.params);
    return id === undefined
      ? { kind: "notification", method: value.method, params }
      : { kind: "request", id, method: value.method, params };
  }
  if (id === undefined) throw new Error("Invalid Codex response id");
  return { kind: "response", id, result: value.result, error: value.error ? optionalString(object(value.error).message) ?? "Codex request failed" : undefined };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One local Codex subprocess; JSON-RPC never leaves Electron main. */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private options: {
    binary?: string;
    notification: (method: string, params: Record<string, unknown>) => void;
    serverRequest: (method: string, params: Record<string, unknown>, id: RpcId) => Promise<unknown>;
    exited: (error: Error) => void;
  };

  constructor(options: CodexAppServer["options"]) {
    this.options = options;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.starting && !this.child) this.starting = this.launch().finally(() => { this.starting = null; });
    if (this.starting) await this.starting;
    return this.sendRequest(method, params);
  }

  dispose(): void {
    const child = this.child;
    if (!child) return;
    this.stopped(child, new Error("Codex connection closed"));
    child.kill();
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    const terminate = setTimeout(() => child.kill(), 5000);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      exited.reject(new Error("Codex did not release the session in time. Try Copy resume again."));
    }, 10_000);
    this.stopped(child, new Error("Codex session released to terminal"));
    child.stdin.end();
    try {
      await exited.promise;
    } finally {
      clearTimeout(terminate);
      clearTimeout(timeout);
    }
  }

  private async launch(): Promise<void> {
    const child = spawn(this.options.binary ?? process.env.CODEX_BIN ?? "codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    child.on("error", (error) => this.stopped(child, new Error(`Could not start Codex: ${error.message}. Install Codex CLI and run codex login.`)));
    child.on("exit", (code) => this.stopped(child, new Error(`Codex app server exited with code ${code}`)));
    child.stdin.on("error", () => this.stopped(child, new Error("Codex input stream closed")));
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child || !line.trim()) return;
      try {
        this.receive(parseMessage(line));
      } catch {
        this.stopped(child, new Error("Codex returned an invalid protocol message"));
        child.kill();
      }
    });
    try {
      await this.sendRequest("initialize", {
        clientInfo: { name: "frameyard", title: "Frameyard", version: "0.204.1-linux.1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.send({ method: "initialized", params: {} });
    } catch (error) {
      this.stopped(child, error instanceof Error ? error : new Error("Codex initialization failed"));
      child.kill();
      throw error;
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private send(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app server is not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(message: RpcMessage): void {
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.kind === "notification") {
      this.options.notification(message.method, message.params);
      return;
    }
    const child = this.child;
    void this.options.serverRequest(message.method, message.params, message.id).then(
      (result) => { if (child === this.child) this.send({ id: message.id, result }); },
      (error: unknown) => {
        if (child === this.child) this.send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Editor tool failed" } });
      },
    );
  }

  private stopped(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.exited(error);
  }
}
