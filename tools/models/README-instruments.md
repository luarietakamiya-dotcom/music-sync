# Rebuild the six-head instrument model

Developer conversion tools only. Browser users need neither Python nor PyTorch. This optional model processes the original full mix and supplies learned lead-vocal, back-vocal, piano, guitar, bass and drums estimates. Music Sync separately applies mixture-consistent masks plus remaining-other; it does not mix those replacements with SCNet parent stems.

Fixed sources/checkpoints and SHA256 values are recorded in `manifest-instruments.json`. Keep the supplied MIT LICENSE and the model's NOTICE. The same author grant covers these six targets: https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838 . No new pretrained model is trained by this recipe.

Use an existing Python3.11 installation and a scratch directory outside the checkout. With PowerShell from the repository root:

```powershell
$modelWork = Join-Path (Split-Path (Get-Location) -Parent) 'music-sync-instrument-model-work'
py -3.11 -m venv "$modelWork\venv"
$modelPython = Join-Path $modelWork 'venv\Scripts\python.exe'
& $modelPython -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.9.1+cpu
& $modelPython -m pip install -r tools/models/requirements.txt
& $modelPython tools/models/prepare_instruments.py --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints"
& $modelPython tools/models/export_instruments.py --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints" --output "$modelWork\export\instruments.fp32.onnx" --samples 132096
& $modelPython tools/models/compact_instruments.py --source "$modelWork\export\instruments.fp32.onnx" --output "$modelWork\export\instruments.int8.onnx" --input "$modelWork\export\instruments.fp32.input.f32" --expected "$modelWork\export\instruments.fp32.expected.f32" --waveform "$modelWork\export\instruments.fp32.input-planar.f32" --sources "$modelWork\sources" --checkpoints "$modelWork\checkpoints"
& $modelPython tools/models/webgpu_instruments.py --source "$modelWork\export\instruments.int8.onnx" --source-report "$modelWork\export\instruments.int8.report.json" --output "$modelWork\export\instruments.int8.webgpu.onnx" --input "$modelWork\export\instruments.fp32.input.f32" --expected "$modelWork\export\instruments.int8.output.f32"
```

On other platforms use the venv's `bin/python` with the same script arguments; CPU-wheel availability must be checked for that platform. Scripts do not install software, alter PATH or register Python. If choosing uv independently on Windows, `--no-bin --no-registry` avoids global registration.

Six FP16 checkpoint downloads total about466MB. The intermediate FP32ONNX is about404MB, with additional compact graphs/fixtures and substantial RAM required during conversion. Generated artifacts and environments belong outside Git. No script silently overwrites an existing ONNX file.

Every source/config/checkpoint is hash-verified before use. Checkpoints use `weights_only=True`, strict tensor loading and exact451-tensor shared-trunk comparison/fingerprinting. Export checks native PyTorch, the real-only wrapper and CPUORT. Compaction checks926 quantized matrices against equivalent quantized native PyTorch while separately measuring intentional changes from Float32. The final2Split-to124Slice rewrite preserves all original initializers and requires bitwise-identical CPU output.

This graph has fixed Float32 shapes `mix_spec [1,4,1025,259]` and `stems_spec [1,24,1025,259]`, 44100Hz stereo,132096samples, FFT2048/hop512 periodicHann, centerreflect, normalizedfalse, no input standardization. Its short context is experimental relative to upstream20seconds. Input bus changes are not an assumed substitute for fullmix validation.

The shipped portable graph is104,573,310bytes, SHA256 `071fabf56f73ebf8bae1ff411eecdac2e02039666e82bb5de62dcf1aa3718557`,284290bytes below100MiB. The public filename is `mega53-instruments-071fabf5.int8.onnx`. A rebuild is not guaranteed byte-identical across exporter metadata, platforms or dependency behavior; changing the app's pinned identity requires deliberate review and fresh browser tests.

Conversion parity is not a separation-quality guarantee. Preserve originals and independently test the actual frontend/Worker, CPU and real GPU providers, output/frame/rate identities, cancellation/OPFS cleanup, overlapping windows, mixture reconstruction, project roles and real-song listening before releasing a rebuilt candidate. Runtime remains ORTWeb1.31.1 with one webgpu module entry and matching asyncify assets. Existing frontend/model notices remain required.
