# LayerForge User Guide

LayerForge layers up to three samples and a noise synth into one drum hit. This
guide covers the interface and workflow; for the underlying algorithms see the
[DSP reference](docs/DSP.md).

**Contents:** [Quick start](#quick-start) · [Signal flow](#signal-flow) ·
[Sample channels](#sample-channels) · [Waveform editing](#waveform-editing) ·
[Noise synth](#noise-synth) · [Master bus](#master-bus) ·
[Output Scope](#output-scope-and-live-trace) · [Patches, presets and export](#patches-presets-and-wav-export) ·
[Troubleshooting](#troubleshooting) · [Limitations](#limitations-and-validation)

## Quick start

1. Load LayerForge on a MIDI track (or a drum-rack pad) and open its editor.
2. **Load a sample:** click an empty channel waveform to browse, or drop an
   audio file on it. Dropping on a loaded channel replaces the sample but keeps
   that channel's envelope and processing settings. Mono and stereo files work;
   files with more than two channels are rejected.
3. **Audition:** play any MIDI note, or press **Space** when no text field or
   button has focus. Every note triggers the same sound; note pitch is ignored
   and velocity scales the level.
4. **Shape:** trim the sample, draw the gain envelope, set MIX, then add other
   layers. The noise synth is off by default; select **OFF · ENABLE** to use it.
5. **Export (optional):** **PREPARE WAV**, then **SAVE WAV**.

The rack follows the signal path: three sample channels → **SIGNAL CHAIN**
(noise, saturation, glue) → **OUTPUT STAGE** → **OUTPUT SCOPE** display. Expand the
waveform editors for more room; scroll vertically if the editor is shorter than
its contents.

The channel filename display shows the loaded file. Click it to load a
replacement or reveal the original in Finder / the file manager when the
location is known. If a dropped or restored sample has no known location you
are asked to pick the original file; this records its location without
changing the audio. Browser previews cannot reveal files. Long names scroll
unless reduced-motion is enabled.

## Signal flow

```text
Channel 1 ─┐   sample → trim/pitch → envelope → delay → HPF/LPF
Channel 2 ─┼─► → transient shaper → clipper → width → MIX
Channel 3 ─┘
              │ sum × velocity
              ▼
   noise ▸ saturation ▸ glue   (order adjustable; default shown)
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
type one, double-click to reset. The gear icon shows or hides extra controls
(modified controls stay visible). The circular-arrow icon resets the channel's
knobs after confirmation, keeping the sample, trim, envelope, mute and solo.
These display preferences last for the editor session.

| Control | Function | Range (default) |
|---|---|---|
| PITCH | Varispeed playback pitch; changes length | −24 to +24 st (0) |
| PLAY DLY | Start delay (not an echo) | 0–1000 ms (0) |
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
the gain envelope. Dimmed audio outside the trim gives context; processing tails
past the playable sample appear in the sum. Stereo files are drawn as one
combined range but are not downmixed in the audio path. The preview updates when
settings change, not on each hit. **EDIT WAVE** opens a larger source-time view.

- **Trim:** drag IN and OUT to select the playable region without changing the
  file. Hold **Ctrl** to snap to a nearby silence boundary. After a trim edit
  the view recenters on the selection. **ZOOM** magnifies it, **FULL** shows the
  whole file, **FIT** returns to the selection. When zoomed, drag the scrollbar,
  use horizontal trackpad scrolling, or Shift-wheel to pan (the sum view works
  the same way). After a channel trim changes, its playhead returns to the new
  start marker and sweeps again on the next hit.
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

White noise through a band-pass filter, shaped by a decay envelope, clipped and
mixed.

| Control | Function | Range (default) |
|---|---|---|
| FREQ | Band-pass centre | 20–20000 Hz (4800) |
| RESO | Band-pass Q | 0.1–30 (1.4) |
| DECAY | Envelope time (≈ −60 dB) | 2 ms–3 s (75 ms) |
| CLIP DRV | Clipper drive | 0–36 dB (3) |
| MIX | Level | 0–2 (0.22) |

The settings popup shows the processed noise waveform, which can be edited like
a sample: gain-envelope points, curve handles, reset, and IN/OUT to gate a
window within the hit (without shifting it earlier). Changing DECAY rescales
that window. There is no silence snapping. Noise differs on each trigger, and
the waveform is an offline preview.

Noise length follows DECAY (plus a 15 ms tail). The 28 ms trigger gate only
restarts the envelope, so long decays ring out in full.

The enable switch is separate from **M**: enabling a muted synth leaves it
muted, and disabling it keeps its mute and solo. The settings button is
available only while the synth is on.

## Master bus

**Order.** Drag a module's dotted grip onto another module to reorder noise,
saturation and glue. You can also focus the grip and use the up/down arrow
keys. The order is saved with the patch (default: noise, saturation, glue).
The line beside the modules shows the path from channels to output; the plus
marks where noise joins, and filled markers show active modules. Open a
module's settings with the gear beside its enable switch. Settings are
available only while the corresponding module is enabled; bypassing keeps
their values for the next time it is enabled.

| Module | Controls | Range (default) |
|---|---|---|
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
| OUTPUT STAGE | BUS DRIVE | 0–24 dB (2) |
| | SOFT/HARD | 0–1 (0.45) |
| | CEILING | 0.1–1.0 linear (0.95) |
| | OUTPUT | −60 to +12 dB (0) |

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
300 ms below −80 dBFS). The saturation and compressor input/output meters have
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

**EXPAND** compares final output, pre-master sum, each channel and noise on a
shared time and amplitude scale. The pre-master lane is the sum of all sources
before effects, even when noise is inserted later in the bus; final output is
after all master processing. Because master processing is nonlinear, the final
signal cannot be split into independent per-source contributions.

- **VIEW:** first 5, 20 or 100 ms of actual samples, or **FULL HIT** for peak
  envelopes. **DETAIL** sets full-hit resolution (512, 2048, 4096 bins).
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
- **PRESET** drop-down: choosing a preset loads it immediately. **SAVE AS** writes
  the current patch and samples as a new self-contained `.lfpreset` (not a
  rendered WAV). **SAVE** replaces the selected preset after confirmation (or
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
  duplicates get a numeric suffix.
- **PREPARE WAV** renders the current mix in memory as 24-bit, 44.1 kHz stereo
  (regardless of host sample rate) from a full-velocity hit. Prepare again after
  any change. **SAVE WAV** lets you choose a destination; nothing is written
  automatically.
- **COPY / DRAG WAV** gives the DAW a real file. If the WAV is unsaved, a
  temporary copy is written only for the transfer. Because DAWs read the file
  after the drop, it is kept until your next drag or copy, or until the editor
  closes, then deleted.
  A saved WAV is referenced directly and never deleted. If a DAW rejects it,
  import the saved WAV through its browser. Native drag-out is macOS-only.

The top bar has two fixed rows (presets, then audio, THEME and MENU) with
fixed-width controls and a reserved status slot, so nothing moves when a WAV
is prepared or a preset loads. It also holds a THEME picker (three
palettes). The **MENU** offers the usage guide (the published manual), hover
help, initialize, diagnostics and about.

**Resetting module knobs.** Open a signal-chain module's gear dialog and press
**RESET KNOBS** to restore its knobs to defaults after confirmation. On/off
state, signal-chain position, noise trim/envelope, mute and solo are kept. Apart from those transfer files, LayerForge does not write export caches
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
| Copy or drag rejected | **SAVE WAV**, then import from the file manager or DAW browser. |
| Bug report | **MENU → DIAGNOSTICS**, copy the report, and include it. |

## Limitations and validation

- DAW parameter automation is **not yet exposed**; automate by playing MIDI and
  using saved patches.
- Native MIDI is processed in the audio processor with sample-accurate
  timing, and restored patches play with the editor closed.
- WAV export is fixed at 44.1 kHz / 24-bit.
- Automated checks (`npm run check`: lint and the Node tests) cover DSP and
  waveform data, and optional native MIDI tests cover the processor. They do not
  certify host workflows. Project/preset round trips, clipboard, drag/drop,
  window sizing and cross-platform behavior need manual testing in a DAW. See
  [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md).
