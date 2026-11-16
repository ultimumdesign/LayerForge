# Contributing to LayerForge

Thanks for helping improve LayerForge. Contributions are welcome under the
project's GPL-3.0-or-later license.

For the GitHub Actions checks, version PRs, and release process, see
[RELEASING.md](RELEASING.md).

## Start with a GitHub Issue

Before starting a change, search the
[open and closed issues](https://github.com/ultimumdesign/LayerForge/issues)
to see whether it has already been discussed.

- For a bug, open an issue with steps to reproduce, expected behavior, and
  relevant platform details.
- For a feature or larger change, open an issue to describe the problem and
  proposed solution. Use the issue to ask whether a maintainer or another
  contributor can prepare a pull request, or say that you would like to work on
  one yourself.
- Wait for discussion on substantial changes before investing in implementation.
  An issue helps agree on scope; it is not a guarantee that a change will be
  accepted.
- For small, self-contained fixes, you may open a pull request directly, but
  link any related issue.

## Open a pull request

1. Fork the repository and create a branch for your change.
2. Keep the change focused, and avoid committing generated output such as
   `dist/` or `native/build/`.
3. Use a [Conventional Commit](https://www.conventionalcommits.org/) for each
   commit and the pull request title. For example, use `fix:` for a patch,
   `feat:` for a minor release, and `!` or a `BREAKING CHANGE:` footer for a
   breaking change. Release Please uses these messages to prepare version
   updates; do not bump `package.json` manually for a normal feature or fix.
4. Run the relevant checks:

   ```sh
   npm ci
   npm run lint
   npm run lint:shell
   npm run lint:native
   npm test
   npm run check:release
   npm audit --audit-level=high
   npm run build:ui
   ```

   The native formatting check requires `clang-format`, and the shell check
   requires ShellCheck. Native changes should also be compiled with the
   project's CMake build after running `npm run setup` to fetch native
   dependencies. CI builds the VST3 on macOS and Windows.
5. Open a pull request against `main`. Describe the change and its validation,
   and link the discussion with `Closes #123` when it resolves an issue.
6. Respond to review feedback and keep the pull request focused on the agreed
   scope.

## Contribution expectations

- Preserve existing behavior unless the issue explicitly calls for a change.
- Include or update focused tests for behavior changes.
- Do not include secrets, proprietary samples, or unrelated formatting changes.
- Keep license and copyright notices intact.

## Testing waveform changes

`npm run check` runs lint and the Node test suite. Both `npm run build:ui` and
`npm run build:native` run these checks first; direct Vite or CMake calls bypass
them. The tests cover DSP and waveform data, not every host workflow.

When adding or changing waveform capabilities:

1. Add a focused case to `test/waveform.test.js`. Start with
   `createLoadedPatch` and a short deterministic sample, such as silence with
   a single impulse; provide the sample under its VFS key.
2. Assert the feature's actual output: time-bin location, signed min/max,
   path coordinates, duration or amplitude. Cover relevant edge cases such
   as silence, boundaries, zoom, short transients and missing data. Confirm
   display-only changes do not alter audio.
3. If sound changes, compare samples from `renderWaveformPreview` or
   `OfflineRenderer` against a known baseline. Do not assume nonlinear effects
   scale linearly. Cover left and right independently, mono compatibility,
   stereo-linked processing, and live/offline lane consistency when relevant.
   For persisted settings, test both a round trip and an older patch without
   the new field.
4. Run `npm run check`, and manually inspect the browser or a plugin host when
   interaction, themes, resizing or real-time behavior is involved. For a
   bug fix, add a regression case that fails without the fix when practical.

Summarize the commands and manual checks in the pull request; do not claim a
passing suite proves behavior that was not tested.
