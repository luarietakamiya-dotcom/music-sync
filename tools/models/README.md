# Rebuild the experimental five-head drum model

These are **developer-only** conversion tools. Music Sync Web users do not need Python, PyTorch, an account or a paid service. The application ships a pinned, verified ONNX file and runs it locally in the browser.

The recipe assembles the existing Mega53 **kick, snare, hh, toms and percussion** heads around their byte-identical shared BSRoformer trunk, exports real-only complex-as-channel spectra, compacts constant weights and replaces two wide Split operations with ordered Slices. It does not train a new model or add a learned cymbal/ride/crash head. The application separately derives stereo-linked mixture masks and retains an unassigned remainder; those host operations are not embedded in this graph.

All input/output locations are explicit CLI arguments. Use a scratch directory outside your checkout; generated weights, environments and test outputs do not belong in Git. These scripts do not install Python, edit PATH or change the registry.

## Pinned inputs and license

- Training/model implementation: [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training/tree/1d4b3c431b37de696b3795ed2018493aacba946f), revision `1d4b3c431b37de696b3795ed2018493aacba946f`.
- Reduced checkpoints: [noblebarkrr/BS-Roformer-MVSep-Mega-53-stems](https://huggingface.co/noblebarkrr/BS-Roformer-MVSep-Mega-53-stems/tree/0677941f9cdfd891a6bc3336229244e197035327), revision `0677941f9cdfd891a6bc3336229244e197035327`.
- Source and weights are used under MIT. The author's [explicit 53-stem weight grant](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838) covers commercial use and conversion; it does not provide training-data clearance or indemnification. Preserve [LICENSE](./LICENSE) and attribution when redistributing derived weights.
- [manifest.json](./manifest.json) records every pinned source/config/checkpoint URL, byte length and SHA256, plus the shipped artifact identity. Source code is downloaded into your chosen directory rather than copied wholesale into this repository.

`prepare_sources.py` downloads and verifies the pinned files. Alternatively, put the exact files there yourself; existing files are verified and never silently replaced. Expected layout:

```text
<scratch>/sources/bs_roformer.py
<scratch>/sources/attend.py
<scratch>/sources/LICENSE
<scratch>/checkpoints/{kick,snare,hh,toms,percussion}.ckpt
<scratch>/checkpoints/{kick,snare,hh,toms,percussion}-config.yaml
```

Five checkpoint downloads total about 388 MB. Full-precision ONNX is about 354 MB; compact and portable ONNX files are each about 92 MB. Conversion also uses substantial RAM and temporary arrays. A GPU is not required for the conversion/parity steps; their measurements use CPU PyTorch and CPU ONNX Runtime.

## Isolated Python environment

The original validation used Python 3.11.18 and the versions in [requirements.txt](./requirements.txt). Select an existing Python 3.11 installation. From the repository root on Windows PowerShell:

```powershell
$modelWork = Join-Path (Split-Path (Get-Location) -Parent) 'music-sync-model-work'
py -3.11 -m venv "$modelWork\venv"
$modelPython = Join-Path $modelWork 'venv\Scripts\python.exe'
& $modelPython -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.9.1+cpu
& $modelPython -m pip install -r tools/models/requirements.txt
```

On macOS/Linux, create the venv with `python3.11 -m venv ../music-sync-model-work/venv` and use its `bin/python` with the same pip/script arguments. CPU wheel availability depends on platform; this recipe was validated on Windows x64. No automatic installer is included. If you independently choose a managed-Python tool such as uv, use `--no-bin --no-registry` on Windows to avoid global registration.

## Conversion and mandatory parity gates

From the same PowerShell session, download only pinned resources:

```powershell
& $modelPython tools/models/prepare_sources.py --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints"
```

Export the original five-head computation and compare native PyTorch, the real-only wrapper and CPU ONNX Runtime on generated synthetic audio:

```powershell
& $modelPython tools/models/export_five.py --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints" --output "$modelWork\export\five.fp32.onnx" --samples 132096
```

Before importing pinned model source or reading YAML/checkpoints, the exporter verifies source/config/checkpoint hashes. Checkpoints use `torch.load(weights_only=True)` with no unsafe fallback. All 451 shared non-mask tensors must match exactly in keys, shape, dtype and value, and their raw-byte digest must match the recorded trunk. Distinct trained heads are mapped in the order above, with strict state-dict loading. Learned final RMSNorm, gated rotary attention, mask MLP/GLU and zero-DC behavior are retained.

The exporter writes the ONNX file, a report and raw Float32 diagnostic fixtures beside it: `.input.f32`, `.expected.f32`, `.input-planar.f32` and `.native-planar.f32`. These are generated test signals, not source recordings. Every conversion step retains its parity gates.

Compact constant matrix weights while keeping activations and computation Float32, then compare against the equivalently quantized original PyTorch model:

```powershell
& $modelPython tools/models/compact_weights.py --source "$modelWork\export\five.fp32.onnx" --output "$modelWork\export\five.int8.onnx" --input "$modelWork\export\five.fp32.input.f32" --expected "$modelWork\export\five.fp32.expected.f32" --waveform "$modelWork\export\five.fp32.input-planar.f32" --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints"
```

This stores 802 constant matrices as symmetric per-output-channel INT8, restored with `Cast` + `Mul` before Float32 arithmetic. It deliberately avoids `DequantizeLinear` fusion into activation-quantizing `MatMulNBits`. It records the intentional difference from the original float model as well as requiring equivalent-quantized-native parity. It writes `.output.f32`, `.native-planar.f32` and `.report.json`. Compact storage is not lossless and is not a claim of INT8 arithmetic speed.

Finally, make the graph portable to ORT's native WebGPU Split storage-buffer limit:

```powershell
& $modelPython tools/models/webgpu_portable.py --source "$modelWork\export\five.int8.onnx" --source-report "$modelWork\export\five.int8.report.json" --output "$modelWork\export\five.int8.webgpu.onnx" --input "$modelWork\export\five.fp32.input.f32" --expected "$modelWork\export\five.int8.output.f32"
```

The rewrite requires a successful matching compact report, replaces exactly two 62-output Splits with 124 static Slices, checks every original initializer remains unchanged and requires **bitwise-identical CPU output** to the compact graph. Concat operations remain unchanged. It refuses an output at or above 95,000,000 bytes. Each transformation refuses to overwrite an existing ONNX model; choose a fresh scratch directory or inspect/remove only your previous generated outputs yourself.

## Artifact identity and browser validation

The shipped graph is 91,762,503 bytes with SHA256:

```text
2044dee8a8756b92bc92ae14a0069d744bc67457ba3a4f2a592f414a17eaa8b2
```

These public scripts preserve the conversion strategy and verification gates. **A rebuild is not guaranteed to be byte-identical**, even across identical package version labels: exporter metadata, protobuf serialization, platform arithmetic and dependency behavior can affect output. The app verifies the actual shipped SHA256. Rebuilt candidates require deliberate provenance review, configuration updates and fresh browser tests; a local rebuild does not silently replace the shipped model.

The fixed graph accepts 44.1 kHz stereo, 132,096 samples (about 2.9954 seconds), periodic-Hann STFT FFT 2048 / hop 512, centered reflect padding, unnormalized spectra and no input standardization. Tensor names/shapes are `mix_spec [1,4,1025,259]` and `stems_spec [1,20,1025,259]`, target-major with each target's left-real, left-imaginary, right-real and right-imaginary planes. The normal upstream context is 20 seconds; the shortened context is experimental.

CPU parity does not prove browser operation or separation quality. Before releasing any rebuilt candidate, test the app's actual Worker/frontend, all target orders, real model loading with size/SHA verification, CPU and real WebGPU providers, cancellation, bounded overlap windows, immutable input, finite outputs, output lengths and mixture reconstruction. With ORT Web 1.31.1, use one `onnxruntime-web/webgpu` entry and matching `ort-wasm-simd-threaded.asyncify.mjs/.wasm` assets; other runtime variants must be revalidated. Keep ORT's MIT license and ThirdPartyNotices when distributing its runtime.

The original artifact's synthetic-input validation found about 2.83% relative waveform change from weight compaction. Tiny browser/PyTorch STFT rounding also changed outputs by about 2.09% on that example. These are measured numerical differences, not perceptual-quality scores. No real-song quality, native-20-second-context equivalence, device-memory portability or commercial fitness guarantee follows from this recipe.
