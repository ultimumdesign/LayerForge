# Contributing to LayerForge

Thanks for helping improve LayerForge. Contributions are welcome under the
project's GPL-3.0-or-later license.

## Before you start

Search the [open and closed issues](https://github.com/ultimumdesign/LayerForge/issues)
for related discussion. For bugs, include reproduction steps, expected
behavior, and relevant platform details. For larger changes, open an issue to
agree on the problem and scope before investing in implementation. Small,
self-contained fixes may go directly to a pull request; link a related issue
when there is one.

## Development setup

Use Node.js 22 or later. For JavaScript and UI work:

```sh
npm ci
npm run dev
```

For native plug-in work, install CMake 3.22 or later, Git, and the platform's
C++ build tools. On macOS, install Xcode Command Line Tools. Then fetch the
native dependencies and build the UI and plug-in:

```sh
npm run setup
npm run build:ui
npm run build:native
```

`npm run setup` installs the JavaScript packages and fetches the pinned JUCE
and Elementary sources. The native CMake build outputs a VST3 on Windows and
macOS, and also an AU on macOS. To install a local macOS VST3, run
`npm run install:vst3`.

## Checks

Run the checks relevant to your changes before opening a pull request:

```sh
npm run lint
npm test
npm run lint:shell
npm run lint:native
npm run build:ui
```

The test script runs the Node.js waveform tests. Shell linting requires
ShellCheck; native formatting requires `clang-format`. For native changes,
also build with `npm run build:native`. CI runs the JavaScript lint and tests,
shell lint, native formatting check, and VST3 builds on macOS and Windows.

## Pull requests

1. Fork the repository and create a focused branch.
2. Do not commit generated output such as `dist/` or `native/build/`.
3. Use a [Conventional Commit](https://www.conventionalcommits.org/) for every
   commit and the pull request title. For example, `fix:` indicates a patch,
   `feat:` a minor release, and `!` or a `BREAKING CHANGE:` footer a breaking
   change. Release Please uses these messages to prepare version updates; do
   not manually bump `package.json` for an ordinary fix or feature.
4. Open a pull request against `main`. Describe the change and its validation,
   and use `Closes #123` when it resolves an issue.
5. Respond to review feedback and keep the pull request aligned with the
   agreed scope.

Preserve existing behavior unless a change is intended, add focused tests for
behavior changes, and do not include secrets, proprietary samples, or
unrelated formatting changes. Keep license and copyright notices intact.
Release workflow details are in [RELEASING.md](RELEASING.md).
