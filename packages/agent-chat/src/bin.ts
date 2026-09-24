/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The host as a program. Two ways in:
//   • a terminal / sandbox: flags on the command line, the URL on stdout;
//   • an Electron utility process: the config arrives over `parentPort`
//     (never argv, which is visible to every process on the machine) and
//     the port goes back the same way.
// Either way SIGTERM, stdin EOF or a `stop` message shut it down cleanly.

import { createAgentHost } from "./host/index";
import { randomUUID } from "node:crypto";

import type { AgentHostConfig, RunningAgentHost } from "./host/index";

type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

type StartMessage = { type: "start"; config: AgentHostConfig };
type StopMessage = { type: "stop" };
type DeleteProjectMessage = { type: "deleteProject"; projectId: string };
type PreparedMessage = { type: "turn-prepared"; id: string; error?: string };

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[arg.slice(2)] = next;
        i++;
      } else out[arg.slice(2)] = true;
    }
  }
  return out;
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  let running: RunningAgentHost | null = null;
  let stopping = false;

  const stop = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await running?.stop();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

  if (parentPort) {
    const preparations = new Map<string, { resolve: (release: () => void) => void; reject: (error: Error) => void }>();
    const prepareTurn: NonNullable<AgentHostConfig["prepareTurn"]> = (input) => new Promise((resolve, reject) => {
      const id = randomUUID();
      preparations.set(id, { resolve, reject });
      parentPort.postMessage({ type: "prepare-turn", id, ...input });
    });
    parentPort.on("message", ({ data }) => {
      const message = data as StartMessage | StopMessage | DeleteProjectMessage | PreparedMessage;
      if (message?.type === "turn-prepared") {
        const pending = preparations.get(message.id);
        if (!pending) return;
        preparations.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(() => parentPort.postMessage({ type: "release-turn", id: message.id }));
        return;
      }
      if (message?.type === "stop") void stop();
      if (message?.type === "deleteProject") running?.deleteChats(message.projectId);
      if (message?.type !== "start") return;
      createAgentHost({ ...message.config, prepareTurn, log: (line) => console.error(`[agent-chat] ${line}`) })
        .then((host) => {
          running = host;
          parentPort.postMessage({ type: "listening", port: host.port, url: host.url });
        })
        .catch((error: Error) => {
          parentPort.postMessage({ type: "error", message: error.message });
          void stop(1);
        });
    });
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const token = process.env.AGENT_CHAT_TOKEN;
  const dataDir = str(args["data-dir"]);
  if (!token || !dataDir) {
    console.error("usage: AGENT_CHAT_TOKEN=<token> [AGENT_CHAT_MCP_URL=<url>] agent-host --data-dir <dir> [--host 127.0.0.1] [--port 0] [--origin <origin>...]");
    process.exit(2);
  }
  const mcpUrl = process.env.AGENT_CHAT_MCP_URL;
  const origins = str(args.origin)?.split(",");
  running = await createAgentHost({
    host: str(args.host),
    port: args.port ? Number(args.port) : undefined,
    token,
    dataDir,
    mcp: mcpUrl ? { name: "diffusion", url: mcpUrl } : null,
    allowedOrigins: origins,
    instructions: str(args.instructions),
    version: str(args.version) ?? "0.0.0",
  });
  console.log(running.url);
  process.stdin.on("end", () => void stop());
  process.stdin.on("close", () => void stop());
  process.stdin.resume();
}

void main();
