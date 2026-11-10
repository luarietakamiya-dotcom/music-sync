# Measurement contract and known limits

| Field | Meaning |
| --- | --- |
| integratedLufs | K-weighted mono/stereo channel-summed energy, 400 ms blocks at 100 ms hops, −70 LUFS absolute gate then −10 LU relative gate |
| samplePeakDbfs | 20 log10 of maximum absolute input sample across channels |
| truePeakDbtp | Maximum of samples and 4×, 24-tap Lanczos-windowed sinc interpolation, zero extension at ends; **estimate** |
| rmsDbfs | 20 log10 of RMS over all channel samples; channels are averaged |
| crestFactorDb | Sample peak minus RMS; not EBU LRA or a perceptual dynamics score |
| stereoCorrelation | DC-removed Pearson correlation (−1…1), null for mono or zero-variance channel |
| sideEnergyPercent | Side energy / (Mid energy + Side energy), with M=(L+R)/2 and S=(L−R)/2 |
| clippedSamples | Number of samples with absolute value ≥1 across all channels; not proof of historical clipping |
| dcOffset | Mean sample value per channel |

Only complete loudness blocks are used. Incomplete trailing blocks are excluded.
Silence/below-gate input has no finite LUFS; <400 ms clips are not padded to invent
a value. Null serializes safely in JSON. Crest is null for silence. Mono is not
duplicated to stereo for metering. Stereo anti-phase is not summed to mono for LUFS.

K-weighting uses rate-dependent coefficients corresponding to the BS.1770 design,
tested at 44.1/48/96 kHz against independent pyloudnorm DeMan outputs at 60/1000/8000 Hz.
The implementation accepts 8–192 kHz; exhaustive accuracy at every rate is not
verified. True peak uses a practical finite filter and can deviate at near-Nyquist
frequencies and boundaries. It is not the ITU Annex 2 example filter, and this
release is **not a conformant/certified meter**. Reference coverage is synthetic,
not the complete ITU/EBU compliance suite. No LRA, spectrum or per-band analysis yet.

WAV is parsed as bounded RIFF/PCM (not RF64/RIFX). Extensible WAV supports matching
container/valid bits with standard mono/stereo layouts; other encodings are rejected.
FLAC uses native browser decoding at the STREAMINFO sample rate. Unknown total
sample count is rejected to bound memory. Other formats and malformed metadata
are rejected with an actionable message. Decoding support must be verified for
each browser; Chromium has automated coverage, Firefox/Safari do not yet.

Sources: [ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I),
[pyloudnorm reference implementation](https://github.com/csteinmetz1/pyloudnorm),
[Web Audio specification](https://www.w3.org/TR/webaudio/).
