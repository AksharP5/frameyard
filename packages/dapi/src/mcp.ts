/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixed loopback address for MCP. Clients add the current user's private
// credential to the URL; the Host check is an additional browser defense.
export const MCP_HOST = "127.0.0.1";
export const MCP_PORT = 3274;
export const MCP_PATH = "/mcp";
export const MCP_URL = `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;
