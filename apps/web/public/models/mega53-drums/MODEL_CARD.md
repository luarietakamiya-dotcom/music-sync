# Music Sync Mega53 five-head drum-parts model

This is an experimental, commercially usable under MIT, derived ONNX model with five **learned** outputs in this exact order: **kick, snare, hh, toms, percussion**. It shares one verified common BSRoformer trunk. It is a conversion/runtime feasibility artifact, not a claim of production separation quality.

## Artifact

- File: `mega53-drums-2044dee8.int8.onnx`
- Size: 91,762,503 bytes (below 95 MB).
- SHA-256: `2044dee8a8756b92bc92ae14a0069d744bc67457ba3a4f2a592f414a17eaa8b2`
- Matrix storage: per-output-channel symmetric INT8 constants; compute and activations remain Float32. 802 matrices were compacted. This is not an INT8 arithmetic performance claim.
- Final portable graph: two 62-output Split nodes became 124 ordered static Slice nodes. All 2,474 original initializers stayed unchanged. CPU output is bitwise identical to the base compact graph. Concat nodes were left unchanged.

## Host audio / tensor contract

Use 44,100 Hz stereo, exactly **132,096 samples per channel** (2.9954 seconds). Perform periodic-Hann STFT on the host: FFT 2048, hop 512, centered reflection padding, **normalized=false**. Do **not** standardize the input. Output frequency-bin zero is set to zero, matching the upstream model.

- Input `mix_spec`: Float32 `[1,4,1025,259]`; planes are left-real, left-imaginary, right-real, right-imaginary.
- Output `stems_spec`: Float32 `[1,20,1025,259]`; target-major in the order above, then left-real, left-imaginary, right-real, right-imaginary for each target.
- Use the matching host iSTFT and retain exactly 132,096 output samples per channel.

The upstream inference configuration normally uses a 20-second context. This shortened fixed context is experimental; no equivalence of musical quality to 20-second inference is established.

## Sources and exact shared-trunk proof

Checkpoint repository: [noblebarkrr/BS-Roformer-MVSep-Mega-53-stems](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems), fixed revision `0677941f9cdfd891a6bc3336229244e197035327`. Every checkpoint was size/SHA-256 verified before `torch.load(weights_only=True)`. Configuration files were checked against their pinned Git blob identities.

| Target | Bytes | Checkpoint SHA-256 | Pinned source |
| --- | ---: | --- | --- |
| kick | 77,616,219 | `ad914b83f9ef13bedf9608771f4f1a86174e27a84f7f235dc2d1dd91bab85fbc` | [checkpoint](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_kick_mvsep.ckpt) / [config](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_kick_mvsep_config.yaml) |
| snare | 77,616,988 | `c4cde14867f1311836d4aa07649e39df4df43c4ba98780783fe96cd4fe8293bf` | [checkpoint](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_snare_mvsep.ckpt) / [config](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_snare_mvsep_config.yaml) |
| hh | 77,614,809 | `94901a05d358f16b2de4064eec45f0947bb28bf239040a3fe79e2ae7fadd2984` | [checkpoint](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_hh_mvsep.ckpt) / [config](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_hh_mvsep_config.yaml) |
| toms | 77,616,219 | `ceb45bbc16419363bb842484dadcc786a9ca290c4553c9eced0e98dc8f0f2458` | [checkpoint](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_toms_mvsep.ckpt) / [config](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_toms_mvsep_config.yaml) |
| percussion | 77,620,513 | `82187665185d51e6050b4d6afaf45e7acafd85d1eefffd86c47ac0aa601e089f` | [checkpoint](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_percussion_mvsep.ckpt) / [config](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/resolve/0677941f9cdfd891a6bc3336229244e197035327/v1/bs_mega_53stem_percussion_mvsep_config.yaml) |

All **451 non-mask tensors**, containing **26,328,772 parameters**, have identical key sets, shapes, dtypes and `torch.equal` values across all five checkpoints. Their independent raw-byte trunk digest is `d3cc49570f2cf204f056ddb7ea03fbedf29b27ac06b05d1af6b8bd4c26494fcb`. Each distinct trained head contributes 248 tensors / 12,364,808 parameters; the original learned final RMSNorm is retained.

Source code is pinned to [ZFTurbo/Music-Source-Separation-Training commit 1d4b3c431b37de696b3795ed2018493aacba946f](https://github.com/ZFTurbo/Music-Source-Separation-Training/tree/1d4b3c431b37de696b3795ed2018493aacba946f). Native PyTorch full-forward/complex-spectrum checks preceded real-only ONNX export. The full-precision ONNX waveform relative L2 difference was 8.8723e-7.

## Measured behavior and limits

Tests used only a deterministic synthetic musical mixture. There is no real-song SDR or listening-quality benchmark.

- Quantization changed the waveform by **2.8308% relative L2** versus the original full-precision model on this input. It is not lossless. The equivalent quantized PyTorch/ONNX comparison was 5.8163e-7 relative L2.
- Actual native WebGPU execution was observed in Chromium 153 on a **non-fallback NVIDIA/Turing adapter**, with 7,638 compute dispatches over two runs. First exact-input run: **1116.3000 ms**; warm real-frontend run: **470.6000 ms**. Model/session load: 4247.1000 ms. These are short-input device-specific timings, not full-song speed promises.
- With the exact PyTorch input spectrum, WebGPU waveform difference versus equivalent quantized native inference was **1.2601e-6 relative L2**.
- The real browser STFT differed by 1.5001e-7 relative L2 at input, and the resulting waveform differed by **2.0877% relative L2** from the same native reference. This distinct end-to-end frontend result must not be presented as exact native parity. Very quiet individual heads show larger relative errors; see JSON per-head measurements.
- Tracked WASM buffers on the GPU route: **1,032,060,928 bytes**. This excludes GPU allocations, JavaScript heap and OS peak RSS. The separate base-compact one-thread WASM test took 44883.9000 ms and used 2,443,509,760 tracked WASM bytes. Both tests were non-isolated with SharedArrayBuffer unavailable. Memory remains substantial despite the compact download.
- Mobile, real Safari hardware, long-song window transitions and broad device-memory compatibility are unverified. The separate WASM-entry test does not by itself certify fallback from a single WebGPU entry.

These five independent model estimates can overlap; they are five of the upstream 53 targets, not an exhaustive exclusive partition of a drum mix. Preserve unassigned residual separately. A host ratio-mask/mixture-consistent rendering policy is a downstream choice, not part of this model's parity proof. **Do not label that residual cymbals, ride or crash**, and do not claim those learned heads exist here. Always preserve the source recording and allow comparison/undo.

## Runtime assets

Use ONNX Runtime Web **1.31.1**, entry `onnxruntime-web/webgpu`, and the **asyncify** build shown below. The prior jsep pairing failed initialization in this setup. Serve runtime/model files from explicit same-origin paths, run in an external Worker, and use `ort.env.wasm.numThreads=1` / `proxy=false` for the measured non-isolated environment.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| ort.webgpu.min.mjs | 70,742 | `329cd956772397a1aedd668e911195d39afefb182f6fc14aafa4f08ac8d8f379` |
| ort-wasm-simd-threaded.asyncify.mjs | 53,457 | `59cf781530e1a16df2a291d78798e3ec1152467edaec402d6f9599d85047c302` |
| ort-wasm-simd-threaded.asyncify.wasm | 28,747,738 | `ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec` |

Retain the runtime package's [MIT license](https://github.com/microsoft/onnxruntime/blob/v1.31.1/LICENSE) and [third-party notices](https://github.com/microsoft/onnxruntime/blob/v1.31.1/ThirdPartyNotices.txt) if distributing these runtime files.

The same single WebGPU entry plus asyncify asset pair has also executed both explicit WebGPU and WASM provider selections on SCNet: 4187.2000 / 2697.6000 ms for first/warm GPU runs and 19303.0000 ms for one-thread WASM. That supports this runtime packaging recommendation; it is a separate model test, not an automatic-failover or final five-head CPU-unified-entry certification.

## Reproduction outline

Use a dedicated scratch directory and the conversion scripts named in `model-provenance.json`; configure their prototype-root path guards for that scratch directory. Do not point them at an application checkout. Verify the pinned uv archive and all source/model hashes from provenance first. A managed Python installation must avoid global binary/registry registration:

```powershell
.\tools\uv-0.13.7\uv.exe python install 3.11.18 --install-dir .\tools\python --no-bin --no-registry
.\tools\uv-0.13.7\uv.exe venv --python .\tools\python\cpython-3.11-windows-x86_64-none\python.exe .\venv
.\tools\uv-0.13.7\uv.exe pip install --python .\venv\Scripts\python.exe --index-url https://download.pytorch.org/whl/cpu torch==2.9.1
.\tools\uv-0.13.7\uv.exe pip install --python .\venv\Scripts\python.exe numpy==2.4.6 onnx==1.23.2 onnxruntime==1.31.1 einops==0.8.2 beartype==0.23.1 rotary-embedding-torch==0.9.2 packaging PyYAML
node prepare-five.mjs
.\venv\Scripts\python.exe compare-five.py
.\venv\Scripts\python.exe export-five.py --samples 132096
```

Then run `compact-weights.py` with the full-precision model/input/reference files, `measure-compact.py` with the five targets, and `webgpu-portable.py`. The scripts' recorded command-line contracts specify those paths. Repeat native, CPU and actual-browser checks; a build passing alone is insufficient. There is no need to modify global PATH or install an administrator-wide Python.

## License and commercial use

The upstream author released the 53-stem weights under MIT and explicitly confirmed commercial use and conversion in [this owner-authored grant](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838). Preserve the supplied LICENSE and upstream attribution when redistributing derived weights. The author did not provide training-data copyright guarantees or indemnification. This handoff likewise makes no quality, fitness or legal-clearance guarantee. See NOTICE.md and the complete sanitized model-provenance.json.
