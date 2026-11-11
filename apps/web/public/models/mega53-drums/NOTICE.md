# Notices

## Upstream code and learned weights

BSRoformer / Music-Source-Separation-Training: Copyright (c) 2024 Roman Solovyev (ZFTurbo). MIT License; complete text is in LICENSE. The pinned source revision is `1d4b3c431b37de696b3795ed2018493aacba946f`. The five reduced Mega53 learned checkpoints are sourced from `noblebarkrr/BS-Roformer-MVSep-Mega-53-stems`, revision `0677941f9cdfd891a6bc3336229244e197035327`; exact source URLs and checksums are in model-provenance.json.

The author confirmed MIT licensing, commercial integration and conversion permission for the 53-stem weights in [issue 245, owner comment](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838). The author expressly did not guarantee the training data's copyright clearance or provide indemnification. The MIT terms and disclaimer remain applicable.

## Conversion and deployment transformations

Music Sync contributors assembled one byte-identical shared trunk with the five trained heads in the original order: kick, snare, hh, toms, percussion. The real-only host-STFT wrapper retains learned RMSNorm, gated rotary attention and each original MLP/GLU mask head. The shortened fixed context is a prototype modification. Constant matrix weights were stored as per-output-channel INT8 and dequantized for Float32 computation. Two wide Split nodes were replaced with ordered Slice nodes; this deployment rewrite did not modify any original initializer and is CPU-bitwise equivalent to the base compact graph.

This file does not introduce a learned cymbal/ride/crash head. Independent estimates overlap and are not a complete exclusive drum partition. Any ratio masking or residual rendering by a host is a separate operation. The weights are provided AS IS, without a semantic quality or native-20-second-context guarantee.

## Runtime and host frontend

ONNX Runtime Web 1.31.1 is a separate Microsoft MIT-licensed runtime. Its webgpu entry requires the matching asyncify MJS/WASM files used in this test. Keep its LICENSE and ThirdPartyNotices if redistributing runtime assets; checksums are recorded in model-provenance.json. Browser preprocessing in the probe used @audio/neural-separate 0.7.0 (MIT, audiojs / Dmitry Iv.) and its dependencies. Preserve each dependency's notices when bundling that frontend. Those packages are not embedded learned weights in this ONNX file.
