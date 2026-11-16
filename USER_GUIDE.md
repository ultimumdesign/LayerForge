# LayerForge User Guide

## Getting started

1. Load LayerForge on a MIDI track or drum rack and open its editor.
2. Click an empty channel waveform to browse for a sample, or drop an audio
   file onto the waveform. Drop another file there to replace it. The filename
   appears in the channel's LED-style display. Click it to load a replacement
   or reveal the original file in Finder / the file manager when its location
   is known. Native browsing records the location. If a dropped or restored
   sample has no known location, choose the original file when prompted;
   this records its location without replacing the loaded audio. Browser
   previews cannot reveal files in the file manager.
   Long filenames scroll in the display; reduced-motion settings disable scrolling.
3. Trigger a note, or press Space when a text field or button is not focused.
   The noise synth is off by default; select **OFF · ENABLE** to turn it on.
4. Trim the sample, shape its envelope, and set its MIX. Add other layers and
   adjust the noise and master as needed.
5. Use **PREPARE WAV** to render a hit, then **SAVE WAV** to choose a location.

The rack follows the signal path: three sample channels feed the **SIGNAL
CHAIN**, where noise can join, followed by the **OUTPUT STAGE** controls
and **MIX LAB** output display. Expand the waveform editors for
more room. Popup controls wrap to fit the window; scroll vertically if the
contents do not fit the available height.

## Signal flow and stereo

Each sample channel plays its trimmed source with pitch, timing and envelope
settings, then applies input gain, filtering, transient shaping, clipping,
stereo width and MIX. The noise path runs through filtering, an envelope,
clipping and MIX. The channels are added sample by sample, separately for
left and right. The master bus adds noise and applies optional saturation and
stereo-linked glue compression in the selected order, then clipper, ceiling
and output gain.

New channels start with a flat envelope, unity gain and bypassed channel
filters and clipping. The audio renderer crossfades graph changes, so an
immediate first audition may fade in briefly. Replacing a
sample keeps that channel's existing envelope and processing settings.
The noise synth and master processing remain active independently.

Mono samples feed both output sides; stereo samples retain their left and
right channels. Files with more than two channels are rejected. **WIDTH** is
mid/side width: 0 collapses to mono, 1 preserves the stereo image, and 2
widens it. Widening can reduce mono compatibility or increase peaks, so check
the mix and output meter. Noise is mono and feeds both sides.

The saturator and compressor are bypassed by default, including when restoring
older patches without those settings. Select **OFF · ENABLE** to activate
either one and **ON · BYPASS** to turn it off again. Channel clipping engages
above 0 dB CLIP DRV; the master clipper remains active. The master ceiling scales the clipped signal;
it is not a limiter, and increasing OUTPUT can still exceed 0 dBFS.

## Sample channels

**M** mutes and **S** solos a channel. Noise has independent enable, mute and
solo controls; its solo has no effect while the synth is off. When any active
source is soloed, non-soloed sources are silent. The minus/plus button
minimizes or expands a strip without changing the sound.
Restored strips and additional controls fade in briefly; reduced-motion
settings disable the transition.
A hollow status light and subdued top border indicate a channel without a
sample; loaded channels have a filled light. Muted channels are dimmed separately.

Drag a knob vertically, Shift-drag for finer adjustment, click its value for
numeric entry, or double-click the knob to reset it. The sliders icon shows
additional controls; hiding them leaves modified controls visible. The
circular-arrow icon resets channel knobs after confirmation while preserving
the sample, trim, envelope, mute and solo. **EDIT** and **RESET ENV** are
grouped with these controls. These display preferences last for the editor session.

| Control | Function | Range |
|---|---|---|
| PITCH | Playback speed and pitch | -24 to +24 semitones |
| PLAY DLY | Start delay, not an echo | 0–1000 ms |
| ATTACK, SUSTAIN | Transient and body shaping | -1 to +1 |
| HPF, LPF | High- and low-pass filters; bypassed at 20 Hz and 20000 Hz | 20–2000 Hz; 800–20000 Hz |
| CLIP DRV, SHAPE | Clip input drive and soft/hard blend | 0–24 dB; 0–1 |
| CLIP GAIN | Waveform-header sample gain before channel processing | -60 to +12 dB |
| WIDTH | Mid/side stereo width | 0–2 |
| MIX | Channel level sent to the sum | 0–1.5 |
| PHASE | Signed timing shift as a fraction of trimmed length | -0.05 to +0.05 |

### Waveform, trim and envelope

The editable channel waveform shows an offline processed preview together with
trim handles and the gain envelope. Dim source audio outside the trim provides
context; processing tails beyond the playable sample appear in the sum.
Stereo channels are combined into one visual amplitude range, not downmixed
in the audio path. The preview updates when settings change, not on each hit.
Use **EDIT WAVE** for a larger source-time view.

- Drag IN and OUT to select the playable region without changing the file.
  Hold **Ctrl** while dragging to snap to a nearby silence boundary.
  The view resets zoom and recenters on the selection after a trim edit.
  Use **ZOOM** to magnify the selection, or **FULL** to show the entire sample
  and extend the selection. **FIT** returns to the selected region.
  When zoomed in, drag the subtle scrollbar below the waveform to move left or right; horizontal
  trackpad scrolling and Shift-wheel also pan it. The sum view works the same way.
- In the expanded channel waveform editor or noise settings, **DETAIL**
  selects 512, 2048 or 4096 preview bins. This display setting is shared
  by the channel and noise waveforms and does not change the audio.
- Drag **CLIP GAIN** in the waveform header to set the source level before
  channel processing, or type an exact dB value. Double-click the slider or
  label to reset it to 0 dB.
- Drag envelope points to shape gain; the bottom is zero gain. Double-click
  the waveform to add a point and right-click an interior point to remove it.
  **RESET ENV** restores a flat, full-gain envelope.
- Drag the handle in the middle of a sloped segment to bend its curve. Flat
  segments have no curve handle. Focus a handle and use arrow keys or Home to
  adjust or reset it. Ctrl+[ and Ctrl+] adjust the segment after a focused
  point; Home on a point sets it to zero.
- The slashed-circle icon estimates a timing offset against the first other
  loaded sample, using their left/source channels. It is most useful for
  similar recordings. Different sounds, sample rates, trims, pitch and
  processing may make the estimate misleading; listen and adjust PHASE.
- Use the sample-name menu to move a sample to an empty channel or swap
  samples between channels. Source data, names and trims move; envelopes and
  processing controls remain with their channels.

## Signal chain and output controls

The noise synth provides **FREQ**, **RESO**, **DECAY**, **CLIP DRV** and
**MIX**. Its waveform in the settings popup shows processed noise and can be
edited directly, with gain-envelope points, curve handles and reset like a
sample channel. IN/OUT gates a window within the generated hit without shifting it
earlier; changing DECAY changes the window's time scale. There is no
source-file silence snapping for generated noise. The waveform shows an
offline preview; noise varies on each trigger.
The synth's enable switch is separate from **M**: enabling a muted synth leaves
it muted, and disabling it preserves its mute and solo settings. Its settings
button is available while the synth is on.

Use the up/down buttons to reorder noise, saturation and glue. Noise joins the
bus at its chosen position, so only effects after it process the noise. The
default order is noise, saturation, glue. The order is saved with the patch.
The line beside the modules shows the order from channels to output; the
plus marks where noise joins, and filled markers indicate active modules.
Use the settings button beside a module's enable switch to open its controls
in a popup. Saturation and glue settings are available even while bypassed;
editing them does not enable the effect.

The master **SATURATION** has an enable switch, **SAT DRIVE** and dry/wet
**SAT MIX**. The master
**GLUE COMPRESSOR** can be enabled independently. Its linked
stereo detector applies the same gain reduction to both sides. Adjust
**THRESH**, **RATIO**, **ATTACK** and **RELEASE** before the master clipper.
The **OUTPUT STAGE** contains **BUS DRIVE**, **SOFT/HARD**,
**CEILING** and **OUTPUT**, which follow the signal chain.

The **OUTPUT PEAK** meter in Mix Lab measures post-output-trim signal in dBFS, holds
peaks briefly and indicates values above 0 dBFS. **LAST PEAK** holds the
highest measured peak from the latest audible burst, separated from the next
by 300 ms below -80 dBFS. Neither is a loudness meter. WAV export clips sample
values above 0 dBFS.

## Mix Lab and live trace

The main sum shows the processed final output. It displays **RENDERING** until
the offline preview is ready. That preview uses a full-velocity trigger and
settled parameters; noise, velocity, overlapping hits, sample rate, parameter
changes and filter history can make live playback different.

**TRACE** is on by default. After a hit, its captured live audio replaces the
static preview; turn TRACE off to return to the preview. The preview remains
available while trace is armed or if capture fails. Capture retains the last
hit for up to four seconds, clears when the patch changes, and warns about
missed data. Play another hit after a gap warning. TRACE affects the sum and
its expanded comparison, not the channel or noise previews.

**EXPAND** compares final output, pre-master sum, each channel and noise.
All lanes share output time and amplitude scaling; the pre-master lane shows
the sum of all sources before effects, even when noise is inserted later in
the bus. Final output is after all master processing.
Nonlinear master processing prevents the final signal from being divided into
independent colored source contributions.

Use **VIEW** for the first 5, 20 or 100 ms of actual samples, or **FULL HIT**
for peak envelopes. **DETAIL** sets full-hit comparison resolution to 512,
2048 or 4096 bins. **ZOOM** magnifies the start of the sum timeline. **FIT**
increases display scale up to 20×; **ACTUAL 1:1** restores unscaled amplitude.
These controls change the display only.

Channel **SRC** times refer to source positions before pitch and delay; sum
**OUT** times refer to output. Different time spans, other sources and master
processing can make the sum look different from a channel. Stereo displays
show the combined bounds of both sides rather than a separate waveform for
each side.

## Patches, presets and WAV export

- **SYSTEM MENU → INITIALIZE PATCH** resets settings and clears loaded
  samples after confirmation. Noise returns to disabled; the theme is
  retained. Existing preset and WAV files are not deleted.
- Native host project state embeds decoded mono or stereo sample data and
  settings, so project size grows with sample length. Theme is stored in the
  project state.
- **EXPORT PRESET** saves a self-contained `.lfpreset` containing the patch
  and samples, not a rendered WAV. The preset library uses
  `~/Library/LayerForge/Presets` on macOS. Copy older presets into that folder
  and use **REFRESH**; right-click a preset to delete it after confirmation.
- **PREPARE WAV** renders the current mix in memory as 24-bit, 44.1 kHz
  stereo audio. Prepare again after changes. **SAVE WAV** explicitly chooses
  a destination; the plug-in does not automatically write an export file.
- **COPY / DRAG WAV** uses clipboard audio or, on macOS, a file promise until
  a WAV is saved. After saving, a file reference can be used. Destination
  support varies: if a DAW rejects it, import the saved WAV through its
  browser or drag it from the file manager. Native drag-out is macOS-specific.

The system menu also offers theme selection, hover help, diagnostics and a
link to the repository usage guide. Hover or focus control labels for help.
LayerForge does not automatically write export caches or diagnostic log
files; the DAW and operating-system webview may manage their own files.

## Troubleshooting

- **No sound:** trigger a MIDI note, check mute/solo,
  levels and the host output routing. Enable and unmute noise if you want to hear it
  without loading a sample.
- **Trim or envelope handles are hard to use:** open **EDIT WAVE** for more
  space. Trim snapping uses Ctrl.
- **Phase alignment sounds worse:** it is an estimate, not a guarantee.
  Listen and adjust PHASE manually, especially for unrelated recordings.
- **Waveform differs from playback:** inspect TRACE after a new hit and
  compare source-time versus output-time views. Noise and live performance
  conditions can differ from the offline preview.
- **Plug-in not found:** rescan plug-ins in the DAW's plug-in settings and
  confirm the correct platform build is installed.
- **Copy or drag rejected:** save the WAV explicitly and import it from the
  file manager or the DAW browser.

## Advanced validation and limitations

`npm run check` runs lint and the Node tests. `npm run build:ui` and
`npm run build:native` run those checks first; `npm run build` builds both UI
and native targets without installing. See [CONTRIBUTING.md](CONTRIBUTING.md)
for waveform-testing guidance.

These checks do not certify every host workflow. Native MIDI is handled in the
audio processor and restored patches can play with the editor closed. DAW
automation parameters are not yet exposed by the native processor. Native
host MIDI, preset and project round trips, clipboard, drag/drop,
window sizing, and cross-platform behavior require manual host testing.
