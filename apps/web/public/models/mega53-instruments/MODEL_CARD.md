# Music Sync Mega53 instrument separation

This optional PC Web model processes the original full stereo mix independently of SCNet. It has six verified learned heads in this order: **lead-vocal, back-vocal, piano, guitar, bass, drums**. The app derives a seventh **remaining-other** output from the original spectrum. Raw learned estimates overlap; host stereo-linked ratio masks and a remainder prevent duplicated mixture energy. They do not guarantee clean isolation. Do not also add SCNet parent vocals/other/drums/bass to these replacement outputs.

## Artifact and provenance

- File: `mega53-instruments-071fabf5.int8.onnx`
- Bytes: 104,573,310 (99.73 MiB, 284,290 bytes below GitHub's 100 MiB per-file bound)
- SHA256: `071fabf56f73ebf8bae1ff411eecdac2e02039666e82bb5de62dcf1aa3718557`
- License: MIT; preserve LICENSE and NOTICE.md.

All six reduced checkpoints come from [the pinned Mega53 repository](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/tree/0677941f9cdfd891a6bc3336229244e197035327), revision `0677941f9cdfd891a6bc3336229244e197035327`. Every checkpoint/config/source hash is recorded in model-provenance.json and checked before source import, safe YAML parsing or `torch.load(weights_only=True)`. All 451 shared non-mask tensors have identical keys/shapes/dtypes/values and fingerprint `d3cc49570f2cf204f056ddb7ea03fbedf29b27ac06b05d1af6b8bd4c26494fcb`; each trained head retains its original mask MLP/GLU, and the learned final RMSNorm/gated rotary attention are preserved.

Source implementation is pinned to [ZFTurbo commit 1d4b3c431b37de696b3795ed2018493aacba946f](https://github.com/ZFTurbo/Music-Source-Separation-Training/tree/1d4b3c431b37de696b3795ed2018493aacba946f). [The author's MIT commercial-use/conversion grant](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838) covers the 53 targets. The author does not provide training-data clearance or indemnification.

## Audio contract

44,100 Hz stereo; 132,096 samples per channel (2.995374s). Host STFT: FFT 2048 / hop 512, periodic Hann, center/reflect padding, unnormalized. No input standardization. `mix_spec` Float32[1,4,1025,259] -> `stems_spec` Float32[1,24,1025,259]. Target-major with left-real,left-imag,right-real,right-imag per target. DC output bin is zeroed by the graph. The app uses 2.99 s windows with overlap, retaining the original rate/frame count after SRC. The upstream 20 s context is longer; equivalent musical quality is not established.

The back-vocal config explicitly targets back-vocal and other, but this does not prove a vocal-bus-only workflow. The current host uses the full original mix; vocal-bus or SCNet-other inputs are not silently substituted.

## Numerical/runtime evidence

- Original native PyTorch -> FP32 CPU ONNX waveform relativeL2: 4.1204e-7.
- 926 matrices use per-output-channel INT8 storage, restored with Cast+Mul for Float32 computation. No activation quantization. Equivalent quantized native/CPU ONNX waveform relativeL2: 5.0129e-7.
- Intentional quantization waveform change vs original: 1.2158% relativeL2 on generated input. This is not lossless or a perceptual-quality score.
- Two 62-output Splits -> 124 ordered Slices; all 2,846 original initializers unchanged; CPU output bitwise-identical.
- Actual full Chromium 153 native WebGPU on nonfallback NVIDIA/Turing: 8418 compute dispatches. Init 5.337s; first exact-spectrum inference 1.226s; warm real JSFFT inference 0.467s. Device-specific short-input measurements are not whole-song promises.
- Exact-spectrum GPU/compactCPU waveform relativeL2 9.2811e-7. Tiny JS/PyTorch STFT rounding (input relativeL2 1.5001e-7) resulted in 1.5327% waveform difference, measured separately. Quiet heads have larger relative errors; see per-head JSON.
- All six outputs were finite, nonzero and 132,096-frame stereo; input unchanged. Generated audio contained no recorded singer. No real-song semantic/listening benchmark is claimed.
- Tracked GPU-route WASM buffers: 1,097,400,320 bytes, excluding GPU memory/JS/RSS. Runtime may use substantial additional memory; CPU and application-level memory require their own tests.

Use one ONNX Runtime Web 1.31.1 webgpu module and matching asyncify MJS/WASM assets in an external Worker, one thread/proxyfalse for nonisolated hosts. Full frontend/runtime notices ship under vendor/. Preserve originals and compare before adoption.

## Application integration checks

The actual production Worker also completed a generated four-second, two-window song on CPU and on a hardware WebGPU route. All seven downloaded Float32 WAVs had the original duration and rate and reconstructed the input (GPU summed waveform RMS error 2.43e-9). Original-file hashes and the existing A/B pair stayed unchanged. The CPU workflow also verified explicit main/backing roles through staging, raw mixing and a portable-project save/reload. Separate explicitly mocked inference tests check error/cancellation cleanup; these are not neural-quality measurements. Total application/CPU memory was not measured.

Reproduction tools: tools/models/{prepare_instruments.py,export_instruments.py,compact_instruments.py,webgpu_instruments.py}; see README-instruments.md. A rebuild is not guaranteed byte-identical across exporter/platform/dependency behavior; the app validates the actual shipped SHA.
