# LayerForge VST3 / AU

**Multi-Layer Drum Designer, Differential Transient Shaper, Hybrid Clipper & Noise Engine** built with **Elementary Audio**, **React**, and **JUCE 8**.

## Project Architecture

```text
LayerForge/
├── dsp/                     # Pure Elementary Audio DSP graph (shared across Web, Offline WAV & Native VST3)
│   ├── parameters.js        # Single source of truth for DAW automation parameters & defaults
│   ├── nodes.js             # Transient shaper, hybrid soft/hard clipper, SVF filters
│   └── engine.js            # 3-layer mixer + bandpass noise synth + master bus clipper
├── src/                     # Hardware-styled dark UI & audio/MIDI host bridge
│   ├── audio/
│   │   ├── bridge.js        # Auto-switches between WebAudio/WebMIDI and Native JUCE VST3/AU
│   │   └── wavExport.js     # Offline 24-bit/44.1kHz stereo WAV renderer
│   ├── components/
│   │   ├── ChannelStrip.jsx # Drag-and-drop sample slot + per-channel DSP controls
│   │   └── RotaryKnob.jsx   # Vertical-drag, Shift-fine-tune, double-click-reset rotary dial
│   ├── styles/theme.css     # Self-contained dark hardware styling
│   ├── App.jsx
│   └── main.jsx
├── native/                  # Commercial JUCE 8 C++ VST3/AU wrapper
│   ├── CMakeLists.txt       # Universal macOS (arm64 + x86_64) VST3/AU build + embedded UI assets
│   ├── PluginProcessor.*    # Real-time audio buffer & Ableton MIDI Note-On bridge
│   └── PluginEditor.*       # WKWebView host container
└── scripts/
    ├── setup.sh             # Bootstraps npm packages, JUCE 8, and Elementary C++ SDK
    └── build-mac.sh         # Builds UI, compiles VST3/AU, installs & signs for Ableton Live
```

## Quick Start (macOS + VS Code)

1. **Prerequisites:** Install Xcode Command Line Tools (`xcode-select --install`) and CMake (`brew install cmake`).
2. **Bootstrap dependencies:**
   ```bash
   npm run setup
   ```
3. **Instant Browser Prototype (Hot-Reload):**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` to drop WAV files, trigger via Spacebar or MIDI, and download 24-bit WAV hits.
4. **Compile & Install the VST3 for Ableton Live:**
   ```bash
   npm run install:vst3
   ```
   The command prompts for the VST3 folder (default: `~/Library/Audio/Plug-Ins/VST3`), builds the UI and VST3, and installs/signs `LayerForge.vst3` there. Then open Ableton Live → **Settings → Plug-Ins → Rescan** and load **LayerForge** onto a MIDI track.

   To export from the plug-in, click **EXPORT 24-BIT .WAV** to render a WAV, then drag the button labeled **DRAG WAV TO ABLETON** into Live.

   To build both VST3 and AU formats without the install prompt, use `npm run build`.

   For troubleshooting, open **DEBUG** in the plug-in and copy the report. Native diagnostics are also written to `~/Library/Logs/LayerForge/LayerForge.log`; attach that file if the UI is blank or the report shows native errors.

## Commercial Distribution Checklist (Selling Later)
- Update `COMPANY_NAME`, `PLUGIN_MANUFACTURER_CODE`, and `PLUGIN_CODE` in `native/CMakeLists.txt`.
- Replace ad-hoc `codesign` with your **Developer ID Application** certificate and submit the `.pkg` installer to `xcrun notarytool` for Apple notarization.
