# fonts

List the fonts available to `<text>`: Google Fonts families downloaded on demand and fonts installed on this machine. These names are valid `fontFamily` values; each family lists its variants.

| | |
| --- | --- |
| MCP tool | `fonts` |
| CLI | `dapi fonts [options]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `family` | `string` | `-f, --family <pattern>` | filter to families whose name contains this (case-insensitive) |
| `provider` | `"google" \| "local"` | `-p, --provider <provider>` | filter to Google Fonts families or to fonts installed on this machine |
| `popular` | `boolean` | `--popular` | only the popular families the editor's font picker leads with |
| `weights` | `string[]` | `-w, --weights <weights...>` | filter to variants with the given CSS weights, e.g. ["400", "700"] |
| `style` | `"normal" \| "italic"` | `-s, --style <style>` | filter to variants with the given style, normal or italic |
| `limit` | `integer` | `-l, --limit <n>` | return at most this many families (default: 50) |

Font families listed here are valid `fontFamily` values on [`<text>`](../jsx/text.md); see [jsx/fonts.md](../jsx/fonts.md) for how a family and variant are named in a composition, and [`context`](./context.md) for the families the open project has actually loaded.

Popular families come first, then the rest alphabetically. Filter by `family` when looking for one. `total` counts all matching families before the limit. Frameyard lists installed fonts through the operating system, using Fontconfig on Linux. A family available both locally and through Google Fonts is listed once as `google`.

## Output

One JSON object:

```ts
{
  families: Array<{
    family:      string;
    provider:    "google" | "local";
    category?:   string;           // Google Fonts: sans-serif, serif, display, handwriting, monospace
    stylesheet?: string;           // Google Fonts CSS URL, for a <link> in <html>
    variants: Array<{
      weight:  string;             // CSS weight, e.g. "400"
      style:   "normal" | "italic";
      source?: string;             // CSS local() source, for an installed font
    }>;
  }>;
  total: number;                   // families matching the filters, before the limit
}
```
