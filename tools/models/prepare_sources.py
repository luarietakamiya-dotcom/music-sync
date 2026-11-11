"""Fetch only pinned MIT sources/checkpoints into explicitly selected directories.

Standard library only. Verifies byte length and SHA256 before adopting each file.
Does not install software, edit PATH/registry, or deserialize model checkpoints.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request


def file_hash(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def fetch_verified(record, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size != record["bytes"] or file_hash(destination) != record["sha256"]:
            raise ValueError("Existing file differs; inspect it before replacing: " + str(destination))
        print("Verified existing " + destination.name, flush=True)
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=destination.name + ".", suffix=".part", dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            size, checksum = 0, hashlib.sha256()
            with urllib.request.urlopen(record["url"], timeout=120) as response:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    size += len(block)
                    if size > record["bytes"]:
                        raise ValueError("Download exceeds pinned size: " + destination.name)
                    checksum.update(block)
                    output.write(block)
            if size != record["bytes"] or checksum.hexdigest() != record["sha256"]:
                raise ValueError("Download checksum mismatch: " + destination.name)
        if destination.exists():
            raise ValueError("Output appeared during download; refusing to overwrite")
        temporary.rename(destination)
        temporary = None
        print("Verified download " + destination.name, flush=True)
    finally:
        # Only the unique temporary file created by this invocation is removed.
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(args):
    manifest = json.loads(Path(__file__).with_name("manifest.json").read_text(encoding="utf-8"))
    for record in manifest["sources"]:
        fetch_verified(record, args.sources.resolve() / record["file"])
    if args.checkpoints:
        for record in manifest["checkpoints"]:
            fetch_verified(record, args.checkpoints.resolve() / (record["target"] + ".ckpt"))
            fetch_verified(record["config"], args.checkpoints.resolve() / (record["target"] + "-config.yaml"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--checkpoints", type=Path, help="Optional: also download five fixed FP16 checkpoints and configs (about 388 MB)")
    run(parser.parse_args())
