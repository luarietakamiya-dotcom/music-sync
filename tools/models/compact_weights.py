"""Store verified constant matrix weights as INT8; keep Float32 arithmetic.

Developer-only transformation. Always measures intentional quantization changes
and compares against the equivalently quantized original PyTorch model.
MIT; Music Sync contributors. Upstream model attribution: see LICENSE and README.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort
import torch
from torch import nn
from export_five import build_verified_model, unpack_five, assert_parity, metric


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def dimensions(value):
    shape = [dimension.dim_value for dimension in value.type.tensor_type.shape.dim]
    if not shape or any(size <= 0 for size in shape):
        raise ValueError("Only fixed positive tensor dimensions are supported")
    return shape


def run(args):
    source, destination = args.source.resolve(), args.output.resolve()
    if source == destination or destination.exists():
        raise ValueError("Choose a new output file; the source is never overwritten")
    if not 1 <= args.threads <= 64:
        raise ValueError("--threads must be between 1 and 64")
    model = onnx.load(str(source), load_external_data=False)
    if any(tensor.data_location == TensorProto.EXTERNAL for tensor in model.graph.initializer):
        raise ValueError("External-data ONNX files are outside this pinned recipe")
    input_shape, output_shape = dimensions(model.graph.input[0]), dimensions(model.graph.output[0])
    if input_shape != [1, 4, 1025, 259] or output_shape != [1, 20, 1025, 259]:
        raise ValueError("Expected the fixed 132096-sample five-head export")
    # Each exported Linear is a right-hand constant MatMul. Refuse unexpected
    # Gemm orientations instead of silently changing the quantization strategy.
    if any(node.op_type == "Gemm" for node in model.graph.node):
        raise ValueError("Unexpected Gemm export; inspect its orientation before extending this recipe")
    eligible = {node.input[1] for node in model.graph.node if node.op_type == "MatMul" and len(node.input) > 1}
    weights, prefix, initializers = [], [], []
    original_bytes, compact_bytes = 0, 0
    for tensor in model.graph.initializer:
        if tensor.name not in eligible or tensor.data_type != TensorProto.FLOAT or len(tensor.dims) != 2 or np.prod(tensor.dims) < 1024:
            initializers.append(tensor)
            continue
        value = numpy_helper.to_array(tensor).astype(np.float32)
        maximum = np.max(np.abs(value), axis=0)
        scales = np.where(maximum > 0, maximum / 127, np.float32(1)).astype(np.float32)
        quantized = np.clip(np.rint(value / scales[None, :]), -127, 127).astype(np.int8)
        names = [tensor.name + ".int8", tensor.name + ".scale", tensor.name + ".float"]
        initializers.extend([numpy_helper.from_array(quantized, names[0]), numpy_helper.from_array(scales[None, :], names[1])])
        # Do not use DequantizeLinear: ORT may fuse it to activation-quantizing
        # MatMulNBits. Cast+Mul restores Float32 weights before Float32 compute.
        prefix.extend([
            helper.make_node("Cast", [names[0]], [names[2]], to=TensorProto.FLOAT, name=tensor.name + ".cast"),
            helper.make_node("Mul", [names[2], names[1]], [tensor.name], name=tensor.name + ".restore"),
        ])
        original_bytes += value.nbytes
        compact_bytes += quantized.nbytes + scales.nbytes
        weights.append({"name": tensor.name, "shape": list(value.shape), "output_axis": 1})
    if len(weights) != 802:
        raise ValueError("Unexpected matrix count; this recipe expects 802 verified matrices")
    del model.graph.initializer[:]
    model.graph.initializer.extend(initializers)
    nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(prefix + nodes)
    model.doc_string += "\nMusic Sync: per-output-channel symmetric INT8 constant weight storage, Float32 compute; no activation quantization."
    onnx.checker.check_model(model)
    destination.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(destination))
    samples = np.fromfile(args.input, dtype="<f4").reshape(input_shape)
    original_spectrum = np.fromfile(args.expected, dtype="<f4").reshape(output_shape)
    audio = np.fromfile(args.waveform, dtype="<f4").reshape(1, 2, 132096)
    if not all(np.isfinite(array).all() for array in [samples, original_spectrum, audio]):
        raise ValueError("Reference fixtures contain a non-finite value")
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    started = time.perf_counter()
    session = ort.InferenceSession(str(destination), sess_options=options, providers=["CPUExecutionProvider"])
    actual = session.run(None, {session.get_inputs()[0].name: samples})[0]
    run_seconds = time.perf_counter() - started
    if not np.isfinite(actual).all():
        raise AssertionError("Compact model output is not finite")
    del session
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    native = build_verified_model(args.sources.resolve(), args.checkpoints.resolve())
    layer_count = 0
    with torch.no_grad():
        for layer in native.modules():
            if isinstance(layer, nn.Linear) and layer.weight.numel() >= 1024:
                weight = layer.weight.detach().numpy()
                maximum = np.max(np.abs(weight), axis=1)
                scale = np.where(maximum > 0, maximum / 127, np.float32(1)).astype(np.float32)
                quantized = np.clip(np.rint(weight / scale[:, None]), -127, 127).astype(np.int8)
                layer.weight.copy_(torch.from_numpy(quantized.astype(np.float32) * scale[:, None]))
                layer_count += 1
        if layer_count != len(weights):
            raise AssertionError("Native and ONNX quantized matrix counts differ")
        expected_quantized = native(torch.from_numpy(audio)).detach()
        window = native.stft_window_fn(device="cpu")
        wave = torch.istft(unpack_five(torch.from_numpy(actual)).flatten(0, 2), **native.stft_kwargs, window=window, length=132096).reshape(1, 5, 2, 132096)
        original_wave = torch.istft(unpack_five(torch.from_numpy(original_spectrum)).flatten(0, 2), **native.stft_kwargs, window=window, length=132096).reshape(1, 5, 2, 132096)
    parity = assert_parity(expected_quantized.numpy(), wave.numpy(), "compact ONNX vs equivalent quantized original PyTorch", 2e-5, 3e-4)
    report = {
        "status": "quantized-native-parity-passed", "source": source.name,
        "source_sha256": digest(source), "output": destination.name,
        "output_sha256": digest(destination), "output_bytes": destination.stat().st_size,
        "quantized_matrices": len(weights), "original_weight_bytes": original_bytes,
        "compact_weight_bytes": compact_bytes, "weight_storage": "int8-per-output-channel",
        "compute": "float32", "activation_quantization": False, "weights": weights,
        "onnx_vs_equivalent_quantized_pytorch": parity,
        "spectral_change_vs_native": metric(original_spectrum, actual),
        "quantization_waveform_change_vs_original": metric(original_wave.numpy(), wave.numpy()),
        "cpu_session_and_run_seconds": run_seconds,
    }
    actual.astype("<f4").tofile(destination.with_suffix(".output.f32"))
    wave.numpy().astype("<f4").tofile(destination.with_suffix(".native-planar.f32"))
    destination.with_suffix(".report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "weights"}, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "output", "input", "expected", "waveform", "sources", "checkpoints"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    run(parser.parse_args())
