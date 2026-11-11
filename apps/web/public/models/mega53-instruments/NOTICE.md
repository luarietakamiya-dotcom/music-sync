# Notices

## Learned weights and source

BSRoformer / Music-Source-Separation-Training: Copyright(c)2024 Roman Solovyev (ZFTurbo). MIT License; exact complete upstream text is supplied in LICENSE.

Six reduced Mega53 heads are sourced from noblebarkrr/BS-Roformer-MVSep-Mega-53-stems, fixed revision 0677941f9cdfd891a6bc3336229244e197035327, with exact checkpoints/configs/source identities in model-provenance.json. [The author permits MIT commercial redistribution and conversion for the53-stem weights](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838). No training-data clearance, indemnification or output-quality guarantee was supplied.

## Changes

Music Sync contributors combined the six trained heads lead-vocal,back-vocal,piano,guitar,bass,drums around a byte-identical shared trunk, retained original learned normalization/attention/mask math, shortened context for experimental browser execution, used symmetric INT8 constant storage with Float32 compute, and rewrote only wide Split fanout to Slice. Native/ONNX and equivalent-quantized-native comparisons were performed.

The host app computes mixture-consistent stereo-linked ratio masks and an unassigned remaining-other output. That remainder is not another learned classifier. Learned estimates may overlap and bleed. This direct fullmix mode replaces its entire output set; SCNet parent stems are not added again.

## Separate frontend/runtime

ONNXRuntimeWeb1.31.1 is MIT, copyright Microsoft Corporation; the app distributes its LICENSE and ThirdPartyNotices under vendor/onnxruntime/. @audio/neural-separate0.7.0 and its helper/source notices are preserved under vendor/audiojs/ThirdPartyNotices.txt. These runtimes/frontend packages are not embedded learned weights in this ONNX file.
