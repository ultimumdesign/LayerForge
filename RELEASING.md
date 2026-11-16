# Release pipeline

The plug-in release pipeline is defined in
[`.github/workflows/release.yml`](.github/workflows/release.yml). It validates
changes, builds platform-specific VST3 bundles, and uses Release Please to
prepare version updates and publish GitHub Releases.

## Workflow

The workflow runs for pull requests targeting `main`, pushes to `main`, and
manual dispatches:

1. **Quality** installs locked Node dependencies, validates Conventional
   Commit messages and pull request titles, runs ESLint and the tests, then
   checks shell scripts with ShellCheck and native clipboard files with
   `clang-format`.
2. **Build** starts after quality passes. macOS builds a universal VST3;
   Windows builds an x64 VST3. Each platform ZIP is uploaded as a workflow
   artifact and retained for 14 days.
3. **Publish** runs only for pushes to `main`, after both builds pass.
   Release Please opens or updates a version pull request. When that pull
   request is merged, the subsequent successful `main` workflow creates the
   version tag and GitHub Release, then uploads both platform ZIPs.

Pull request and manual-dispatch runs provide downloadable workflow artifacts
but do not publish a release. Tag pushes alone do not start a build. Releases
contain VST3s only; macOS local builds can also produce an AU.

## Versions and commit messages

Use Conventional Commit messages for pull request titles and commits:

| Example | Version effect |
|---|---|
| `fix: correct trim playback` | Patch |
| `feat: add sample reverse` | Minor |
| `feat!: replace the preset format` or a `BREAKING CHANGE:` footer | Major |
| `docs: clarify the controls`, `test: cover trim`, `chore: update tooling` | No release by default |

Release Please uses `.release-please-manifest.json` as the starting version.
Its version pull request updates `package.json`, `package-lock.json`, the
manifest, and `CHANGELOG.md`. Do not manually bump the version for ordinary
changes. CMake reads the plug-in version from `package.json`.

## Repository permissions

The publish job uses the built-in `GITHUB_TOKEN` and requests
`contents: write`, `issues: write`, and `pull-requests: write`. The workflow
and job permissions are defined in the YAML; repository or organization
policy must allow the token permissions needed by the job. In repository
**Settings → Actions → General**, allow workflow tokens to have read and write
permissions and allow GitHub Actions to create pull requests, if those
settings are available and not restricted by organization policy. No npm
publish token or code-signing secret is required.

If branch protection requires status checks on generated release pull
requests, configure a GitHub App or fine-grained token for Release Please so
the pull request event can run those checks. A workflow-created pull request
or tag made with the built-in `GITHUB_TOKEN` does not trigger a new workflow
run.

## Assets and troubleshooting

The release contains:

- `LayerForge-macos-universal-vst3.zip`
- `LayerForge-windows-x64-vst3.zip`

If quality fails, resolve the lint or test failure. If either platform build
fails, publishing does not run. A manual workflow dispatch is useful for
testing both builders and downloading artifacts without creating a release.

The workflow clears `native/build` before configuring CMake. This is generated
output and must remain untracked; a committed `CMakeCache.txt` can cause a
source/build-directory mismatch on another runner. The universal macOS build
uses the `macos-15-intel` GitHub-hosted runner.

The Windows build installs the WebView2 SDK, but Windows users still need the
Microsoft Edge WebView2 Runtime if it is not already installed. macOS release
bundles are ad-hoc signed, not Developer ID signed or notarized, so Gatekeeper
may warn when opening a downloaded plug-in.
