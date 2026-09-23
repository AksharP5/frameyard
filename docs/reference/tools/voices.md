# voices

List the speech voices available for `generate.voice` declarations in a project module.

Frameyard's default local mode returns `{ "voices": [] }`. Hosted voice
generation is unavailable there.

| | |
| --- | --- |
| MCP tool | `voices` |
| CLI | `dapi voices` |

## Input

None.

See [jsx/generate.md](../jsx/generate.md) for the declaration a voice id goes on.

## Output

One JSON object:

```ts
{ voices: Array<{ id: string; label: string; description: string }> }
```
