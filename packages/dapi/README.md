# @diffusionstudio/dapi

The tool catalog behind `dapi`: one entry per tool with its name, description, and zod input and output schemas. The app registers the catalog with its MCP server, the renderer validates incoming calls against it, and the CLI derives its commands and help text from it, so the API is described exactly once.

```ts
import { catalog, toolByName, Time } from "@diffusionstudio/dapi";
import type { ToolArgs, ToolResult } from "@diffusionstudio/dapi";

const grab = toolByName("media_grab");
const args: ToolArgs<"media_grab"> = grab.input.parse({ path: "/clip.mp4", times: ["45f", "1:10"] });
```

The default package entry is free of Node built-ins so the renderer can import it. The `mcp-auth-node` subpath stores the local MCP credential for desktop and CLI clients.

See the [tool and CLI reference](../../docs/reference/tools/README.md) for
commands, arguments, and results.
