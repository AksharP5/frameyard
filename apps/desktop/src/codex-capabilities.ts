import { object, string } from "./codex-protocol";

export type CodexSkill = { name: string; path: string; description: string };
export type CodexCapabilities = {
  skills: CodexSkill[];
  mcpServers: { name: string; status: string; toolCount: number }[];
  errors: string[];
};
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid Codex capability list");
  return value;
}

async function listSkills(request: Request, dir: string) {
  const response = object(await request("skills/list", { cwds: [dir], forceReload: true }));
  const skills = new Map<string, CodexSkill>();
  const errors: string[] = [];
  for (const entry of rows(response.data).map(object)) {
    if (entry.cwd !== dir) continue;
    for (const skill of rows(entry.skills).map(object)) {
      if (skill.enabled !== true) continue;
      const path = string(skill.path, "skill path");
      skills.set(path, { path, name: string(skill.name, "skill name"), description: string(skill.description, "skill description") });
    }
    for (const error of rows(entry.errors).map(object)) errors.push(string(error.message, "skill error"));
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

async function listMcpServers(request: Request, threadId?: string) {
  const servers: CodexCapabilities["mcpServers"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = object(await request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", threadId, cursor }));
    for (const server of rows(response.data).map(object)) {
      servers.push({
        name: string(server.name, "MCP server name"),
        status: typeof server.runtimeStatus === "string" ? server.runtimeStatus : server.authStatus === "notLoggedIn" ? "authenticationRequired" : "configured",
        toolCount: Object.keys(object(server.tools)).length,
      });
    }
    cursor = response.nextCursor == null ? undefined : string(response.nextCursor, "MCP cursor");
    if (cursor && cursors.has(cursor)) throw new Error("Codex repeated the MCP list cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCapabilities(request: Request, dir: string, threadId?: string): Promise<CodexCapabilities> {
  const [skills, mcp] = await Promise.allSettled([listSkills(request, dir), listMcpServers(request, threadId)]);
  const result: CodexCapabilities = { skills: [], mcpServers: [], errors: [] };
  if (skills.status === "fulfilled") Object.assign(result, skills.value);
  else result.errors.push(`Skills: ${skills.reason instanceof Error ? skills.reason.message : String(skills.reason)}`);
  if (mcp.status === "fulfilled") result.mcpServers = mcp.value;
  else result.errors.push(`MCP servers: ${mcp.reason instanceof Error ? mcp.reason.message : String(mcp.reason)}`);
  return result;
}

export async function validateSkills(request: Request, dir: string, selected: readonly Pick<CodexSkill, "name" | "path">[]) {
  if (!selected.length) return [];
  const { skills } = await listSkills(request, dir);
  return [...new Map(selected.map((selection) => [selection.path, selection])).values()].map((selection) => {
    const skill = skills.find((candidate) => candidate.path === selection.path && candidate.name === selection.name);
    if (!skill) throw new Error(`Skill is unavailable or disabled: ${selection.name}`);
    return { type: "skill" as const, name: skill.name, path: skill.path };
  });
}
