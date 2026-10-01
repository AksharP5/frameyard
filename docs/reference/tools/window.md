# window

Show or hide Frameyard's review window, or report whether it is showing. Project agents keep working while the window is hidden. Use [`workspace show`](../../agent-workspace.md#parallel-videos) to review a specific project. Closing the window hides it without stopping background work.

| | |
| --- | --- |
| MCP tool | `window` |
| CLI | `dapi window [show\|hide]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `visible` | `boolean` | `show` / `hide` | true to show and focus the window, false to hide it (default: leave it as it is) |

Frameyard remains available through the tray while the window is hidden. Background work continues, and an idle hidden window can be released to free memory. Showing the window again restores the review surface.

## Output

One JSON object: whether the window is showing after the call. A minimized window counts as showing.

```ts
{ visible: boolean }
```

## Errors

Fails when `visible` is not a boolean, or the CLI's state is neither `show` nor `hide`.
