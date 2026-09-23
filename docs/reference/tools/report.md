# report

File a public issue for a Frameyard bug through the authenticated `gh` CLI and
return its URL. Submission is immediate. The report includes the app version
and platform; logs are included only when requested. Review the title, body,
and any logs before running this command.

| | |
| --- | --- |
| MCP tool | `report` |
| CLI | `dapi report <title> [options]` |
| CLI aliases | `dapi issue` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `title` | `string`, required | `<title>` | one-line summary of the problem |
| `body` | `string` | `-b, --body <text>` | what happened, in markdown: expected vs actual, and anything the diagnostics won't show |
| `commands` | `string[]` | `-c, --commands <cmd...>` | the dapi commands or tool calls that reproduce it, in order |
| `logs` | `integer` | `--logs <n>` | trailing app log entries to attach (0 to omit; default: 0) |

Use this for a reproducible editor or CLI defect. It files the issue in
[AksharP5/frameyard](https://github.com/AksharP5/frameyard/issues), with the
app version, platform, and Electron version. Add reproduction commands with
`-c` and opt into recent logs with `--logs` when useful.

The issue is submitted immediately, with no review step: the call returns once the issue exists. Filing goes through the [`gh`](https://cli.github.com) CLI, which must be installed and authenticated (`gh auth login`) on this machine; without it nothing is filed. It runs in the app's main process, so no project needs to be open.

This is for defects in the tooling, not for problems inside a project: a composition that looks wrong, a node in the wrong place, or a generation that missed the prompt are editing problems, not reported here.

## Output

One JSON object:

```ts
{
  url: string  // the created github.com/AksharP5/frameyard issue
}
```

`commands` appear under `## Repro` in the order given. From a shell, repeat
`-c` for each command. Attached logs are the same entries [`logs`](./logs.md)
returns and may contain project names, file paths, or prompt text. Check them
before opting in; `--logs 0` leaves them out.

## Errors

Fails on an empty title, a `logs` value below 0, a missing `gh`, or a failure from `gh` (not authenticated, no access to the repo); the message from `gh` is passed through.
