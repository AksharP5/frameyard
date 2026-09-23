# whoami

Report the authenticated account, or null if signed out.

Frameyard's default local mode does not use a Diffusion Studio account, so the
result is `{ "user": null }`. This does not report your Codex or Claude Code
sign-in status.

| | |
| --- | --- |
| MCP tool | `whoami` |
| CLI | `dapi whoami` |

## Input

None.

## Output

One JSON object:

```ts
{ user: { id: string; email?: string } | null }
```
