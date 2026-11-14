# GitHub release pipeline

The plug-in release pipeline is defined in
[`.github/workflows/release.yml`](./.github/workflows/release.yml). It uses
Conventional Commits and Release Please to version the app, then publishes
macOS and Windows VST3 builds only after the quality checks and both builds
succeed.

## What runs

The workflow runs on pull requests targeting `main`, pushes to `main`, and
manual dispatches:

1. **Quality** installs the locked Node dependencies, validates Conventional
   Commit messages, runs ESLint and the tests, then checks shell scripts with
   ShellCheck and native clipboard files with clang-format.
2. **Build matrix** starts only after quality passes. The macOS runner builds a
   universal VST3; the Windows runner builds an x64 VST3. Each runner packages
   and uploads its ZIP as a workflow artifact.
3. **Release** runs only for pushes to `main`, after both matrix builds pass.
   Release Please either opens/updates a version PR or, when a version PR has
   been merged, creates the version tag and GitHub Release. The job then uploads
   both VST3 ZIPs to that release.

Pull requests and **Actions → Build plug-in releases → Run workflow** builds
produce downloadable workflow artifacts but do not publish a GitHub Release.
Tag pushes alone do not start a build; releases are created by the successful
main-branch pipeline.

## Conventional Commits and versions

Use Conventional Commit messages for PR titles and commits:

| Commit | Version change |
|---|---|
| `fix: correct trim playback` | Patch |
| `feat: add sample reverse` | Minor |
| `feat!: replace the preset format` or a `BREAKING CHANGE:` footer | Major |
| `docs: clarify the controls`, `test: cover trim`, `chore: update tooling` | No release by default |

Release Please uses `.release-please-manifest.json` as the starting version and
opens a PR that updates `package.json`, `package-lock.json`, the manifest, and
`CHANGELOG.md`. Do not manually bump the version for ordinary changes. Merge the
release PR when it is ready; the merge starts a fresh quality and build run.
The CMake project reads the version from `package.json`, so the published
plug-in metadata matches the release version.

## Repository setup and permissions

The release job uses the built-in `GITHUB_TOKEN`; no npm publish or signing
secret is required. In the repository's **Settings → Actions → General**, allow
workflow tokens to have read and write permissions and allow GitHub Actions to
create pull requests. The release job requests `contents: write` to create
tags/releases, `pull-requests: write` to create or update the Release Please
PR, and `issues: write` for release PR labels.

If branch protection requires status checks on generated release PRs, configure
a GitHub App or fine-grained token for Release Please so its PR event can run
those checks. The built-in `GITHUB_TOKEN` does not trigger new workflow runs
when it creates a PR or tag.

## Release assets and troubleshooting

The release contains:

- `LayerForge-macos-universal-vst3.zip`
- `LayerForge-windows-x64-vst3.zip`

If the quality job fails, fix the lint or test failure before merging. If either
platform build fails, no release job runs. A manual workflow dispatch is useful
for validating both builders and downloading artifacts without creating a tag
or release.

The workflow clears `native/build` before configuring CMake. This directory is
generated output and must remain untracked; committing a local
`CMakeCache.txt` can make another runner fail with a source/build-directory
mismatch.

The universal macOS build uses the supported `macos-15-intel` GitHub-hosted
runner.

The Windows build uses WebView2 and installs its SDK in the workflow; the
WebView2 Runtime is still required on Windows systems where it is not already
installed. macOS downloads are ad-hoc signed, not Developer ID signed or
notarized.
