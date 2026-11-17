# GitHub release pipeline

The plug-in release pipeline is defined in
[`.github/workflows/release.yml`](./.github/workflows/release.yml). It uses
Conventional Commits and Release Please to version the app, then publishes
macOS and Windows VST3 builds only after the quality checks and both builds
succeed. Releases are drafts until a maintainer verifies and publishes them.

## What runs

The workflow runs on pull requests targeting `main`, pushes to `main`, and
manual dispatches:

1. **Quality** installs the locked Node dependencies, audits them for known
   high/critical vulnerabilities, checks release-version consistency,
   validates Conventional Commit messages, runs ESLint and the tests, then
   checks shell scripts with ShellCheck and native clipboard files with
   clang-format.
2. **Security** runs CodeQL on JavaScript and, during the macOS build, native
   C++. Code scanning must be available and enabled for the repository; private
   repositories may require GitHub Code Security. Disable CodeQL default setup
   if it conflicts with this advanced workflow. Successful analysis uploads
   findings but does not itself fail on alerts; review them before publishing.
3. **Build matrix** starts only after quality and JavaScript security pass. The macOS runner builds a
   universal VST3; the Windows runner builds an x64 VST3. Each runner packages
   and checks its ZIP and binary; macOS also runs native MIDI and host-state
   tests and checks signature, architectures and bundle version. Each uploads
   its ZIP as a workflow artifact.
4. **Release** runs only for pushes to `main`, after both matrix builds pass.
   Release Please either opens/updates a version PR or, when a version PR has
   been merged, creates the version tag and a draft GitHub Release. The job
   verifies the tag points to the built commit, then uploads both VST3 ZIPs.
   If the commit does not match, the job fails instead of attaching the wrong
   binaries; investigate and build the tagged commit before publishing.

Pull requests and **Actions → Build plug-in releases → Run workflow** builds
produce downloadable workflow artifacts but do not publish a GitHub Release.
Tag pushes alone do not start a build; draft releases are created by the
successful main-branch pipeline.

The dependency audit covers npm packages, not the native JUCE, Elementary or
WebView2 dependencies. CodeQL and archive checks do not prove DAW behavior or
catch every vulnerability. Run `npm audit --audit-level=high` and
`npm run check:release` locally as needed; the npm registry must be reachable
for the audit. Workflow actions are pinned to commit SHAs; update those pins
deliberately when upgrading the actions.

## Conventional Commits and versions

Use Conventional Commit messages for PR titles and commits:
Subject text may start with an acronym such as LCD; all-uppercase subjects
remain disallowed.

| Commit | Version change |
|---|---|
| `fix: correct trim playback` | Patch |
| `feat: add sample reverse` | Minor |
| `feat!: replace the preset format` or a `BREAKING CHANGE:` footer | Major |
| `docs: clarify the controls`, `test: cover trim`, `chore: update tooling` | No release by default |

Push validation skips GitHub squash-merge messages with a non-conventional
`title (#number)` and a generated bullet-list body. PR titles and ordinary
commits are still checked. Use a Conventional Commit PR title when squash
merging: Release Please cannot infer a version bump from a non-conventional
squash title, even when its body lists conventional commits.

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

## Release validation

Before publishing a draft, validate the exact ZIPs from that draft:

1. Verify the tag, version, changelog, source and both platform assets match.
   Test clean installation on macOS (both architectures where available) and
   Windows, including plug-in discovery and the WebView2 runtime requirement.
2. In supported DAWs, test MIDI playback with the editor both open and closed,
   timing, host project save/reopen, preset round-trips, sample loading, WAV
   save, sample import and clipboard paste. Check behavior after multiple instances, playback
   start/stop, editor reopen, and sample-rate or buffer-size changes.
3. Address or explicitly accept the known limitations in
   [USER_GUIDE.md](USER_GUIDE.md#limitations-and-validation). In particular,
   DAW parameter automation is not exposed. WAV paste has been reported working
   in Ableton on macOS, but other hosts and Windows require validation; WAV
   drag-out is not available. Native MIDI is handled
   sample-accurately in the audio processor and should work with the editor
   closed; confirm this in each DAW. A successful build is not sufficient
   evidence for these workflows.
4. Confirm distribution licensing obligations, the unsigned/notarization
   warning, and installation instructions. Publish the draft only when its
   intended release criteria are met.

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
