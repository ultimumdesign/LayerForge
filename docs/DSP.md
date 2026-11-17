# LayerForge DSP reference

This is the technical description of the audio engine in
[`dsp/`](../dsp). It documents what the code does today, including its
trade-offs. For controls and workflows, see the [user guide](../USER_GUIDE.md);
for how the engine is hosted, see [ARCHITECTURE.md](ARCHITECTURE.md).

All audio is built as an [Elementary Audio](https://www.elementary.audio/)
graph by `buildDrumGraph()` in `dsp/engine.js`. The same function feeds the
browser (Web Audio), the offline renderer (previews and WAV export) and the
native plug-in, so every target shares one signal path. Processing is 32-bit
float.

## Signal path

```text
 trigger (gate / note-on, velocity)
        │
        ├─► Channel 1 ─┐   per channel (left and right processed alike):
        ├─► Channel 2 ─┼─► sample ► trim/pitch ► envelope ► delay ► HPF/LPF
        └─► Channel 3 ─┘   ► transient shaper ► clipper ► M/S width ► MIX
                 │
                 ▼  left/right sum × velocity
   ┌───────────── bus modules, in the saved order (default) ─────┐
   │   + noise synth ► saturation (optional) ► glue (optional)   │
   └──────────────────────────────┬──────────────────────────────┘
                                  ▼
                 master clipper ► CEILING ► OUTPUT trim ► out
```

Noise (band-pass ► envelope ► clipper ► MIX) is mono and is added to both sides
at its position in the bus order. Only modules *after* noise process it.

## Timing and triggering

| Item | Behavior |
|---|---|
| Trigger | Any MIDI note-on (any note, any MIDI channel) or Space/click in the editor. Note-off is ignored, and the played note does not change pitch. |
| Velocity | Linear scale `velocity/127` applied to the channel sum and to noise as each enters the bus. Lower velocity drives the master clipper and any downstream bus effects less; effects before the noise module do not process noise. |
| Gate | A trigger raises a 28 ms gate. Samples are one-shots; the noise envelope restarts on a trigger but is not cut short by the gate (see [Noise synth](#noise-synth)). |
| Native timing | The native processor reads MIDI sample positions within each audio block, so triggers are sample-accurate. Browser triggers use timers and Web MIDI and are not. |
| Retriggering | Each channel has two alternating voices. A new hit starts immediately while the previous voice fades out with a 10 ms time constant, avoiding clicks. A third rapid hit reuses the oldest voice. |
| Latency | No look-ahead and no oversampling; the engine adds no latency and reports none to the host. |
| Tail | The processor reports a 4.1 s tail to the host. |

## Sample playback

- **Resampling.** Playback advances at `2^(PITCH/12) × sourceRate / hostRate`,
  read with linear interpolation. PITCH is *varispeed*: pitching up shortens
  the sample and pitching down lengthens it. There is no time-stretch.
  Linear interpolation without anti-alias filtering can add high-frequency
  artifacts when pitching up bright, transient-rich material.
- **Trim.** `IN` and `OUT` are stored as fractions of the file (minimum
  selection 1 %). Playback starts at IN and stops at OUT. Newly loaded samples
  default to an OUT after the last nonzero sample in either channel plus 20 ms
  of padding, bounded by the file end and minimum selection. Completely silent
  files retain their full range. The source file and restored trims are unchanged.
- **PLAY DLY.** A delay of 0–1000 ms applied after the envelope, via a
  384 000-sample delay line (8 s at 48 kHz).
- **PHASE.** A signed alignment shift of up to ±5 % of the trimmed length. A
  positive value *delays* playback by that many source samples (converted to
  seconds at the pitched rate); a negative value *skips ahead* in the sample.
  It is a time alignment aid, not an all-pass: no phase rotation is applied.
- **Mono and stereo.** Mono files drive both sides with the same signal.
  Stereo files use separate left and right buffers, and every stage below runs
  per side. Files with more than two channels are rejected.
- **Gain envelope.** Up to 10 interior points plus fixed endpoints, values 0–1,
  with time normalized to the trimmed sample (source time, so the envelope
  follows PITCH). Segment curves (−0.5 to +0.5) use a power law with
  `exponent = 2^(4·|curve|)`: positive curves rise quickly then flatten,
  negative curves start slowly. Curved segments are rendered as 32 straight
  steps.

## Channel processing

Order: sample → CLIP GAIN → envelope → delay → filters → transient shaper →
clipper → stereo width → MIX.

### Filters

A high-pass followed by a low-pass, each a state-variable filter at **Q =
0.707** (12 dB/octave, Butterworth-style, no resonance peak). At their limits
(HPF 20 Hz, LPF 20 kHz) they are removed from the graph, a true bypass.

### Transient shaper

A level-dependent differential-envelope shaper:

```text
rectified = |x|
fast      = follower(attack 2 ms,  release 25 ms)  of rectified
slow      = follower(attack 25 ms, release 180 ms) of rectified
transient = max(0, fast − slow)
gain      = max(0, 1 + ATTACK·4.5·transient + SUSTAIN·2.2·slow)
y         = x · gain
```

`fast − slow` is positive only while the level is rising, which isolates the
onset; `slow` tracks the body. Both terms use absolute amplitude, so the effect
scales with signal level: a quiet source needs larger settings for the same
change. Negative values reduce gain and the result is floored at zero.

### Clipper (hybrid soft/hard)

```text
d = x · 10^(CLIP DRV / 20)
y = (1 − SHAPE) · tanh(d) + SHAPE · clamp(d, −1, +1)
```

SHAPE 0 is a smooth `tanh` curve, 1 is a digital hard clip, and values in
between crossfade the two. The curve is **not** gain-compensated: CLIP DRV adds
level at the input and the output cannot exceed ±1. Even at 0 dB, `tanh` bends
the curve (a full-scale input leaves at about 0.76).

The channel clipper is bypassed when CLIP DRV is 0 dB; the master clipper is
always in circuit (defaults: +2 dB, SHAPE 0.45). Both are memoryless and run
**without oversampling**, so heavy drive on bright material produces some
aliasing; hard clipping aliases more than `tanh`.

### Stereo width (mid/side)

```text
mid  = (L + R) / 2
side = (L − R) / 2 · WIDTH
L'   = mid + side
R'   = mid − side
```

WIDTH 0 is a mono sum, 1 leaves the image unchanged, and 2 doubles the side
signal. Widening raises side energy, which can reduce mono compatibility or
increase peaks. The clipper runs before width, per side.

### CLIP GAIN and MIX

CLIP GAIN (−60 to +12 dB) is applied before the envelope, filters, transient
shaper and clipper, so it changes how hard they are driven. MIX is a linear gain
of 0–1.5 (up to about +3.5 dB) applied after all channel processing.

## Noise synth

```text
white noise ► band-pass SVF (FREQ, RESO) ► envelope ► [trim window × curve]
            ► clipper (CLIP DRV, SHAPE fixed at 0.45) ► MIX
```

- **Source.** One uniform white-noise generator, shared by both sides (mono).
  It is free-running, so every hit differs.
- **Filter.** Band-pass, FREQ 20–20 000 Hz, RESO (Q) 0.1–30.
- **Envelope.** Time-based and identical in every renderer: 1 ms attack, then
  `exp(−6.91 · t / DECAY)` (DECAY, 2 ms–3 s, is the time to fall about 60 dB),
  then a 15 ms linear fade at `t = DECAY`. A trigger only restarts the clock,
  so the 28 ms gate does not shorten the noise.
- **Window and curve.** IN/OUT and the gain curve span `DECAY + 16 ms`,
  normalized 0–1. With full trim and the default flat envelope this stage is
  skipped.
- **Audibility.** Noise with MIX at or below 0.0005 is removed from the graph.

## Master bus

### Order

Noise, saturation and glue are user-ordered and saved in the patch (default:
noise, saturation, glue). The channel sum comes first; each module then acts on
the running bus. Disabled modules are removed from the graph.

### Saturation

```text
wet  = tanh(g · x) / tanh(g),   g = 10^(SAT DRIVE / 20)
mix  = (1 − SAT DRY/WET) · x + SAT DRY/WET · wet
out  = mix · 10^(SAT OUTPUT / 20)
```

Dividing by `tanh(g)` makes a full-scale input map to full scale. Small signals
are boosted by about `g / tanh(g)` (≈ +6.3 dB at 6 dB drive), so drive also
raises perceived loudness. Memoryless, no oversampling.

### Glue compressor

A feed-forward, stereo-linked, peak-sensing compressor:

1. Detector: `max(|L|, |R|)` through a one-pole follower with ATTACK
   (1–100 ms) and RELEASE (30–600 ms) time constants.
2. Level in dBFS, then `over = level − THRESH` (THRESH −36 to 0 dB).
3. A soft knee of width KNEE (0–24 dB, default 6): quadratic within ±KNEE/2
   of the threshold, linear above it. KNEE 0 uses a near-hard 0.01 dB knee.
4. Gain reduction in dB is `(1 − 1/RATIO) · compressedOver` (RATIO 1–8:1),
   applied equally to both sides so the stereo image is preserved.
5. DRY/WET (0–1, default 1) blends the uncompressed signal with the compressed
   one (parallel compression); 0 is dry.
6. OUTPUT applies `10^(OUTPUT / 20)` to the blended signal.

Each effect's OUTPUT ranges from −24 to +24 dB, defaults to 0 dB, and is
bypassed along with that effect. Older patches without these settings restore
at 0 dB. There is no automatic make-up gain, look-ahead or program-dependent
release. A peak detector reacts to transients faster than an RMS one, but very
short peaks can pass before the attack takes hold.

The effect meters tap the running bus immediately before and after each
module, including its dry/wet blend and OUTPUT gain. Each peak is the maximum
absolute sample across both channels over the meter update interval.
Compressor WET REDUCTION reports the maximum of the actual linked wet-path
gain reduction in dB over that interval, not an estimate from input/output
levels or the dry/wet blend. It can remain nonzero when DRY/WET is 0.

HIT PEAK readouts (UI only, no DSP effect) hold the largest meter-interval
value since a hit began; a hit ends after 300 ms with peaks below 0.0001
(about −80 dBFS) or reduction below 0.05 dB. They are interval peaks, not
true-peak or inter-sample values.

Resetting a module's knobs restores its parameter defaults (including OUTPUT
and dry/wet where present) while leaving enable flags and bus order untouched.

### Master clipper, ceiling and output

After the bus: master clipper (BUS DRIVE 0–24 dB, SOFT/HARD 0–1), then
**CEILING**, then **OUTPUT**.

- **CEILING** is a linear gain of 0.1–1.0 (default 0.95 ≈ −0.45 dB; 0.5 =
  −6 dB) applied to the clipped signal. It is not a limiter.
- **OUTPUT** (−60 to +12 dB) comes last, so positive values can exceed
  0 dBFS. Watch the OUTPUT PEAK meter.

## Parameter smoothing

Continuous controls (pitch, delay, filters, width, MIX, noise, saturation,
glue, effect OUTPUT gains and ceiling)
pass through Elementary's `el.sm`, a one-pole smoother with a 20 ms time
constant, to avoid zipper noise. Changes settle in about 100 ms. Structural
changes (enabling a module, reaching a filter bypass limit, editing the
envelope, trim or sample) rebuild the graph; the renderer crossfades them, so
the first hit after an edit can fade in briefly.

## Offline renderer, previews and WAV export

`src/audio/wavExport.js` renders the same graph with Elementary's offline
renderer at a fixed **44.1 kHz** in 128-sample blocks after a 0.5 s warm-up.

- One full-velocity trigger is held for the 28 ms gate, then released.
- Length is the longest audible source (delay + trimmed length at the pitched
  rate), at least 120 ms, plus 20 ms. Trailing audio below −80 dBFS is trimmed,
  keeping a 10 ms margin.
- Output is 24-bit PCM stereo. Samples are clamped to ±1 and rounded to
  integers. No dither is applied.
- Previews use the same render. They differ from live playback because of
  noise, velocity, overlapping hits, host sample rate and filter or
  envelope-follower history.

WAV export stays at 44.1 kHz even if the host runs at another sample rate.

## Known limitations

- Clipper and saturator have no oversampling.
- Pitch is linear-interpolated varispeed with no anti-aliasing.
- Glue uses a peak detector with no look-ahead or automatic make-up gain.
- Two voices per channel; rapid retriggers beyond that cut the oldest.
- WAV export is fixed at 44.1 kHz / 24-bit.
