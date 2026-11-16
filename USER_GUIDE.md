# LayerForge User Guide

This guide covers the browser preview and native plug-in. The native plug-in
accepts MIDI Note-On events; it does not send MIDI. In the browser, click **HIT**
or press Space to audition. Browser MIDI is optional and depends on Web MIDI
support and permission.

## Load and play samples

Drop an audio file onto a channel, or click the channel's sample area to choose
a file. The file must be decodable by the browser engine. A multichannel file
is converted to mono by averaging its first two channels; a mono file is kept
as mono. Loading a sample auditions it immediately.

Use **M** to mute a channel and **S** to solo it. When any channel or the noise
source is soloed, only soloed sources are heard.

Knobs respond to vertical drag. Hold **Shift** while dragging for finer
adjustment. Click a displayed value to enter a number, or double-click the knob
to restore its default. Values are clamped to each control's supported range.

## Channel controls

Each of the three sample channels has the following controls:

| Control | Range | Function |
|---|---:|---|
| **PITCH** | −24 to +24 st | Changes playback rate and pitch. Higher values make a shorter, higher hit; lower values make a longer, lower hit. |
| **PLAY DLY** | 0–1000 ms | Delays the sample's start. This is not an echo or a repeat effect. |
| **ATTACK** | −1 to +1 | Adjusts the detected transient component. It is not an envelope attack-time control. |
| **SUSTAIN** | −1 to +1 | Adjusts the slower body component. It is not an ADSR sustain-level control. |
| **HPF** | 20–2000 Hz | High-pass filter cutoff. |
| **LPF** | 800–20,000 Hz | Low-pass filter cutoff. |
| **CLIP DRV** | 0–24 dB | Input drive to the layer clipper. |
| **SHAPE** | 0–1 | Blends the smooth and hard clipping curves; 0 is smoothest and 1 is hardest. |
| **MIX** | 0–1.5 | Layer level in the mix. |

### Gain envelope and trim

The channel waveform contains an editable sample-relative gain envelope. Drag
an existing point to change its time or gain, double-click the curve to add a
point, and right-click an interior point to remove it. The two endpoints remain
at the beginning and end of the playable sample. The envelope supports up to 12
points total and interpolates linearly between them.

Drag the end handle to trim playback without changing the loaded source. The
trim and envelope are saved with native project state and affect playback and
WAV export.

## Noise and master controls

The noise source is independent of the three sample channels. It also has
**M**/**S** controls.

| Control | Range | Function |
|---|---:|---|
| **FREQ** | 150–16,000 Hz | Band-pass filter center frequency. |
| **RESO** | 0.5–10 | Band-pass filter resonance (Q). |
| **DECAY** | 0.005–0.6 s | Noise burst envelope decay. |
| **CLIP DRV** | 0–24 dB | Input drive to the noise clipper. |
| **MIX** | 0–1 | Noise level in the mix. |

The master bus has three controls:

| Control | Range | Function |
|---|---:|---|
| **BUS DRIVE** | 0–24 dB | Input drive to the final clipper. |
| **SOFT/HARD** | 0–1 | Blend from smooth saturation to hard clipping. |
| **CEILING** | 0.1–1 | Scales the clipped output. It is not a separate limiter. |

## DSP signal path

LayerForge uses one shared Elementary Audio graph for browser playback,
offline WAV rendering, and the native plug-in:

1. Each loaded sample is played as a mono source. Pitch changes the playback
   rate using a semitone ratio; trim limits the sample's stop position.
2. The sample-relative gain envelope is applied, followed by its start delay.
3. A state-variable high-pass filter is followed by a state-variable low-pass
   filter. Both use a fixed Q of 0.707.
4. The transient shaper compares fast and slow signal envelopes to adjust
   transient and body levels. Its envelope follower times are 2/25 ms for the
   fast follower and 25/180 ms for the slow follower.
5. A layer clipper blends `tanh` soft saturation with hard clipping at ±1,
   then applies the layer mix level.
6. The noise path generates noise, applies a band-pass filter and a
   gate-controlled decay envelope, then clips and mixes it with the layers.
7. The sum is scaled by incoming trigger velocity, processed by the master
   soft/hard clipper, and scaled by **CEILING**.

The current DSP graph sends the same final signal to its left and right
outputs. Consequently, WAV exports are stereo PCM files with identical
left/right audio, not a stereo-width or panning effect. Exports are 24-bit,
44.1 kHz WAV; the export does not normalize the patch.

## Waveforms

Channel waveforms are responsive estimates of the processed signal, not exact
renders. The layer-sum display initially shows a live estimate; when the
offline DSP preview finishes, its status changes to **DSP RENDER** and the
display uses the rendered signal. Choose **3D FIELD** or **2D WAVE** for the
sum view; drag the 3D field horizontally to rotate it.

## Save projects and export files

### Native plug-in project state

The DAW project state stores the patch and decoded mono audio for loaded
samples. This makes the patch self-contained when the DAW project is moved, but
increases project size with the sample audio.

### Presets

Choose **SYSTEM MENU → EXPORT PRESET** in the native plug-in to save a
self-contained `.lfpreset` containing the patch and complete sample data. The
export also retains available source names and locations as metadata. It does
not rely on temporary WAV exports.

### WAV files

Click **EXPORT 24-BIT .WAV** to render the current patch. In the browser, the
file downloads. In the native plug-in, use **COPY / DRAG WAV** to copy the WAV
to the clipboard; on macOS, drag it directly into a compatible host. Use
**SAVE WAV** to choose a permanent file location.

Native drag-out is macOS-only. On Windows, save the WAV and then drag the
saved file from your file manager into the DAW. Native temporary export files
are removed when the editor closes; abandoned files are pruned after 30 days.

## Platform notes and troubleshooting

- VST3 downloads are platform-specific. A macOS plug-in does not run on
  Windows.
- The Windows plug-in uses WebView2 and requires the Microsoft Edge WebView2
  Runtime if it is not already installed.
- Release bundles are not Developer ID signed or notarized. macOS may display
  a Gatekeeper warning for a downloaded plug-in.
- Open **SYSTEM MENU → DIAGNOSTICS** to view and copy a report. On macOS, the
  native plug-in also writes logs to
  `~/Library/Logs/LayerForge/LayerForge.log`.
