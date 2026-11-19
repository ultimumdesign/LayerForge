# LayerForge User Guide

LayerForge layers up to three samples and a noise synth into one drum hit. This
guide covers the interface and workflow; for the underlying algorithms see the
[DSP reference](docs/DSP.md).

**Contents:** [Installation](#installation) · [Quick start](#quick-start) · [Signal flow](#signal-flow) ·
[Sample channels](#sample-channels) · [Waveform editing](#waveform-editing) ·
[Noise synth](#noise-synth) · [Master bus](#master-bus) ·
[Output Scope](#output-scope-and-live-trace) · [Patches, presets and export](#patches-presets-and-wav-export) ·
[Troubleshooting](#troubleshooting) · [Limitations](#limitations-and-validation)

## Installation

1. Visit the [LayerForge releases page](https://github.com/ultimumdesign/LayerForge/releases)
   and expand **Assets** on the latest published release. A newer draft is not
   publicly downloadable until it is published.
2. Download the ZIP for your system:
   - **macOS:** `LayerForge-macos-universal-vst3.zip` (Apple Silicon and Intel).
   - **Windows:** `LayerForge-windows-x64-vst3.zip` (64-bit Windows).
3. Extract the ZIP and copy the entire `LayerForge.vst3` bundle, not just its
   contents, into the appropriate folder:
   - **macOS:** `~/Library/Audio/Plug-Ins/VST3/`. In Finder, use **Go → Go to
     Folder**, enter that path, and create the VST3 folder if needed.
   - **Windows:** `C:\Program Files\Common Files\VST3\`. Administrator
     permission may be needed to copy into this folder.
4. Restart or rescan plug-ins in your DAW. In Ableton Live, check **Settings →
   Plug-Ins**, enable VST3 plug-ins and rescan. Load LayerForge on a MIDI track.

The macOS download is ad-hoc signed, not notarized, so macOS may display a
security warning. Only approve software you trust. Windows requires the
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
The release downloads contain VST3 only; an AU can be built from source on
macOS. See the [README](README.md#development-quick-start) for development
builds.

## Quick start

1. Load LayerForge on a MIDI track (or a drum-rack pad) and open its editor.
2. **Load a sample:** click an empty channel waveform to browse, or drop an
   audio file on it. Dropping on a loaded channel replaces the sample but keeps
   that channel's envelope and processing settings. Mono and stereo files work;
   files with more than two channels are rejected. On each new load, IN and OUT
   are fitted around samples above −60 dB relative to the file's peak in either
   channel, with up to 5 ms before and 20 ms after. Quieter beginnings or tails
   may be outside the initial selection; listen and extend the handles if
   needed. Entirely silent files stay untrimmed. The source file is unchanged.
3. **Audition:** click **HIT**, play any MIDI note, or press **Space** when no
   text field or other button has focus. Every note triggers the same sound;
   note pitch is ignored and velocity scales the level.
4. **Shape:** trim the sample, draw the gain envelope, set MIX, then add other
   layers. The noise synth is off by default; select **OFF · ENABLE** to use it.
5. **Export (optional):** **PREPARE WAV**, then **COPY WAV** and paste into
   an audio track, or choose **SAVE WAV**.

The rack follows the signal path: three sample channels → **SIGNAL CHAIN**
(noise, ring modulation, convolution, saturation, glue) → **OUTPUT STAGE** → **OUTPUT SCOPE** display. Expand the
waveform editors for more room; scroll vertically if the editor is shorter than
its contents. In the native plug-in, drag the editor's resize handle to change
its width and height. Narrowing the window scales the interface down; widening
it restores the full-size controls. After a manual resize, the chosen height
is respected and extra controls remain accessible by scrolling. Window resizing
depends on the host.

The channel filename display shows the loaded file. Click it to load a
replacement or reveal the original in Finder / the file manager when the
location is known. If a dropped or restored sample has no known location you
are asked to pick the original file; this records its location without
changing the audio. Browser previews cannot reveal files. Long names scroll
unless reduced-motion is enabled.

### Undo and redo

With the editor focused, press **Cmd+Z** (macOS) or **Ctrl+Z** (Windows) to
undo a patch edit. Use **Cmd+Shift+Z**, **Ctrl+Shift+Z**, or **Ctrl+Y** to
redo. Knob and waveform drags each count as one edit. Controls, envelopes,
trims, mute/solo, effect switches, sample swaps, and signal-chain order can be
undone; auditioning and view settings are not included. Text fields keep their
own editing shortcuts.

History is limited to 100 edits in the current editor session. Loading or
replacing a sample, loading a preset, initializing a patch, or restoring a
host project clears it; these operations cannot be undone. Host automation
invalidates history for the affected control without undoing other controls.
Shortcuts depend on the host passing keyboard input to the plug-in.

## DAW macros and automation

The native plug-in exposes the continuous channel, noise and master controls as
host parameters. Use your DAW's plug-in parameter controls to select and map
them to macros or record automation; the procedure varies by host. Mute, solo,
bypass, routing, sample selection, trim and envelopes are not host parameters.

The graph worker coalesces changes approximately every 20 ms, so automation
is not sample-accurate and may take longer to reach the audio. Offline previews
and WAV exports use the current control values, not the host automation
timeline. Macro mapping and automation recording still need testing in each
supported DAW.

## Signal flow

```text
Channel 1 ─┐   sample → trim/pitch → envelope → delay → HPF/LPF
Channel 2 ─┼─► → transient shaper → clipper → width → MIX
Channel 3 ─┘
              │ sum × velocity
              ▼
   noise ▸ ring modulation ▸ convolution ▸ saturation ▸ glue   (order adjustable; default shown)
              ▼
   master clipper → CEILING → OUTPUT → host
```

- Channels add together per side. Noise joins the bus at its position in the
  order, so only effects after it process it.
- New channels start with a flat envelope, unity gain and bypassed filters and
  clipping. Graph changes are crossfaded, so the first hit after an edit can
  fade in briefly.
- **Stereo:** mono samples feed both sides; stereo samples keep left and right.
  Noise is mono. **WIDTH** is mid/side: 0 collapses to mono, 1 is unchanged,
  2 widens. Widening can reduce mono compatibility and raise peaks.
- The saturator and compressor are **off by default** (also when restoring older
  patches). Channel clipping engages above 0 dB CLIP DRV; the master clipper is
  always active. **CEILING** scales the clipped signal and is not a limiter,
  and a positive **OUTPUT** can exceed 0 dBFS.

## Sample channels

**M** mutes and **S** solos a channel. Noise has its own enable, mute and
solo; its solo does nothing while the synth is off. When any active source is
soloed, the others are silent. The minus/plus button collapses a strip without
changing the sound. A hollow status light and subdued border mark an empty
channel; loaded channels have a filled light, and muted channels are dimmed.

**Knobs:** drag vertically, Shift-drag for fine control, click the value to
type one, double-click to reset. The chevron shows or hides extra controls
inline: unchanged extras are grouped under **ADDITIONAL CONTROLS**, while
modified extras stay with the channel's main knobs. The circular-arrow icon
resets the channel's knobs after confirmation, keeping the sample, trim,
envelope, mute and solo. These display preferences last for the editor session.

Adjust **CLIP GAIN** in the waveform header with its slider or exact-value
field (−60 to +12 dB). In the action row, drag the **PLAY DLY** arrows up or
down to adjust playback delay from 0 to 1000 ms; Shift-drag for finer control,
use the arrow keys, or type an exact value. Double-click the arrows to reset.

| Control | Function | Range (default) |
|---|---|---|
| PITCH | Varispeed playback pitch; changes length | −24 to +24 st (0) |
| ATTACK / SUSTAIN | Transient and body level | −1 to +1 (0) |
| HPF | 12 dB/oct high-pass; bypassed at 20 Hz | 20–2000 Hz (20) |
| LPF | 12 dB/oct low-pass; bypassed at 20 kHz | 800–20000 Hz (20000) |
| CLIP DRV | Clipper input drive; bypassed at 0 dB | 0–24 dB (0) |
| SHAPE | Clipper soft (0) to hard (1) | 0–1 (0.25) |
| CLIP GAIN | Sample gain before channel processing | −60 to +12 dB (0) |
| WIDTH | Mid/side width | 0–2 (1) |
| MIX | Level sent to the sum | 0–1.5 (1) |
| PHASE | Time shift as a fraction of trimmed length | −0.05 to +0.05 (0) |

Positive PHASE delays the sample; negative skips into it. The slashed-circle
icon estimates an offset against the first other loaded sample using their
left/source channels. It works best for similar recordings; different sounds,
rates, trims, pitch or processing can mislead it, so listen and fine-tune
PHASE.

**Moving samples:** the sample-name menu moves a sample to an empty channel or
swaps two. Source data, names and trims move; envelopes and processing stay with
the channel.

## Waveform editing

The channel waveform shows an offline *processed* preview with trim handles and
the gain envelope. It shows channel processing only; master bus effects and
other channels cannot change its shape or time scale. Dimmed audio outside the
trim gives context; processing tails past the playable sample appear in the sum. Stereo files are drawn as one
combined range but are not downmixed in the audio path. The preview updates when
settings change, not on each hit. **EDIT WAVE** opens a larger source-time view.

- **Trim:** drag IN and OUT to select the playable region without changing the
  file. New loads retain at least 1% of the file, and restoring an existing
  patch keeps its saved trim. To recover the full source after automatic
  trimming, select **FULL** and drag IN to the start and OUT to the end. Hold
  **Ctrl** to snap to a nearby silence boundary. After a trim edit
  the view recenters on the selection. **ZOOM** magnifies it, **FULL** shows the
  whole file, **FIT** returns to the selection. When zoomed, drag the scrollbar,
  use horizontal trackpad scrolling, or Shift-wheel to pan (the sum view works
  the same way). FIT includes up to 10% of the selection's length as visible
  source context beyond each trimmed edge. After a channel trim changes, its
  playhead returns to the new start marker and sweeps again on the next hit.
- **DETAIL:** in the expanded editor or noise settings, selects 512, 2048 or
  4096 preview bins. It is shared by channel and noise waveforms and is
  display-only.
- **CLIP GAIN:** drag in the waveform header, or type a dB value. Double-click
  the slider or label to reset to 0 dB.
- **Envelope:** drag points to shape gain (the bottom is silence). Double-click
  to add a point (up to 10 interior points), right-click an interior point to
  remove it. **RESET ENV** restores a flat, full-gain envelope.
- **Curves:** drag the handle in the middle of a sloped segment to bend it
  (flat segments have none). With a handle focused, arrow keys adjust it and
  Home resets it. Ctrl+[ and Ctrl+] adjust the segment after a focused point;
  Home on a point sets it to zero.

## Noise synth

White, pink or brown noise through a band-pass filter, shaped by a decay
envelope, clipped and mixed. **NOISE TYPE** selects the source color: white is
bright, pink is softer, and brown emphasizes the low end. Their levels change
with FREQ and RESO; adjust MIX to taste. White is the default.
Drag the type knob, use its arrow keys, or click its value to cycle the colors.
Double-click the knob to return to white.

| Control | Function | Range (default) |
|---|---|---|
| FREQ | Band-pass centre | 20–20000 Hz (4800) |
| RESO | Band-pass Q | 0.1–30 (1.4) |
| DECAY | Envelope time (≈ −60 dB) | 2 ms–3 s (75 ms) |
| PLAY DLY | Delay before the noise hit starts | 0–1000 ms (0) |
| CLIP DRV | Clipper drive | 0–36 dB (3) |
| MIX | Level | 0–2 (0.22) |

The settings popup shows the processed noise waveform, which can be edited like
a sample: gain-envelope points, curve handles, reset, and IN/OUT to gate a
window within the hit (without shifting it earlier). Changing DECAY rescales
that window. There is no silence snapping. Noise differs on each trigger, and
the waveform is an offline preview. PLAY DLY shifts the whole noise hit later
without changing its trim or envelope; the editor remains on the noise's own
timeline, and the sum view uses output time. Adjust PLAY DLY in the action row
using the same drag, keyboard and exact-value controls as the channel delay.

Noise length follows DECAY (plus a 15 ms tail), after any PLAY DLY. The 28 ms
trigger gate only restarts the envelope, so long decays ring out in full. A new
hit restarts the noise voice, including any pending delay.

The enable switch is separate from **M**: enabling a muted synth leaves it
muted, and disabling it keeps its mute and solo. The settings button is
available only while the synth is on.

## Master bus

**Order.** Drag a module's dotted grip onto another module to reorder noise,
convolution, saturation, glue and ring modulation. You can also focus the grip and use the up/down arrow
keys. The order is saved with the patch (default: noise, ring modulation, convolution, saturation, glue).
The line beside the modules shows the path from channels to output; the plus
marks where noise joins, and filled markers show active modules. Select a
module's LCD-style title to open its settings; the inline gear marks it as
interactive. Its enable switch shares the same compact row. Settings are
available only while the corresponding module is enabled; bypassing keeps
their values for the next time it is enabled.
Each popup has an **M** button beside its reset controls. For convolution, saturation,
glue and ring modulation, M bypasses the whole effect, including its OUTPUT gain, without silencing
the signal or closing the popup. Muting noise silences only the noise source.
Mute is saved independently of the enable switch, and a muted module is marked
in the signal chain.
Use **HIT** in a settings or channel waveform editor window to audition without
closing it. Space also triggers a hit when HIT or CLOSE is focused; use Enter
or Escape to close.
The saturation type knob uses the same drag, arrow-key, click-to-cycle and
double-click-to-reset controls as the noise type knob.

| Module | Controls | Range (default) |
|---|---|---|
| CONVOLUTION | PROFILE | Room (default), Plate, Chamber |
| | PREDELAY | 0–200 ms (0) |
| | LOW CUT | 20–2000 Hz (20) |
| | HIGH CUT | 800–20000 Hz (20000) |
| | DRY/WET | 0–1 (0.5) |
| | OUTPUT | −24 to +24 dB (0) |
| SATURATION | TYPE | Tape · soft (default), Tube · asymmetric, Digital · hard |
| SATURATION | SAT DRIVE | 0–24 dB (6) |
| | SAT DRY/WET | 0–1 (1) |
| | OUTPUT | −24 to +24 dB (0) |
| GLUE COMPRESSOR | THRESH | −36 to 0 dB (−12) |
| | RATIO | 1–8:1 (2) |
| | ATTACK | 1–100 ms (10) |
| | RELEASE | 30–600 ms (120) |
| | KNEE | 0–24 dB (6) |
| | DRY/WET | 0–1 (1); 0 is dry, 1 is fully compressed |
| | OUTPUT | −24 to +24 dB (0) |
| RING MODULATION | FREQUENCY | 0.1–5000 Hz (100) |
| | PHASE | 0–360° (0) |
| | BIAS | 0–1 (0) |
| | RECTIFY | −1 to +1 (0) |
| | SPREAD | 0–1 (0) |
| | DRY/WET | 0–1 (1); 0 is dry, 1 is fully modulated |
| | OUTPUT | −24 to +24 dB (0) |
| OUTPUT STAGE | BUS DRIVE | 0–24 dB (2) |
| | SOFT/HARD | 0–1 (0.45) |
| | CEILING | 0.1–1.0 linear (0.95) |
| | OUTPUT | −60 to +12 dB (0) |

The tape-style option is the original symmetric tanh curve; tube-style adds
asymmetry and DC blocking, while digital hard clipping gives a sharper edge.
These are simplified waveshaping styles, not models of specific hardware.
Their levels can differ, so use OUTPUT and the meters to compare them.

Convolution is off by default. Its three built-in stereo responses are generated
profiles, not recordings of real rooms or hardware. PROFILE uses the same
stepped knob interaction as the noise and saturation types. PREDELAY and the
filters affect the wet path; OUTPUT follows the blend. The processor includes
the response and predelay in preview and export duration.

Ring modulation is off by default. FREQUENCY uses a logarithmic drag response
for easier adjustment at low rates. PHASE sets where the sine carrier starts on
each hit: 0° starts at zero, while 90° starts at its positive peak and can
preserve more of a drum's initial attack. Low frequencies produce bipolar
amplitude modulation; audio-rate settings create metallic sum and difference
frequencies. BIAS adds a positive offset to the carrier, bringing back some
original signal and potentially increasing the wet peak by up to 6 dB.
RECTIFY smoothly folds the carrier toward negative or positive full-wave
rectification, adding harmonics. SPREAD detunes left and right carrier
frequencies in opposite directions, up to 5% each way; check mono compatibility
when using it. High frequencies and rectification can alias, especially at
lower sample rates. DRY/WET blends the original and modulated signals; OUTPUT
follows the blend. The four shaping controls default to zero, retaining the
original ring-mod sound.

For a starting point, try PHASE 90°, FREQUENCY 40 Hz and DRY/WET 0.3 on a kick
to blend modulation with the original attack. For a metallic layer, try
FREQUENCY 300 Hz, RECTIFY 0.5 and DRY/WET 0.5, then adjust OUTPUT while watching
the meter. Add a little SPREAD for stereo motion, and audition in mono too.
Results depend on the source and the other bus effects.

The glue compressor is stereo-linked: the same gain reduction applies to both
sides. Each effect's OUTPUT adjusts its mixed output when enabled and is
bypassed with the effect. The settings meters show stereo-linked input and
output peaks at the module's actual position in the chain: INPUT is before the
effect, and OUTPUT is after its dry/wet blend and OUTPUT gain. The bars span
−60 to +12 dBFS and turn red at 0 dBFS. The compressor's WET REDUCTION shows
the largest applied wet-path reduction during each meter update, before
dry/wet mixing and output gain. It can therefore show reduction even at
DRY/WET 0. Its downward bar spans 0–36 dB; the numeric reading still shows
values beyond that range.

**Meters.** **OUTPUT PEAK** (Output Scope) measures post-OUTPUT signal in
dBFS, holds peaks briefly and flags values at or above 0 dBFS. **HIT PEAK**
holds the highest peak of the latest audible burst (bursts are separated by
300 ms below −80 dBFS). The convolution, saturation, compressor and ring modulation input/output meters have
their own HIT PEAK readouts, and the compressor shows MAX THIS HIT, the largest
wet gain reduction of the latest hit (new bursts are separated by 300 ms of
under 0.05 dB reduction). These are peak meters, not loudness meters. WAV export
clips values above 0 dBFS.

## Output Scope and live trace

The main sum shows the processed final output, displaying **RENDERING** until
the offline preview is ready. The preview uses a full-velocity trigger and
settled parameters; noise, velocity, overlapping hits, sample rate, parameter
changes and filter history can make live playback differ.

**TRACE** is on by default. After a hit its captured live audio replaces the
static preview; turn TRACE off to return to the preview. The preview stays
available while trace is armed or if capture fails. Capture retains the last hit
for up to four seconds, clears when the patch changes and warns about missed
data; play another hit after a gap warning. TRACE affects the sum and its
expanded comparison, not the channel or noise previews.

**EXPAND** on the waveform or **MENU → EXPANDED OUTPUT SCOPE** shows
oscilloscope-style panels for final output and the pre-master
sum above the three channels and noise. All panels use the same output-time
window and amplitude scale. Compare pre-master and final output to see the
overall effect of bus processing and output gain; individual effects are not
displayed as separate waveforms. The pre-master sum includes all sources before
effects, even when noise is inserted later in the bus. Because master
processing is nonlinear, the final signal cannot be split into independent
per-source contributions.

- Switch to **SIGNAL FLOW** in the expanded scope to explore the current
  routing. Select a stage for an explanation; the diagram follows module order,
  noise insertion and mute/solo/bypass settings. It is not a live meter and
  does not change the sound. Switch back to **WAVEFORM** for the comparison.
- **VIEW:** **SOURCES** fits the longest audible playable source, including its
  delay, pitch, trim and phase alignment. It is the default; with no audible
  sources, it falls back to the full render or capture. **FULL RENDER** includes the
  remaining output and effect tails; for live traces it is called **FULL
  CAPTURE**. The first 5, 20 or 100 ms show actual samples. **DETAIL** sets
  peak-envelope resolution (512, 2048, 4096 bins). A live trace still captures
  at most four seconds, so longer source windows contain uncaptured space.
- Move over or drag on any comparison waveform to place a shared crosshair.
  The readout shows output time and a reference level; each lane shows its
  stereo minimum and maximum at that time, or **NO DATA** beyond available
  audio. Peak-envelope views report the selected bin's bounds, not an exact
  sample. Focus a waveform and use left/right arrows to move by a sample or
  peak bin and up/down to adjust the reference. Hold Shift for ten-step moves,
  use Home/End for the time limits, and Escape or **CLEAR** to remove it.
- **ZOOM** magnifies the start of the timeline; **FIT** raises display scale up
  to 20×; **ACTUAL 1:1** restores unscaled amplitude. These are display-only.
- Channel **SRC** times are source positions before pitch and delay; sum **OUT**
  times are output time. Stereo views show the combined bounds of both sides.

## Patches, presets and WAV export

- **INITIALIZE PATCH** (MENU) resets settings and clears samples after
  confirmation. Noise returns to disabled and the theme is kept. Existing
  presets and WAV files are not deleted.
- **Host projects** embed settings and decoded sample audio, so project size
  grows with sample length. The theme is saved too.
- **PRESET** drop-down: choosing another preset or **INIT PATCH** proceeds
  immediately if the current patch is unchanged since it was loaded or saved.
  If it has unsaved changes, a warning appears before replacing its settings and
  samples. For saved presets, the warning offers **CANCEL**, **SAVE AS** or
  **LOAD WITHOUT SAVING**; after saving, select the desired preset again.
  Older project states without a saved comparison may still show a warning.
  An edited patch without a selected preset appears as **CURRENT PATCH** so
  INIT PATCH remains selectable.
  **SAVE AS** writes the patch and references to its original sample files as
  a `.lfpreset`; sample audio is not embedded. If a dropped sample has no known
  path, locate the original when prompted. The selected file must match the
  loaded audio. **SAVE** replaces the selected preset after confirmation (or
  acts like SAVE AS when no preset is selected);
  the old contents cannot be recovered. The selected preset name is stored
  with the host project state, so it is still shown after the editor is closed
  and reopened (the patch itself was already restored; if you edited it, the
  name only shows which preset you started from). The library folder is:

  | OS | Path |
  |---|---|
  | macOS | `~/Library/LayerForge/Presets` |
  | Windows | `%APPDATA%\LayerForge\Presets` |

  Copy presets into that folder and press the refresh button; the trash button
  deletes the selected preset after confirmation. Names are limited to 100 characters, and
  duplicates get a numeric suffix. Keep the referenced files when moving or
  sharing presets. If a source file moves or changes, loading asks you to locate
  an identical original; canceling or selecting a different file leaves the
  current patch unchanged. Older embedded-sample presets remain readable, but
  older LayerForge versions cannot open the new reference-only preset format.
  Checking and transferring large sample files can take time and may temporarily
  make the plug-in editor unresponsive. If saving reports an unconfirmed result,
  refresh the preset library before retrying: the file may still have been saved.
- **PREPARE WAV** renders the current mix in memory as 24-bit, 44.1 kHz stereo
  (regardless of host sample rate) from a full-velocity hit. Prepare again after
  any change. **SAVE WAV** lets you choose a destination; nothing is written
  automatically.
- **COPY WAV** places a file reference on the clipboard; **COPIED** confirms
  the clipboard write, not import into the DAW. Select an audio track or clip
  slot and paste using the host's paste command. An unsaved WAV gets a temporary
  transfer file, retained when the editor closes and removed on the next copy
  in the plug-in process; transfer folders older than two hours may also be
  removed when another temporary transfer is created. A saved WAV is referenced
  directly and never deleted. WAV drag-out from the plug-in is not available.
  If paste fails, use **SAVE WAV** and import the saved file.

The top bar has two fixed rows (presets, then audio, THEME and MENU) with
fixed-width controls and a reserved status slot, so nothing moves when a WAV
is prepared or a preset loads. The THEME picker offers palettes with animated
outlines that cross-fade between colors around the chassis and panels. **GOLDEN
NUGGET** is the default and uses RGB outlines. Your chosen theme is remembered
in the browser and saved with the native host project. **HIGH CONTRAST** uses
brighter text and controls, stronger keyboard focus outlines, and a static
frame and logo cursor. System
reduced-motion settings also stop the animated outlines in other themes.
In **MENU**, select **BORDER TRACE** to cycle between NORMAL, OFF and SUBTLE,
and **TRACE SPEED** to cycle between NORMAL, FAST and SLOW. These affect only
the decorative outlines, not the Output Scope's audio trace. The browser
remembers these choices locally; the native plug-in saves them with the host
project. HIGH CONTRAST and system reduced-motion settings remain static.
The **DSP INFO DISPLAY**, enabled by default, shows the processing purpose of
the channel, effect, waveform or editing control under the pointer or keyboard
focus in the LCD below the output-stage controls. Effect and expanded waveform
dialogs repeat the display.
The output-stage arrows show the clipper, ceiling and output order; BUS DRIVE
and SOFT/HARD both control the clipper. In **MENU**, toggle **DSP INFO DISPLAY**
and the separate **HOVER HELP** tooltips independently; hover help is off by
default and shows control names and editing instructions. The browser remembers
these choices locally and the native plug-in saves them with the host project.

The **MENU** also offers the usage guide (the published manual), initialize,
diagnostics and about. The signature above **CLOSE** in the
**ABOUT** popup opens ayatko's Instagram in your browser.

**Resetting module knobs.** Open a signal-chain module's gear dialog and press
**RESET KNOBS** beside the popup's mute control to restore its knobs to defaults
after confirmation. On/off state, signal-chain position, noise trim/envelope,
mute and solo are kept. Apart from those transfer files, LayerForge does not write export caches
or diagnostic log files itself; the DAW and OS webview may manage their own.

## Troubleshooting

| Symptom | Try |
|---|---|
| No sound | Trigger a MIDI note; check mute/solo, levels and host output routing. Enable and unmute noise to hear it without a sample. |
| Handles hard to use | Open **EDIT WAVE**. Trim snapping uses Ctrl. |
| Phase alignment sounds worse | It is an estimate. Adjust PHASE by ear, especially for unrelated recordings. |
| Waveform differs from playback | Check TRACE after a new hit and compare source-time vs output-time views. Noise and live conditions differ from the offline preview. |
| Too quiet or loud after saturation/glue | Adjust the effect's OUTPUT and watch its meters and OUTPUT PEAK. |
| Harsh, gritty highs at high drive | Clippers and the saturator do not oversample; reduce drive or SHAPE, or low-pass the channel. |
| Plug-in not found | Rescan in the DAW and confirm the build matches the platform (VST3 on macOS/Windows, AU on macOS). |
| Copy fails or paste is rejected | **SAVE WAV**, then import from the file manager or DAW browser. |
| Bug report | **MENU → DIAGNOSTICS**, copy the report, and include it. |

## Limitations and validation

- DAW parameter automation is coalesced by the graph worker and is not
  sample-accurate; host mapping and recording require interactive validation.
- Native MIDI is processed in the audio processor with sample-accurate
  timing, and restored patches play with the editor closed.
- WAV export is fixed at 44.1 kHz / 24-bit.
- Automated checks (`npm run check`: lint and the Node tests) cover DSP and
  waveform data, and optional native MIDI tests cover the processor. They do not
  certify host workflows. Project/preset round trips, clipboard, sample import,
  window sizing and cross-platform behavior need manual testing in a DAW. See
  [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md).
