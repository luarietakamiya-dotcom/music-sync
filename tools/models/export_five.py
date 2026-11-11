"""Reproduce the MIT Mega53 five-head host-STFT FP32 ONNX model.

Inputs are explicitly supplied pinned upstream source/checkpoint directories.
Only deterministic generated audio is used; no installer or user audio is run.
"""
from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Mapping
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import time
import types

sys.dont_write_bytecode = True
import numpy as np
import torch
from torch import nn
import yaml


class ConfigLoader(yaml.SafeLoader):
    """Permit only the inert tuple syntax used by the upstream configuration."""


ConfigLoader.add_constructor(
    "tag:yaml.org,2002:python/tuple",
    lambda loader, node: tuple(loader.construct_sequence(node)),
)

TARGETS = ("kick", "snare", "hh", "toms", "percussion")
SOURCE_REPOSITORY = "https://github.com/ZFTurbo/Music-Source-Separation-Training"
SOURCE_REVISION = "1d4b3c431b37de696b3795ed2018493aacba946f"
CHECKPOINT_REPOSITORY = "noblebarkrr/BS-Roformer-MVSep-Mega-53-stems"
CHECKPOINT_REVISION = "0677941f9cdfd891a6bc3336229244e197035327"
LICENSE_GRANT = SOURCE_REPOSITORY + "/issues/245#issuecomment-5834608838"
PINNED_SOURCES = {
    "bs_roformer.py": "a6f670325cdb8a7a212914f62602119b23eb888df9bcfe4a85f9be74728b3ef4",
    "attend.py": "c7abbc40a3fd20ff7f6001fa9f8ee9ad5df6452272712a5e719b8f8468bf2223",
    "LICENSE": "3282dc057695ef5b9a64909a7092ca40b2c292c232580fc6ace6e5d665cc0207",
}
PINNED_MODELS = {
    "kick": {"checkpoint": "ad914b83f9ef13bedf9608771f4f1a86174e27a84f7f235dc2d1dd91bab85fbc", "config": "e234de6e1fd66a2c359bd5fb5d4bb815125e1d6408ee4df581ca297f6f17ff14"},
    "snare": {"checkpoint": "c4cde14867f1311836d4aa07649e39df4df43c4ba98780783fe96cd4fe8293bf", "config": "605debf3206fcdc34046e6de72bdf7c66014a0fd400dd8908df3b89774146db9"},
    "hh": {"checkpoint": "94901a05d358f16b2de4064eec45f0947bb28bf239040a3fe79e2ae7fadd2984", "config": "d6d712604e80060938c23c38da202d768d29d4d37a3ec4f2459706cbf15193ca"},
    "toms": {"checkpoint": "ceb45bbc16419363bb842484dadcc786a9ca290c4553c9eced0e98dc8f0f2458", "config": "174f4a1307d96e6a7167ed441eadd4625f877f766da10ef70aba5e7cbcf40786"},
    "percussion": {"checkpoint": "82187665185d51e6050b4d6afaf45e7acafd85d1eefffd86c47ac0aa601e089f", "config": "583bfe3cfae1db6a8e38205aa61d12f7c96df99c0f8568a69b9a9eb9dc715838"},
}
TRUNK_SHA256 = "d3cc49570f2cf204f056ddb7ea03fbedf29b27ac06b05d1af6b8bd4c26494fcb"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def state_dict_from_checkpoint(path: Path) -> dict[str, torch.Tensor]:
    # Explicitly forbid ordinary pickle loading or custom allowlists.
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    state = checkpoint
    for key in ("state_dict", "model_state_dict", "model"):
        if isinstance(state, Mapping) and key in state and isinstance(state[key], Mapping):
            state = state[key]
            break
    if not isinstance(state, Mapping) or not state:
        raise TypeError("Checkpoint does not contain a tensor state_dict")
    if not all(isinstance(key, str) and isinstance(value, torch.Tensor) for key, value in state.items()):
        raise TypeError("State dictionary contains non-tensor entries; refusing unsafe fallback")
    state = dict(state)
    # Only uniform training wrappers can be removed. Never hide missing weights.
    for prefix in ("module.", "_orig_mod.", "model."):
        if all(key.startswith(prefix) for key in state):
            state = {key[len(prefix):]: value for key, value in state.items()}
    return state


class PortableAttention(nn.Module):
    """The upstream gated rotary attention, with elementary ONNX operations."""

    def __init__(self, upstream, length: int):
        super().__init__()
        if upstream.pope_embed is not None:
            raise ValueError("PoPE is outside this fixed-context five-head recipe")
        self.heads = upstream.heads
        self.dim_head = upstream.to_qkv.out_features // (3 * self.heads)
        self.scale = upstream.attend.scale
        if self.scale is None:
            self.scale = self.dim_head ** -0.5
        self.norm = upstream.norm
        self.to_qkv = upstream.to_qkv
        self.to_gates = upstream.to_gates
        self.to_out = upstream.to_out
        self.length = length
        # Derive the exact loaded library's RoPE from a unit basis. This avoids
        # guessing theta, position scaling, pair order, or library cache details.
        basis = torch.zeros(1, 1, length, self.dim_head, dtype=torch.float32)
        basis[..., 0::2] = 1.0
        with torch.no_grad():
            if upstream.rotary_embed is None:
                cosine, sine = torch.ones_like(basis), torch.zeros_like(basis)
            else:
                rotated = upstream.rotary_embed.rotate_queries_or_keys(basis)
                cosine = rotated[..., 0::2].repeat_interleave(2, dim=-1)
                sine = rotated[..., 1::2].repeat_interleave(2, dim=-1)
        self.register_buffer("cosine", cosine.contiguous())
        self.register_buffer("sine", sine.contiguous())

    @staticmethod
    def rotate_half(value):
        pairs = value.reshape(*value.shape[:-1], value.shape[-1] // 2, 2)
        return torch.stack((-pairs[..., 1], pairs[..., 0]), dim=-1).flatten(-2)

    def forward(self, value):
        value = self.norm(value)
        batch, length, _ = value.shape
        qkv = self.to_qkv(value).reshape(batch, length, 3, self.heads, self.dim_head)
        qkv = qkv.permute(2, 0, 3, 1, 4)
        query, key, val = qkv[0], qkv[1], qkv[2]
        query = query * self.cosine + self.rotate_half(query) * self.sine
        key = key * self.cosine + self.rotate_half(key) * self.sine
        weights = torch.softmax(torch.matmul(query, key.transpose(-1, -2)) * self.scale, dim=-1)
        output = torch.matmul(weights, val)
        gates = torch.sigmoid(self.to_gates(value).transpose(1, 2).unsqueeze(-1))
        output = (output * gates).transpose(1, 2).reshape(batch, length, self.heads * self.dim_head)
        return self.to_out(output)


class PortableTransformer(nn.Module):
    def __init__(self, upstream, length: int):
        super().__init__()
        self.layers = nn.ModuleList([
            nn.ModuleList([PortableAttention(attention, length), feed_forward])
            for attention, feed_forward in upstream.layers
        ])
        self.norm = upstream.norm

    def forward(self, value):
        for attention, feed_forward in self.layers:
            value = value + attention(value)
            value = value + feed_forward(value)
        return self.norm(value)


def pack_complex(value):
    return torch.stack((value.real, value.imag), dim=2).flatten(1, 2)


def metric(reference, candidate):
    reference = np.asarray(reference, dtype=np.float64)
    candidate = np.asarray(candidate, dtype=np.float64)
    error = candidate - reference
    return {"max_abs": float(np.max(np.abs(error))), "rmse": float(np.sqrt(np.mean(error ** 2))),
            "relative_l2": float(np.linalg.norm(error.ravel()) / max(np.linalg.norm(reference.ravel()), 1e-15)),
            "finite": bool(np.isfinite(candidate).all())}


def generated_music(samples: int, sample_rate: int):
    time_axis = np.arange(samples, dtype=np.float64) / sample_rate
    beat = np.remainder(time_axis, .5)
    rng = np.random.default_rng(1703)
    kick = .10 * np.sin(2 * np.pi * 65 * time_axis) * np.exp(-beat * 25)
    bass = .045 * np.sin(2 * np.pi * 110 * time_axis) * (.7 + .3 * np.cos(2 * np.pi * time_axis))
    hat = .008 * rng.standard_normal(samples) * np.exp(-np.remainder(time_axis, .25) * 90)
    notes = .025 * np.sin(2 * np.pi * 440 * time_axis) + .02 * np.sin(2 * np.pi * 659.255 * time_axis)
    return torch.from_numpy(np.stack((kick + bass + hat + notes, kick + bass + .7 * hat + .8 * notes)).astype(np.float32))[None]


def save_float_wav(path: Path, channels, sample_rate: int):
    channels = np.asarray(channels, dtype=np.float32)
    count, samples = channels.shape
    interleaved = np.ascontiguousarray(channels.T, dtype="<f4").tobytes()
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(interleaved), b"WAVE", b"fmt ", 16,
                         3, count, sample_rate, sample_rate * count * 4, count * 4, 32, b"data", len(interleaved))
    path.write_bytes(header + interleaved)


class CombinedRealGraph(nn.Module):
    """CaC in [B,4,F,T], five CaC heads out [B,20,F,T]."""

    def __init__(self, model, frames, bins):
        super().__init__()
        if model.audio_channels != 2 or model.num_stems != 5 or model.skip_connection:
            raise ValueError("Unexpected five-stem architecture")
        if any(len(layer) != 2 for layer in model.layers):
            raise ValueError("Linear transformer is outside this verified configuration")
        self.channels, self.frames, self.bins = 2, frames, bins
        self.bands, self.dim = len(model.band_split.dim_inputs), model.final_norm.gamma.numel()
        self.band_split, self.final_norm = model.band_split, model.final_norm
        self.mask_estimators = model.mask_estimators
        self.layers = nn.ModuleList([
            nn.ModuleList([PortableTransformer(time_layer, frames), PortableTransformer(freq_layer, self.bands)])
            for time_layer, freq_layer in model.layers
        ])
        dc = torch.ones(1, 1, bins, 1)
        if model.zero_dc:
            dc[:, :, 0, :] = 0
        self.register_buffer("dc", dc)

    def forward(self, mix_spec):
        batch = mix_spec.shape[0]
        original = mix_spec.reshape(batch, self.channels, 2, self.bins, self.frames)
        value = original.permute(0, 4, 3, 1, 2).reshape(batch, self.frames, self.bins * self.channels * 2)
        value = self.band_split(value)
        for time_layer, freq_layer in self.layers:
            value = value.permute(0, 2, 1, 3).reshape(batch * self.bands, self.frames, self.dim)
            value = time_layer(value)
            value = value.reshape(batch, self.bands, self.frames, self.dim).permute(0, 2, 1, 3)
            value = freq_layer(value.reshape(batch * self.frames, self.bands, self.dim))
            value = value.reshape(batch, self.frames, self.bands, self.dim)
        value = self.final_norm(value)
        outputs = []
        for estimator in self.mask_estimators:
            mask = estimator(value).reshape(batch, self.frames, self.bins, self.channels, 2).permute(0, 3, 4, 2, 1)
            real = original[:, :, 0] * mask[:, :, 0] - original[:, :, 1] * mask[:, :, 1]
            imaginary = original[:, :, 0] * mask[:, :, 1] + original[:, :, 1] * mask[:, :, 0]
            packed = torch.stack((real * self.dc, imaginary * self.dc), dim=2)
            outputs.append(packed.reshape(batch, self.channels * 2, self.bins, self.frames))
        return torch.cat(outputs, dim=1)


def unpack_five(spectrum):
    batch, _planes, bins, frames = spectrum.shape
    paired = spectrum.reshape(batch, 5, 2, 2, bins, frames)
    return torch.complex(paired[:, :, :, 0], paired[:, :, :, 1])


def assert_parity(expected, actual, label, atol=2e-5, rtol=3e-4):
    """Check finite values, global relative L2 and elementwise numeric parity."""
    result = metric(expected, actual)
    if not result["finite"] or result["relative_l2"] > rtol:
        raise AssertionError(f"{label} relative parity failed: {result}")
    np.testing.assert_allclose(actual, expected, atol=atol, rtol=rtol, err_msg=label)
    return result


def tensor_fingerprint(state):
    digest = hashlib.sha256()
    for name in sorted(state):
        value = state[name].detach().cpu().contiguous()
        digest.update(name.encode() + b"\0" + str(value.dtype).encode() + b"\0")
        digest.update(json.dumps(list(value.shape)).encode() + b"\0")
        digest.update(value.view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def _load_verified_source(sources):
    """Import only the three SHA-verified flat files supplied by the caller."""
    for name, expected in PINNED_SOURCES.items():
        path = sources / name
        if not path.is_file() or sha256(path) != expected:
            raise ValueError(f"Pinned upstream source identity mismatch: {name}")
    for name in ("models", "models.bs_roformer"):
        package = types.ModuleType(name)
        package.__path__ = [str(sources)]
        sys.modules[name] = package
    for name in ("attend", "bs_roformer"):
        qualified = "models.bs_roformer." + name
        spec = importlib.util.spec_from_file_location(qualified, sources / (name + ".py"))
        if spec is None or spec.loader is None:
            raise RuntimeError("Cannot import verified upstream source")
        module = importlib.util.module_from_spec(spec)
        sys.modules[qualified] = module
        spec.loader.exec_module(module)
    return sys.modules["models.bs_roformer.bs_roformer"].BSRoformer


def build_verified_model(sources: Path, checkpoints: Path):
    """Return the native five-head model after every identity and trunk gate.

    Layout: sources/{bs_roformer.py,attend.py,LICENSE}, and
    checkpoints/{target}.ckpt plus {target}-config.yaml. There are no downloads,
    installers, global registrations or caller-audio reads in this function.
    """
    sources, checkpoints = Path(sources).resolve(), Path(checkpoints).resolve()
    # Verify all checkpoint/config bytes before parsing YAML or deserializing weights.
    for target in TARGETS:
        identities = PINNED_MODELS[target]
        for filename, key in ((target + ".ckpt", "checkpoint"), (target + "-config.yaml", "config")):
            path = checkpoints / filename
            if not path.is_file() or sha256(path) != identities[key]:
                raise ValueError(f"Pinned model/config identity mismatch: {filename}")
    model_class = _load_verified_source(sources)
    base_config = None
    base_trunk = None
    combined = {}
    comparisons = []
    for index, target in enumerate(TARGETS):
        config = yaml.load((checkpoints / (target + "-config.yaml")).read_text(encoding="utf-8"), Loader=ConfigLoader)
        if config["training"]["target_instrument"] != target:
            raise ValueError("Configuration target does not match its learned head")
        if base_config is None:
            base_config = dict(config["model"])
        elif config["model"] != base_config:
            raise ValueError("Model architectures differ; cannot share a trunk")
        state = state_dict_from_checkpoint(checkpoints / (target + ".ckpt"))
        trunk = {name: value for name, value in state.items() if not name.startswith("mask_estimators.")}
        head = {name: value for name, value in state.items() if name.startswith("mask_estimators.")}
        if len(trunk) != 451 or len(head) != 248 or any(not name.startswith("mask_estimators.0.") for name in head):
            raise ValueError("Unexpected reduced checkpoint architecture")
        if base_trunk is None:
            base_trunk = trunk
            combined.update(trunk)
        if set(trunk) != set(base_trunk) or any(
            trunk[name].shape != base_trunk[name].shape or trunk[name].dtype != base_trunk[name].dtype
            or not torch.equal(trunk[name], base_trunk[name]) for name in trunk
        ):
            raise ValueError("A non-mask tensor differs; refusing a falsely shared model")
        trunk_hash = tensor_fingerprint(trunk)
        if trunk_hash != TRUNK_SHA256:
            raise ValueError("Shared trunk raw-byte fingerprint differs from the verified model")
        for name, value in head.items():
            combined["mask_estimators." + str(index) + "." + name[len("mask_estimators.0."):]] = value
        comparisons.append({"target": target, "head_index": index, "trunk_tensor_count": len(trunk),
                            "head_tensor_count": len(head), "all_non_mask_tensors_torch_equal": True,
                            "trunk_sha256": trunk_hash, "head_sha256": tensor_fingerprint(head),
                            "checkpoint_sha256": PINNED_MODELS[target]["checkpoint"], "config_sha256": PINNED_MODELS[target]["config"],
                            "checkpoint_url": f"https://huggingface.co/{CHECKPOINT_REPOSITORY}/resolve/{CHECKPOINT_REVISION}/v1/bs_mega_53stem_{target}_mvsep.ckpt",
                            "config_url": f"https://huggingface.co/{CHECKPOINT_REPOSITORY}/resolve/{CHECKPOINT_REVISION}/v1/bs_mega_53stem_{target}_mvsep_config.yaml"})
        del state, trunk, head
    if base_config["num_stems"] != 1 or base_config["stft_n_fft"] != 2048 or base_config["stft_hop_length"] != 512:
        raise ValueError("Unexpected native model contract")
    model_config = dict(base_config)
    model_config["num_stems"] = 5
    model = model_class(**model_config).float().eval()
    model.load_state_dict(combined, strict=True)
    model.export_provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_revision": SOURCE_REVISION,
        "source_sha256": PINNED_SOURCES, "checkpoint_repository": CHECKPOINT_REPOSITORY,
        "checkpoint_revision": CHECKPOINT_REVISION, "license": "MIT", "license_grant": LICENSE_GRANT,
        "targets": list(TARGETS), "shared_trunk_sha256": TRUNK_SHA256, "comparisons": comparisons,
    }
    return model


def run(args):
    started = time.perf_counter()
    if args.samples < 2048 or args.samples > 5 * 44100 or args.threads < 1 or args.threads > 32:
        raise ValueError("Prototype context must be 2048 samples through five seconds; threads must be 1–32")
    output = args.output.resolve()
    if output.suffix.lower() != ".onnx":
        raise ValueError("--output must explicitly name an ONNX file")
    if output.exists():
        raise ValueError("Choose a new output file; source/output is never silently overwritten")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    model = build_verified_model(args.sources, args.checkpoints)
    audio = generated_music(args.samples, 44100)
    original = audio.clone()
    window = model.stft_window_fn(device="cpu")
    print(json.dumps({"stage": "native-forward", "targets": TARGETS, "samples": args.samples}), flush=True)
    with torch.no_grad():
        complex_mix = torch.stft(audio.flatten(0, 1), **model.stft_kwargs, window=window, return_complex=True)
        complex_mix = complex_mix.reshape(1, 2, *complex_mix.shape[-2:])
        mix_spec = pack_complex(complex_mix).contiguous()
        bins, frames = mix_spec.shape[-2:]
        captured = {}
        hooks = [estimator.register_forward_hook(
            lambda _module, _inputs, result, index=index: captured.update({index: result.detach()}))
            for index, estimator in enumerate(model.mask_estimators)]
        at = time.perf_counter()
        native_wave = model(audio)
        native_seconds = time.perf_counter() - at
        for hook in hooks:
            hook.remove()
        native_parts = []
        for index in range(5):
            mask = captured[index].reshape(1, frames, bins, 2, 2).permute(0, 3, 2, 1, 4).contiguous()
            estimate = complex_mix * torch.view_as_complex(mask)
            if model.zero_dc:
                estimate[:, :, 0, :] = 0
            native_parts.append(pack_complex(estimate))
        native_spec = torch.cat(native_parts, dim=1).contiguous()
        wrapper = CombinedRealGraph(model, frames, bins).eval()
        at = time.perf_counter()
        portable_spec = wrapper(mix_spec)
        portable_seconds = time.perf_counter() - at
        portable_wave = torch.istft(unpack_five(portable_spec).flatten(0, 2), **model.stft_kwargs, window=window,
                                    length=args.samples).reshape(1, 5, 2, args.samples)
    if not torch.equal(audio, original):
        raise AssertionError("Original generated source was modified")
    report = {"status": "pytorch-parity-passed", "targets": list(TARGETS), "samples": args.samples, "sample_rate": 44100,
              "input_name": "mix_spec", "output_name": "stems_spec", "input_shape": list(mix_spec.shape), "output_shape": list(native_spec.shape),
              "stft": {"n": 2048, "hop": 512, "window": "hann-periodic", "normalized": False, "center": True,
                       "pad_mode": "reflect", "zero_dc": bool(model.zero_dc)}, "standardize": False,
              "torch_version": torch.__version__, "provenance": model.export_provenance,
              "native_forward_seconds": native_seconds, "portable_forward_seconds": portable_seconds,
              "pytorch_spectral_parity": assert_parity(native_spec.numpy(), portable_spec.numpy(), "native complex vs real graph", args.atol, args.rtol),
              "pytorch_waveform_parity": assert_parity(native_wave.numpy(), portable_wave.numpy(), "native full forward vs real graph/iSTFT", args.atol, args.rtol),
              "per_head_pytorch_parity": {target: assert_parity(native_wave[:, index].numpy(), portable_wave[:, index].numpy(), target, args.atol, args.rtol)
                                          for index, target in enumerate(TARGETS)}, "original_unchanged": True,
              "context_note": "Short fixed context for numerical/runtime reproduction; no semantic or upstream twenty-second-context quality claim"}
    output.parent.mkdir(parents=True, exist_ok=True)
    mix_spec.numpy().astype("<f4").tofile(output.with_suffix(".input.f32"))
    native_spec.numpy().astype("<f4").tofile(output.with_suffix(".expected.f32"))
    audio.numpy().astype("<f4").tofile(output.with_suffix(".input-planar.f32"))
    native_wave.numpy().astype("<f4").tofile(output.with_suffix(".native-planar.f32"))
    save_float_wav(output.with_suffix(".input.wav"), audio[0].numpy(), 44100)
    for index, target in enumerate(TARGETS):
        save_float_wav(output.with_suffix("." + target + "-pytorch.wav"), native_wave[0, index].numpy(), 44100)
    output.with_suffix(".contract.json").write_text(json.dumps({key: report[key] for key in
        ("targets", "samples", "sample_rate", "input_name", "output_name", "input_shape", "output_shape", "stft", "standardize")}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"stage": "onnx-export", "pytorch_waveform_parity": report["pytorch_waveform_parity"]}), flush=True)
    at = time.perf_counter()
    torch.onnx.export(wrapper, (mix_spec,), str(output), export_params=True, opset_version=17,
                      do_constant_folding=True, input_names=["mix_spec"], output_names=["stems_spec"],
                      keep_initializers_as_inputs=False, dynamo=False)
    report["export_seconds"] = time.perf_counter() - at
    import onnx
    onnx.checker.check_model(str(output))
    graph = onnx.load(str(output))
    operators = Counter(node.op_type for node in graph.graph.node)
    if {"STFT", "DFT", "ATen", "PythonOp", "ScaledDotProductAttention"}.intersection(operators) or any(
        value.data_type in (onnx.TensorProto.COMPLEX64, onnx.TensorProto.COMPLEX128) for value in graph.graph.initializer
    ):
        raise AssertionError("Unsupported complex or nonportable operation entered the graph")
    report.update(onnx_file=output.name, onnx_bytes=output.stat().st_size, onnx_sha256=sha256(output), onnx_operators=dict(operators))
    del graph
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    at = time.perf_counter()
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    report["ort_load_seconds"] = time.perf_counter() - at
    at = time.perf_counter()
    actual = session.run(["stems_spec"], {"mix_spec": mix_spec.numpy()})[0]
    report["ort_run_seconds"] = time.perf_counter() - at
    report["onnx_spectral_parity"] = assert_parity(native_spec.numpy(), actual, "ONNX vs native complex graph", args.atol, args.rtol)
    actual_wave = torch.istft(unpack_five(torch.from_numpy(actual)).flatten(0, 2), **model.stft_kwargs, window=window,
                             length=args.samples).reshape(1, 5, 2, args.samples)
    report["onnx_waveform_parity"] = assert_parity(native_wave.numpy(), actual_wave.numpy(), "ONNX/iSTFT vs native full forward", args.atol, args.rtol)
    report["per_head_onnx_parity"] = {}
    for index, target in enumerate(TARGETS):
        report["per_head_onnx_parity"][target] = assert_parity(native_wave[:, index].numpy(), actual_wave[:, index].numpy(), target + " ONNX", args.atol, args.rtol)
        save_float_wav(output.with_suffix("." + target + "-onnx.wav"), actual_wave[0, index].numpy(), 44100)
    report["status"] = "onnx-parity-passed"
    report["total_seconds"] = time.perf_counter() - started
    output.with_suffix(".report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True, help="Pinned bs_roformer.py, attend.py and LICENSE directory")
    parser.add_argument("--checkpoints", type=Path, required=True, help="Verified target.ckpt and target-config.yaml directory")
    parser.add_argument("--output", type=Path, required=True, help="Explicit FP32 ONNX output filename")
    parser.add_argument("--samples", type=int, default=132096, help="Generated fixture samples per channel; default gives T=259")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--atol", type=float, default=2e-5)
    parser.add_argument("--rtol", type=float, default=3e-4)
    run(parser.parse_args())
