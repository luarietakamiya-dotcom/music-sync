---
license: mit
library_name: onnx
pipeline_tag: audio-to-audio
tags:
- audio
- source-separation
- music-source-separation
- onnx
---

# SCNet, ONNX (int8 weights)

SCNet (Tong, Zhu, Chen, Kang, Jiang, Li, Wu, Meng, "SCNet: Sparse Compression Network for Music Source
Separation", ICASSP 2024, [arXiv:2401.13276](https://arxiv.org/abs/2401.13276)): band-split convolutions around dual-path
LSTMs on the complex spectrogram, 10.1 M parameters (SCNet-large at half the width), trained by its author on
MUSDB18-HQ. It splits a song into four stems: drums, bass, other, vocals. This is the network between its STFT and iSTFT, as
[@audio/neural-separate](https://github.com/audiojs/neural/tree/main/packages/neural-separate) runs it
(`model: 'scnet'`).

| File | Size | SHA-256 |
|---|---|---|
| `scnet.int8.onnx` | 12.9 MB (12,900,277 bytes) | `98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845` |

The float32 export it is made from is 42.8 MB; float16 weights would be 23.2 MB.

## Source

- Model and code: [starrytong/SCNet](https://github.com/starrytong/SCNet) (MIT), at `5d95bf96b19c3eede63248d171efeca8e3abb948`.
- Checkpoint: `scnet_checkpoint_musdb18.ckpt` (SHA-256 `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa`),
  release v.1.0.6 of [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
  (MIT), with its `config_musdb18_scnet.yaml`; the model code that repository's `models/scnet` at
  `84b1eac0887756b4f1a9d7a1ff49105939749ed2`.

## Licence and attribution

MIT, Copyright (c) 2024 starrytong ([LICENSE](LICENSE)). The weights' author, in
[starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35#issuecomment-4999873539) (2026-07-17):

> I confirm that the released SCNet and SCNet-large pretrained weights are distributed under the MIT License,
> consistent with the source code. You are welcome to redistribute the original checkpoints and format-converted
> versions, including ONNX exports, as part of your MIT-licensed tool, with appropriate attribution.

SCNet by its authors (starrytong/SCNet); the checkpoint as Music-Source-Separation-Training (Roman Solovyev)
distributes it; ONNX export and compaction by audiojs. Trained on MUSDB18-HQ (Rafii et al., 2019), licensed for
educational use; whether that reaches the weights no project has settled.

```bibtex
@inproceedings{tong2024scnet,
  title     = {SCNet: Sparse Compression Network for Music Source Separation},
  author    = {Tong, Weinan and Zhu, Jiaxu and Chen, Jun and Kang, Shiyin and Jiang, Tao and Li, Yang and Wu, Zhiyong and Meng, Helen},
  booktitle = {IEEE International Conference on Acoustics, Speech and Signal Processing (ICASSP)},
  year      = {2024},
  eprint    = {2401.13276},
  archivePrefix = {arXiv}
}
```

## Graph

One 11 s segment (485,100 samples at 44.1 kHz, padded to 476 frames) per run:

| | name | shape | |
|---|---|---|---|
| input | `mix_spec` | [1, 4, 2049, 476] | STFT: n 4096, hop 1024, no window, scaled by 1/√4096, centered with reflect padding; L re, L im, R re, R im |
| output | `stems_spec` | [1, 16, 2049, 476] | each source (drums, bass, other, vocals), channel, re and im |

The segments (every 2.75 s), their fades and the input's normalization follow Music-Source-Separation-Training's
`demix()`; @audio/neural-separate's README, Algorithm, has them.

```js
import separate from '@audio/neural-separate'
let { stems } = await separate([left, right], { sampleRate: 44100, model: 'scnet' })
```

## Export, compaction, verification

`scripts/export-scnet.py --model scnet --verify` exports the network (its rFFT over time as cosine and sine
products, its GroupNorm statistics reduced axis by axis) and compares the graph with `SCNet.forward` on noise and tones:
max |diff| ≤ 2.2e-6 of max |y|; the package's pipeline matches `SCNet.forward` on its segments to 123–133 dB SNR per
stem. `scripts/compact.py --model scnet --calibrate <two MUSDB18 training previews>` makes this file from it:

- Weights: 77 of 82 stored in int8 (99.2 % of the values; symmetric, a scale per output channel, an LSTM's per gate row
  and direction), the five layers ending the decoder in float16 (`decoder.2.0`'s convolution, `decoder.1.1`'s three
  transposed convolutions, `decoder.2.1`'s first): rounded alone to int8, each moves the output 27 to 39 dB under its
  power; all 82 together, 23.4 dB.
- Computed in float32 on every backend: each weight is Cast and multiplied by its scale in the graph, which onnxruntime
  folds at load (the session holds float32 weights).
- Folded and named short, changing no value: with the input's shape fixed, every value computable from the weights and
  the shapes alone is stored as the graph computes it (its DFT matrices, made in float64 from a Range, which
  onnxruntime-web's WebGPU session cannot place); node and value names are base-36 counters.
- Against the export, on the calibration previews: max |diff| 1.1e-2 of max |y|, SNR 42.4 dB.

## Quality

The 50 MUSDB18 test previews, BSSEval v4 SDR (museval), the median over songs, dB:

| | vocals | drums | bass | other |
|---|---|---|---|---|
| export (float32) | 9.88 | 9.43 | 8.35 | 6.15 |
| this file | 9.88 | 9.44 | 8.35 | 6.14 |
| change per song: median · the song that lost most | +0.00 · −0.29 | −0.00 · −0.04 | −0.00 · −0.10 | −0.01 · −0.07 |

The −0.29 dB is a song whose vocal stem is near silence (PR - Happy Daze, −2.2 dB SDR as exported); with all 82 weights
in int8 (12.8 MB) it lost 2.6 dB, hence the five in float16. Remixes (the input plus (g − 1) times a stem, against the
true remix): vocals +6 dB 18.23 → 18.23, vocals −6 dB 21.05 → 21.05, drums −6 dB 20.91 → 20.92. Float16 weights
(23.2 MB) change no median by more than 0.001 dB.
