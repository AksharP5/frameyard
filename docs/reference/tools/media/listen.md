# media_listen

Ask a hosted model to analyze an audio track and return its answer. This tool is
unavailable in Frameyard's default local mode. In a separately configured hosted
build, it accepts audio or video, uploads the audio to Diffusion Studio's service,
and requires a signed-in account. For local work, use
[`media_transcribe`](./transcribe.md) for speech and
[`media_waveform`](./waveform.md) to inspect timing and silence.

| | |
| --- | --- |
| MCP tool | `media_listen` |
| CLI | `dapi media listen <path> [options]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `path` | `string`, required | `<path>` | absolute file path or URL (works with or without an open project), or a library path like `b-roll/clip.mp4` (needs an open project) |
| `prompt` | `string` | `-p, --prompt <str>` | question or instruction to guide the analysis |
| `start` | `Time` | `-s, --start <time>` | start of the segment to analyze (default: 0); timestamps in the analysis are relative to this point |
| `end` | `Time` | `-e, --end <time>` | end of the segment to analyze (default: media duration) |

In a hosted build, no `prompt` returns a general description. A prompt asks a
specific question about the audio. Timestamps in the answer are relative to the
requested window. The [local audio guide](../../../guides/prompts/media-listen.md)
shows the offline path. Hosted analysis may incur account charges.

## Output

One JSON object, the model's answer. `start`/`end` echo the analyzed window (in seconds) and are present only when a window was given:

```ts
{ result: string, start?: number, end?: number }
```

## Errors

Fails in local mode, or when the path cannot be resolved, the asset is not video
or audio, `start` is at or after `end`, or no hosted account is signed in.
