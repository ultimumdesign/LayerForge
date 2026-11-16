# LayerForge

LayerForge is a multi-layer drum instrument and sound-design plug-in. Combine
three audio samples with a band-pass noise source, shape transients, filter and
clip each layer, then process the mix through a master clipper.

The interface runs as a browser preview or inside a JUCE plug-in. The shared
Elementary Audio DSP graph powers real-time playback, offline WAV rendering,
and the native plug-in. LayerForge is free software under the
[GPL-3.0-or-later license](LICENSE).

## Get started

### Browser preview

Requires Node.js 22 or later.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Load
audio files into the three channel slots, audition with **HIT** or Space, and
export a 24-bit WAV. Browser MIDI is available when the browser supports Web
MIDI and grants access.

### Build the native plug-in

Native builds require CMake 3.22 or later, Git, and the platform's C++ build
tools. macOS also requires Xcode Command Line Tools.

```sh
npm run setup
npm run build:ui
npm run build:native
```

`npm run setup` installs the JavaScript packages and fetches the pinned JUCE
and Elementary native sources. `build:native` produces a VST3 on Windows and
macOS, and an AU as well on macOS. To build and install a VST3 on macOS, use
`npm run install:vst3`; it prompts for an install directory and defaults to
`~/Library/Audio/Plug-Ins/VST3`.

`npm run build` is a macOS-oriented convenience command: it runs checks, builds
the UI and native plug-in, then ad-hoc signs bundles at the standard VST3 and
AU installation paths. It is not the cross-platform build command. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[RELEASING.md](RELEASING.md) for published builds.

## Features

- Three sample layers with mute/solo, pitch, start delay, editable gain
  envelopes, playback trim, filtering, transient shaping, clipping, and mix.
- A band-pass noise source and a master-bus clipper.
- MIDI Note-On triggering in the native plug-in and browser audition with
  optional Web MIDI.
- A responsive per-channel waveform estimate and an offline-DSP-rendered
  stereo-sum display.
- 24-bit / 44.1 kHz WAV export, plus native plug-in project-state saving and
  self-contained `.lfpreset` export.

For control details, the signal path, export behavior, and platform differences,
see the [User Guide](USER_GUIDE.md).

## Project map

| Path | Purpose |
|---|---|
| `dsp/` | Shared DSP graph, processing nodes, and parameter/state schema |
| `src/` | React interface, browser/native audio bridge, previews, and WAV export |
| `native/` | JUCE plug-in wrapper and native host integration |
| `scripts/` | Dependency setup and local macOS VST3 installation |
| `test/` | Node.js tests |

## Documentation

- [User Guide](USER_GUIDE.md) — operation, controls, DSP signal flow, and
  platform-specific behavior
- [Contributing](CONTRIBUTING.md) — setup, checks, and pull request expectations
- [Release pipeline](RELEASING.md) — CI, versioning, artifacts, and release setup
