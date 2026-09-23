/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `dapi mcp`: the entry point for agents that only run stdio servers (Claude
// Desktop). A message pipe between stdio and the app's HTTP endpoint: each
// side is an SDK transport, so session handling and SSE framing are theirs,
// and nothing here looks inside a message. Stdout belongs to the protocol;
// anything for a human goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_NAME, isAppDown, launchApp, ping, waitForApp } from "./cli-client";
import { createMcpTransport, closeMcpSession } from "./mcp-session";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export async function runProxy(): Promise<void> {
  try {
    await ping();
  } catch (e) {
    if (!isAppDown(e)) throw e;
    // Launching is macOS's job; elsewhere the user starts the app by hand.
    if (!(await launchApp(true))) {
      throw new Error(`${APP_NAME} is not running. Launch the app first, then retry.`);
    }
    await waitForApp();
  }

  const upstream = createMcpTransport();
  const stdio = new StdioServerTransport();
  let closing = false;

  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdin.off("end", onInputClosed);
    process.stdin.off("close", onInputClosed);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await closeMcpSession(upstream);
    await stdio.close();
    process.exit(code);
  };
  const onInputClosed = () => void shutdown(0);
  const onInterrupt = () => void shutdown(130);
  const onTerminate = () => void shutdown(143);

  const fail = (error: Error): void => {
    console.error(`[dapi mcp] ${error.message}`);
    void shutdown(1);
  };

  upstream.onmessage = (message: JSONRPCMessage) => void stdio.send(message).catch(fail);
  stdio.onmessage = (message: JSONRPCMessage) => void upstream.send(message).catch(fail);
  upstream.onerror = (error) => console.error(`[dapi mcp] ${error.message}`);
  stdio.onerror = (error) => console.error(`[dapi mcp] ${error.message}`);
  // The app went away (quit, or the session was closed): the agent sees EOF.
  upstream.onclose = () => void shutdown(0);
  // The agent went away: tell the app, which ends the session.
  stdio.onclose = onInputClosed;
  process.stdin.once("end", onInputClosed);
  process.stdin.once("close", onInputClosed);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    await upstream.start();
    await stdio.start();
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
}
