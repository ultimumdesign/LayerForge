# LayerForge VST3 / AU

**LayerForge** is a multi-layer drum designer with transient shaping, clipping, and a noise engine, built with **Elementary Audio**, **React**, and **JUCE 8**. The project is free software under **GPL-3.0-or-later**.

## Project Architecture

```text
LayerForge/
├── dsp/                     # Pure Elementary Audio DSP graph (shared across Web, Offline WAV & Native VST3)
│   ├── parameters.js        # Single source of truth for DAW automation parameters & defaults
│   ├── nodes.js             # Transient shaper, hybrid soft/hard clipper, SVF filters
│   └── engine.js            # 3-layer mixer + bandpass noise synth + master bus clipper
├── src/                     # Drum-machine-inspired UI & audio/MIDI host bridge
│   ├── audio/
│   │   ├── bridge.js        # Auto-switches between WebAudio/WebMIDI and Native JUCE VST3/AU
│   │   └── wavExport.js     # Offline 24-bit/44.1kHz stereo WAV renderer
│   ├── components/
│   │   ├── ChannelStrip.jsx # Sample slots, live previews, and per-channel DSP controls
│   │   ├── RotaryKnob.jsx   # Drag, exact-value entry, and reset controls
│   │   └── Waveform3DCanvas.jsx
│   ├── styles/theme.css     # Instrument-panel styling
│   ├── App.jsx
│   └── main.jsx
├── native/                  # JUCE 8 VST3 wrapper (macOS and Windows)
│   ├── CMakeLists.txt       # Platform-specific VST3/AU formats + embedded UI assets
│   ├── PluginProcessor.*    # Real-time audio buffer & Ableton MIDI Note-On bridge
│   └── PluginEditor.*       # WKWebView host container
└── scripts/
    ├── setup.sh             # Bootstraps npm packages, JUCE 8, and Elementary C++ SDK
    └── build-mac.sh         # Builds UI, compiles VST3/AU, installs & signs for Ableton Live
```

## Development and installation

1. **Prerequisites:** Install Node.js 22+, CMake 3.22+, Git, and the platform's C++ build tools. On macOS, install Xcode Command Line Tools.
2. **Bootstrap dependencies:**
   ```bash
   npm run setup
   ```
3. **Run the browser preview:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` to load WAV files, trigger with Spacebar or MIDI, and export 24-bit WAV hits.
4. **Install locally on macOS for development:**
   ```bash
   npm run install:vst3
   ```
   This development script prompts for the VST3 folder (default: `~/Library/Audio/Plug-Ins/VST3`), builds the UI and VST3, and installs/signs `LayerForge.vst3` there. Then open Ableton Live → **Settings → Plug-Ins → Rescan** and load **LayerForge** onto a MIDI track.
   The editor opens at 1120x620 and can be resized; the interface compacts at shorter heights and reflows at narrower widths.

   To export from the plug-in, click **EXPORT 24-BIT .WAV**. The export button stays available to render another WAV. Click **COPY / DRAG WAV** to copy the file to the clipboard, or drag it directly into Live; use **SAVE WAV** to keep a permanent copy. Temporary exports are removed when the plug-in editor closes, with abandoned exports pruned after 30 days.

   Loaded samples and patch settings are stored in the Live project state. The saved project includes decoded mono sample audio, so project files grow with the loaded samples. **EXPORT PRESET** creates a self-contained `.lfpreset` with the patch, embedded sample data, and available source file names/locations; it does not depend on temporary WAV files. Each channel has an adjustable playback trim and sample-relative gain envelope. The sum view offers a DSP-rendered stereo 3D field or a 2D waveform; drag the 3D field to rotate it. Channel previews are responsive estimates. Click a knob value to type an exact number; double-click the knob to reset it.

5. **Build locally:** use `npm run build` on macOS to build VST3 and AU formats. The `npm run install:vst3` development script remains available for local installation.

   For troubleshooting, open **SYSTEM MENU → DIAGNOSTICS** and copy the report. Native diagnostics are also written to `~/Library/Logs/LayerForge/LayerForge.log` on macOS.

## Platform releases

VST3 bundles are operating-system-specific; the macOS binary does not run on Windows. Conventional Commits drive Release Please version PRs. After a release PR is merged, the pipeline reruns tests and builds a macOS universal (arm64 + x86_64) and Windows x64 VST3; only after both builds succeed does it create the version tag and publish both ZIPs to a GitHub Release. Manual workflow dispatches create downloadable artifacts without publishing. See [RELEASING.md](RELEASING.md) for workflow behavior and repository permissions. Windows plug-in builds use WebView2 and require the Microsoft Edge WebView2 Runtime if it is not already installed. Native drag-out of a WAV is macOS-specific; on Windows, save the WAV and drag the saved file into the DAW.

Release builds are not signed with a developer certificate or notarized. macOS may show a Gatekeeper warning for downloaded bundles.

## License

LayerForge is licensed under the GNU General Public License, version 3 or (at your option) any later version. Contributions remain subject to that license. The license requires redistributors of covered works to preserve notices and provide corresponding source under GPL terms; it does not prevent copying that complies with the license.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to use GitHub Issues to propose
work or request a pull request, along with contribution and validation guidance.

## Plugin Use Guide

### Channel strips

Drop a WAV file onto a channel to load it. **M** mutes that channel; **S** solos it. Rotary controls use vertical drag, Shift-drag for finer adjustment, click the displayed value for exact numeric entry, and double-click the dial to reset.

| Control | What it does |
|---|---|
| **PITCH** | Changes playback speed and pitch by up to 24 semitones in either direction. Faster playback shortens the hit; slower playback lengthens it. |
| **PLAY DLY** | Offsets the sample start by up to 1000 ms. This is timing offset, not an echo or feedback delay. |
| **Envelope points** | Set sample gain from start to finish. Drag a point to change it, double-click the curve to add a point, or right-click an interior point to remove it. Endpoints stay at the start and end of the sample. |
| **Trim handle** | Drag the end marker to shorten playback without modifying the source sample. The trim is saved with the patch and applies to playback and WAV export. |
| **ATTACK / SUSTAIN** | Transient shaping, not envelope times: Attack boosts or reduces the initial transient; Sustain boosts or reduces the slower body. Negative values reduce those parts. |
| **HPF / LPF** | Apply a high-pass filter followed by a low-pass filter to remove low or high frequencies. |
| **CLIP DRV / SHAPE** | Drive sets the clipping input level; Shape blends smooth saturation with harder clipping. |
| **MIX** | Sets the channel's level in the layer sum. |

Pitch, level, sample start, envelopes, and filters are common drum-layering controls. LayerForge's point envelope is its detailed sample-shaping control; transient shaping, per-channel clipping, and playback delay are additional sound-design tools. Start with pitch, envelope, and mix, then use the other controls when you need them.

### Noise engine

The separate noise source can be muted or soloed. **FREQ** sets its band-pass center frequency, **RESO** sets resonance, **DECAY** sets its hit length, **CLIP DRV** adds saturation, and **MIX** sets its level in the sum.

### Master bus

**BUS DRIVE** and **SOFT/HARD** control the final clipper. **CEILING** scales the clipped output level; it is not a separate dynamic limiter.

### Reading the waveforms

Each channel displays a responsive estimate of its processed waveform, including envelope, mix, approximate filter response, transient shaping, and clipping. The DSP-rendered sum is more accurate and includes the channel filters, transient shaping, clipping, noise, and master processing. It can be viewed as a 3D waveform field or 2D waveform. A playhead animates when a note is triggered.
