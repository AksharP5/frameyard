/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authenticatedMcpUrl, readOrCreateMcpToken } from "@diffusionstudio/dapi/mcp-auth-node";

export function createMcpTransport() {
  return new StreamableHTTPClientTransport(new URL(authenticatedMcpUrl(readOrCreateMcpToken())), {
    fetch: (url, init) => fetch(url, init?.method === "DELETE"
      // Initialization failures can already have closed the SDK transport.
      // Session deletion still needs a live signal, with a short cleanup limit.
      ? { ...init, signal: AbortSignal.timeout(1_000) }
      : init),
  });
}

export async function closeMcpSession(transport: StreamableHTTPClientTransport): Promise<void> {
  // Cleanup must not replace the tool result or its original error.
  await transport.terminateSession().catch(() => {});
  await transport.close().catch(() => {});
}
