# LIVE depth / v0.7.2

The v0.9.0 default uses a stronger venue network with three user-selectable spaces.
See [Venue LIVE](live-venues.md). This document records the preserved v0.7.2 kernel.

The original LIVE room was deliberately subtle. Its short early reflections and
small late mix could be difficult to distinguish after loudness matching. A user
requested a clearer sense of venue and depth, rather than extra loudness.

The normal LIVE strategy now selects `small-hall`: wet 0.28, nominal decay 1.1 s,
24 ms pre-delay, and four spaced early reflections. The old `intimate-room` remains
supported with its original rendering response. Preset data stays in Core; rendering
stays in DSP, inside the existing processing Worker.

The hall uses four damped delay lines, normalized tail injection and two short
all-pass diffusers per channel. Only the added sound is filtered and decorrelated.
Two high-pass stages protect its wet low end, while foreground-dependent ducking
and pre-delay preserve the direct sound. Direct sample timing, channels and length
remain unchanged. Ring memory is bounded by sample rate and venue, not song length.
The final 80 ms fades the added tail to preserve existing export duration.

Selection is adaptive: wide or unstable inputs retain a quiet room; center-dominant
material receives less wet sound and longer pre-delay; bass-heavy material raises
the wet high-pass. Confident temporal Dry evidence can override the older sustained-
level heuristic, since sustained notes alone do not identify existing reverb.
Wet estimates select a shorter room and strongly reduce the addition. Low-confidence
estimates reduce wet level. Existing bounded retries further reduce processing.

Quality Gate thresholds are unchanged. Peak, clipping, DC, dynamics, stereo and
spectral regressions can still cause retries or rejection. Stronger room sound is
a creative direction, not an assurance of subjective improvement. Loudness matching
remains enabled automatically, and Original remains available throughout processing.

Tests compare late impulse-tail energy with the legacy room, check direct timing,
finite buffers, wet bass attenuation, immutable Original, adaptive selection and
parameter limits. A rhythmic synthetic arrangement checks that waveform difference
remains after loudness matching; this is evidence of changed audio, not a listening
quality score. Browser coverage verifies the selected venue, A/B and WAV export.
