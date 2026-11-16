# LayerForge

**A three-channel drum-layering instrument for the DAW.** Stack up to three
samples with a synthesized noise layer, shape each with a drawn gain envelope,
transient control, filters and clipping, then glue everything through an
optional master saturator, compressor and clipper.

Built with [Elementary Audio](https://www.elementary.audio/), React and
JUCE 8. Formats: **VST3** (macOS, Windows) and **AU** (macOS). Licensed under
**GPL-3.0-or-later**.

## Highlights

- **Layering:** three mono/stereo sample channels plus a noise synth, with
  per-channel pitch, delay, filters, transient shaper, clipper, stereo width,
  mix, mute and solo.
- **Drawn dynamics:** edit trims and curved gain envelopes directly on the
  processed waveform.
- **Master bus:** reorderable noise, saturation and stereo-linked glue
  compression feeding a master clipper, ceiling and output trim.
- **See what you hear:** compare final output, pre-master sum, each channel and
  noise, with a live trace of the last hit.
- **Self-contained presets and exports:** `.lfpreset` files embed samples;
  render a 24-bit / 44.1 kHz stereo WAV and drag or copy it into the DAW.
- **Sample-accurate MIDI** handled in the audio processor; patches play with
  the editor closed. DAW parameter automation is not exposed yet.

## Documentation

| Document | For |
|---|---|
| [User guide](USER_GUIDE.md) | Controls, workflow, presets, export, troubleshooting |
| [DSP reference](docs/DSP.md) | Signal path, algorithms, ranges and known limits |
| [Architecture](docs/ARCHITECTURE.md) | How the browser, offline and native builds share one engine |
| [Contributing](CONTRIBUTING.md) | Setup, project layout, tests, pull requests |
| [Releasing](RELEASING.md) | CI, versioning, release validation |

## Quick start

**Prerequisites:** Node.js 22+, Git, CMake 3.22+ and the platform's C++
toolchain (Xcode Command Line Tools on macOS; Visual Studio build tools on
Windows) for native builds. Node.js is enough for the browser preview.

```bash
npm run setup     # npm install + JUCE 8.0.4 and the pinned Elementary runtime
npm run dev       # browser preview at http://localhost:5173
```

The preview loads WAV/audio files, triggers with Space or Web MIDI, and exports
WAVs; it does not provide host integration.

### Build the plug-in (macOS)

```bash
npm run build          # UI + universal VST3 and AU in native/build; installs nothing
npm run install:vst3   # build, copy to a VST3 folder you choose, ad-hoc sign
```

`install:vst3` defaults to `~/Library/Audio/Plug-Ins/VST3`. Rescan plug-ins in
your DAW (in Ableton Live: **Settings → Plug-Ins → Rescan**) and load
**LayerForge** on a MIDI track. `npm run build` runs lint and tests first
(`npm run check`). Windows VST3 builds come from CI or the same CMake project;
see [RELEASING.md](RELEASING.md).

### Troubleshooting

Open **SYSTEM MENU → DIAGNOSTICS** and copy the report when filing an issue.

## Project layout

```text
dsp/        Engine shared by every target: parameters, nodes, envelope, graph
src/        React UI and audio/MIDI bridge (waveforms, trace, WAV export)
native/     JUCE 8 plug-in: processor, webview editor, clipboard, native tests
scripts/    setup, build, install and release-check scripts
test/       Node tests for DSP, waveforms and release metadata
docs/       DSP reference and architecture notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Platform releases

Release Please versions the project from Conventional Commits, and CI builds a
macOS universal and a Windows x64 VST3 before creating a **draft** GitHub
Release that a maintainer validates and publishes. Builds are not signed with a
developer certificate or notarized, so macOS may show a Gatekeeper warning.
Windows needs the Microsoft Edge WebView2 Runtime. Native drag-out of a WAV is
macOS-only; on Windows save the WAV and drag the file. See
[RELEASING.md](RELEASING.md).

## License and contributing

GNU GPL v3 or later; redistributors must preserve notices and provide
corresponding source under GPL terms. To propose changes, see
[CONTRIBUTING.md](CONTRIBUTING.md).
