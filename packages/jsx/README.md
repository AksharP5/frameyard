# @diffusionstudio/jsx

The editor supplies the runtime when a project is mounted, so this package is
needed for **types and tooling** — IntelliSense and `tsc --noEmit`. It carries
no renderer: `useTicker` is a declaration that throws outside a mount, and
elements only become a composition once the editor renders them. The pure
helpers (`generate.*`, `parseTime`, the source-stamp constants) are real here;
everything else is a type.

See [reference/jsx](https://github.com/AksharP5/frameyard/blob/main/docs/reference/jsx/README.md)
for the authoring surface itself.

`generate.*` declares assets for the inherited hosted service. Frameyard's
default local mode cannot run those declarations; import local media or use the
in-app Assistant with your own provider account.


## License

[MPL-2.0](./LICENSE)
