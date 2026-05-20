#!/usr/bin/env python3
"""Dispatch clean-room hook checks behind safe opt-in enforcement."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


TRUTHY = {"1", "true", "yes", "on", "strict"}
CLEAN_ROOM_ENV_NAMES = {
    "CLEAN_ROOM_ROLE",
    "CLEAN_ROOM_SOURCE_ROOTS",
    "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
    "CLEAN_ROOM_CLEAN_ROOTS",
    "CLEAN_ROOM_SCHEMA_DIR",
    "CLEAN_ROOM_ALLOWED_READ_ROOTS",
    "CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("safe", "strict"),
        default=os.environ.get("CLEAN_ROOM_HOOK_MODE", "safe"),
    )
    parser.add_argument(
        "--check",
        action="append",
        default=[],
        help="Hook script basename in the hooks directory. Repeat for multiple checks.",
    )
    return parser.parse_args()


def should_enforce(mode: str) -> bool:
    if mode == "strict":
        return True
    if os.environ.get("CLEAN_ROOM_HOOK_ENFORCE", "").lower() in TRUTHY:
        return True
    return any(os.environ.get(name) for name in CLEAN_ROOM_ENV_NAMES)


def resolve_check(script_dir: Path, check: str) -> Path:
    path = Path(check)
    if path.name != check or path.is_absolute() or check in {"", ".", ".."}:
        raise ValueError(f"invalid hook check name: {check!r}")
    resolved = script_dir / check
    if not resolved.is_file():
        raise FileNotFoundError(f"hook check does not exist: {resolved}")
    return resolved


def main() -> int:
    args = parse_args()
    if not should_enforce(args.mode):
        return 0
    if not args.check:
        print("clean-room hook wrapper has no checks configured", file=sys.stderr)
        return 1

    payload = sys.stdin.buffer.read()
    script_dir = Path(__file__).resolve().parent
    for check in args.check:
        try:
            script = resolve_check(script_dir, check)
        except (FileNotFoundError, ValueError) as exc:
            print(f"clean-room hook configuration failed: {exc}", file=sys.stderr)
            return 1
        result = subprocess.run(
            [sys.executable, str(script)],
            input=payload,
            stdout=sys.stdout,
            stderr=sys.stderr,
            check=False,
        )
        if result.returncode != 0:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
