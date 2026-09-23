# Contributing to Frameyard

Frameyard is a Linux video editor built from the MPL-2.0 Diffusion Studio codebase. Start with the [README](README.md) and the [Linux guide](docs/linux.md). Open an issue before a large feature or architecture change so the work fits the editor's direction.

## Work locally

Use Node 22.18 or newer. From a clean checkout:

```sh
npm ci
npm run check
npm run lint
npm test
npm run build
```

`npm run dev` opens the desktop app against a local Vite server. Local transcription and animation tools need `npm run setup:local` and the system packages listed in the [Linux guide](docs/linux.md). The GitHub Linux workflow exercises the app with those tools installed.

Keep changes focused and based on the latest `main`. Add tests for a reproduced bug or a meaningful behavior change. Update the relevant user guide when behavior or a command changes. Run the checks above before opening a pull request and say which checks you could not run. Pull request titles follow the repository's conventional commit style, such as `fix(editor): keep a canceled drag out of undo history`.

Project files are executable JSX, and local media often contains private material. Use disposable fixtures in tests. Do not commit credentials, recordings, logs, model caches, or assets whose license does not allow redistribution. Preserve existing MPL notices and include the license and provenance for third-party fonts or media you add.

## Releases

Maintainers cut releases from a clean, up-to-date `main` with `npm run release patch` (or `minor` or `major`). The script updates the app versions, lockfile, commit, and tag. Pushing the tag runs the Linux verification workflow and publishes its tested archive. [Linux releases](docs/releases.md) explains what users receive.

For a security issue, use the private path in [SECURITY.md](SECURITY.md) rather than a public pull request or issue containing exploit details.
