"""Replace two wide static Splits with ordered Slices, preserving trained math.

Developer tool, MIT, Music Sync contributors; see LICENSE for upstream attribution.
This does not by itself test a browser or certify WebGPU hardware compatibility.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def run(args):
    source, output = args.source.resolve(), args.output.resolve()
    if source == output or output.exists():
        raise ValueError("Choose a new output file; the source is never overwritten")
    if not 1 <= args.threads <= 64:
        raise ValueError("--threads must be between 1 and 64")
    source_report = json.loads(args.source_report.read_text(encoding="utf-8"))
    if source_report.get("status") != "quantized-native-parity-passed" or digest(source) != source_report.get("output_sha256"):
        raise ValueError("Source must match a successful compact-weight native parity report")
    model = onnx.load(str(source), load_external_data=False)
    if any(tensor.data_location == TensorProto.EXTERNAL for tensor in model.graph.initializer):
        raise ValueError("External-data ONNX is outside this pinned recipe")
    values = {value.name: numpy_helper.to_array(value) for value in model.graph.initializer}
    for node in model.graph.node:
        if node.op_type == "Constant":
            for attribute in node.attribute:
                if attribute.name == "value":
                    values[node.output[0]] = numpy_helper.to_array(attribute.t)
    names = {name for node in model.graph.node for name in [*node.input, *node.output]}
    names.update(value.name for value in model.graph.initializer)
    sequence, integers = 0, {}

    def unique(label):
        nonlocal sequence
        while True:
            sequence += 1
            name = "__webgpu_portable_" + str(sequence) + "_" + label
            if name not in names:
                names.add(name)
                return name

    def constant(numbers):
        if numbers not in integers:
            name = unique("slice_integer")
            model.graph.initializer.append(numpy_helper.from_array(np.array(numbers, dtype=np.int64), name))
            integers[numbers] = name
        return integers[numbers]

    original_initializers = {value.name: hashlib.sha256(value.SerializeToString()).hexdigest() for value in model.graph.initializer}
    replacements, transformed = [], []
    for node in model.graph.node:
        if node.op_type != "Split" or len(node.output) <= 4:
            replacements.append(node)
            continue
        if len(node.input) < 2 or node.input[1] not in values:
            raise ValueError("Wide Split needs explicit constant lengths: " + node.name)
        sizes = np.asarray(values[node.input[1]]).reshape(-1)
        if sizes.size != len(node.output) or not np.issubdtype(sizes.dtype, np.integer) or np.any(sizes < 0):
            raise ValueError("Unclear static Split lengths: " + node.name)
        axis = next((int(helper.get_attribute_value(attribute)) for attribute in node.attribute if attribute.name == "axis"), 0)
        offset = 0
        for size, destination in zip(sizes.tolist(), node.output):
            end = offset + int(size)
            replacements.append(helper.make_node("Slice", [node.input[0], constant((offset,)), constant((end,)), constant((axis,)), constant((1,))], [destination], name=unique("slice")))
            offset = end
        transformed.append({"name": node.name, "axis": axis, "outputs": len(node.output), "lengths": sizes.tolist()})
    if len(transformed) != 2 or sum(row["outputs"] for row in transformed) != 124:
        raise ValueError("Expected exactly two 62-output Splits in the verified compact graph")
    model.graph.ClearField("node")
    model.graph.node.extend(replacements)
    after = {value.name: hashlib.sha256(value.SerializeToString()).hexdigest() for value in model.graph.initializer}
    if any(after[name] != checksum for name, checksum in original_initializers.items()):
        raise AssertionError("An original initializer changed")
    onnx.checker.check_model(model)
    output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(output))
    if output.stat().st_size >= 95000000:
        raise ValueError("Portable graph exceeds 95,000,000 bytes")
    input_shape = [dimension.dim_value for dimension in model.graph.input[0].type.tensor_type.shape.dim]
    output_shape = [dimension.dim_value for dimension in model.graph.output[0].type.tensor_type.shape.dim]
    if input_shape != [1, 4, 1025, 259] or output_shape != [1, 20, 1025, 259]:
        raise ValueError("Unexpected five-head graph dimensions")
    samples = np.fromfile(args.input, dtype="<f4").reshape(input_shape)
    expected = np.fromfile(args.expected, dtype="<f4").reshape(output_shape)
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    actual = session.run(None, {session.get_inputs()[0].name: samples})[0]
    if not np.isfinite(actual).all() or not np.array_equal(actual, expected):
        raise AssertionError("Slice-only rewrite must produce bitwise-identical CPU output")
    report = {
        "status": "cpu-bitwise-parity-passed", "source": source.name, "source_sha256": digest(source),
        "output": output.name, "bytes": output.stat().st_size, "sha256": digest(output),
        "transformations": transformed, "original_initializers_unchanged": True,
        "original_initializer_count": len(original_initializers), "cpu_bitwise_equal": True,
        "input_shape": input_shape, "output_shape": output_shape,
        "webgpu_validation": "Not performed by this graph rewrite; run actual browser inference separately",
    }
    output.with_suffix(".report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "source-report", "output", "input", "expected"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    run(parser.parse_args())
