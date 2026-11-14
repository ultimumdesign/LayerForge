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
