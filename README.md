# LayerForge VST3 / AU

**LayerForge** is a stereo drum-layering instrument built with **Elementary Audio**, **React**, and **JUCE 8**. It combines three sample channels, a noise synth, channel processing, and master effects. The project is free software under **GPL-3.0-or-later**.

## Features and usage

- Load mono or stereo samples by clicking an empty waveform or dropping a file;
  edit trims and curved gain envelopes directly on the processed waveform.
- Shape each channel with pitch, timing, filtering, transient controls, clipping
  and stereo width. Move or swap samples without moving channel settings.
- Reorder the noise synth, optional master saturation, and optional stereo-linked
  glue compressor before the master clipper. Shape
  the noise with its own editable waveform envelope and time window.
- Compare the offline output and last live hit in the expandable sum view;
  save patches with samples and explicitly export 24-bit stereo WAVs.

See the [user guide](USER_GUIDE.md) for controls, signal routing, presets,
export and troubleshooting. Native MIDI is handled by the audio processor;
native DAW automation is not yet exposed.
Host-specific workflows require manual verification.

## Project Architecture

```text
LayerForge/
├── dsp/                     # Pure Elementary Audio DSP graph (shared across Web, Offline WAV & Native VST3)
│   ├── parameters.js        # Patch defaults, validation, and serialization
│   ├── nodes.js             # Filters, transient shaper, saturation, clipper and glue compressor
│   └── engine.js            # Stereo channel, noise, summing and master signal graph
├── src/                     # Drum-machine-inspired UI & audio/MIDI host bridge
│   ├── audio/
│   │   ├── bridge.js        # Auto-switches between WebAudio/WebMIDI and Native JUCE VST3/AU
│   │   ├── waveform.js      # Signed min/max sample and stereo waveform envelopes
│   │   └── wavExport.js     # Offline 24-bit/44.1kHz stereo WAV renderer
│   ├── components/
│   │   ├── ChannelStrip.jsx # Sample slots, live previews, and per-channel DSP controls
│   │   ├── HelpTip.jsx      # Accessible contextual control and waveform guidance
│   │   ├── LayerSumViewer.jsx # Zoomable, expandable sum waveform view
│   │   ├── RotaryKnob.jsx   # Drag, exact-value entry, and reset controls
│   ├── assets/
│   │   ├── brushed-panel.svg # Theme-tinted anodized hardware texture
│   │   └── perforated-grille.svg # Low-contrast speaker-grille texture
│   ├── uiThemes.js          # Three selectable hardware/neon-inspired color palettes
│   ├── styles/theme.css     # Hardware-inspired, accessible theme styling
│   ├── App.jsx
│   └── main.jsx
├── native/                  # JUCE 8 VST3 wrapper (macOS and Windows)
│   ├── CMakeLists.txt       # Platform-specific VST3/AU formats + embedded UI assets
│   ├── PluginProcessor.*    # Audio processing, MIDI bridge and project state
│   └── PluginEditor.*       # Native webview editor and host bridge
└── scripts/
    ├── setup.sh             # Bootstraps npm packages, JUCE 8, and Elementary C++ SDK
    └── build-mac.sh         # Builds UI and macOS VST3/AU without installing
```

## Development and Installation

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

5. **Build locally:** use `npm run build` on macOS to build VST3 and AU formats without modifying installed plug-ins. The `npm run install:vst3` development script remains available for local installation.

   For troubleshooting, open **SYSTEM MENU → DIAGNOSTICS** and copy the report.

## Platform Releases

VST3 bundles are operating-system-specific; the macOS binary does not run on Windows. Conventional Commits drive Release Please version PRs. After a release PR is merged, the pipeline reruns tests and builds a macOS universal (arm64 + x86_64) and Windows x64 VST3; only after both builds succeed does it create a draft GitHub Release with both ZIPs. A maintainer must validate and publish it. Manual workflow dispatches create downloadable artifacts without publishing. See [RELEASING.md](RELEASING.md) for workflow behavior and repository permissions. Windows plug-in builds use WebView2 and require the Microsoft Edge WebView2 Runtime if it is not already installed. Native drag-out of a WAV is macOS-specific; on Windows, save the WAV and drag the saved file into the DAW.

Release builds are not signed with a developer certificate or notarized. macOS may show a Gatekeeper warning for downloaded bundles.

## License

LayerForge is licensed under the GNU General Public License, version 3 or (at your option) any later version. Contributions remain subject to that license. The license requires redistributors of covered works to preserve notices and provide corresponding source under GPL terms; it does not prevent copying that complies with the license.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to use GitHub Issues to propose work or request a pull request, along with contribution and validation guidance.
