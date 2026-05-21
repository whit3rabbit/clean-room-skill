#!/usr/bin/env python3
"""Require explicit clean-room role and root configuration before tool use."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from clean_room_paths import paths_overlap


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "contaminated-handoff-sanitizer",
    "clean-architect",
    "clean-qa-editor",
}
CLEAN_ROLES = {"clean-architect", "clean-qa-editor"}
SOURCE_DENIED_CONTAMINATED_ROLES = {"contaminated-handoff-sanitizer"}
NONEMPTY_VARS = (
    "CLEAN_ROOM_ROLE",
    "CLEAN_ROOM_SOURCE_ROOTS",
    "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
    "CLEAN_ROOM_CLEAN_ROOTS",
    "CLEAN_ROOM_SCHEMA_DIR",
)
ROOT_VARS = (
    "CLEAN_ROOM_SOURCE_ROOTS",
    "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
    "CLEAN_ROOM_CLEAN_ROOTS",
    "CLEAN_ROOM_SCHEMA_DIR",
    "CLEAN_ROOM_ALLOWED_READ_ROOTS",
)


def split_roots(value: str) -> list[str]:
    return [item for item in value.split(os.pathsep) if item]


def validate_roots(name: str, require_existing: bool = False) -> list[str]:
    value = os.environ.get(name, "")
    errors = []
    if name in NONEMPTY_VARS and not split_roots(value):
        errors.append(f"{name} must not be empty")
        return errors
    for item in split_roots(value):
        try:
            path = Path(item).expanduser().resolve()
        except OSError as exc:
            errors.append(f"{name} has invalid path {item!r}: {exc}")
            continue
        if require_existing and not path.exists():
            errors.append(f"{name} path does not exist: {path}")
    return errors


def resolved_roots(name: str) -> tuple[list[Path], list[str]]:
    roots: list[Path] = []
    errors: list[str] = []
    for item in split_roots(os.environ.get(name, "")):
        try:
            roots.append(Path(item).expanduser().resolve())
        except OSError as exc:
            errors.append(f"{name} has invalid path {item!r}: {exc}")
    return roots, errors


def reject_overlaps(left_name: str, right_name: str, message: str) -> list[str]:
    left_roots, left_errors = resolved_roots(left_name)
    right_roots, right_errors = resolved_roots(right_name)
    errors = left_errors + right_errors
    for left in left_roots:
        for right in right_roots:
            if paths_overlap(left, right):
                errors.append(f"{message}: {left_name}={left} overlaps {right_name}={right}")
    return errors


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    missing = [name for name in NONEMPTY_VARS if name not in os.environ]
    errors = [f"{name} is not set" for name in missing]
    if role and role not in ROLES:
        errors.append(f"CLEAN_ROOM_ROLE must be one of {', '.join(sorted(ROLES))}")
    for name in ROOT_VARS:
        if name in os.environ:
            errors.extend(validate_roots(name, require_existing=name == "CLEAN_ROOM_SCHEMA_DIR"))
    if role in CLEAN_ROLES and "CLEAN_ROOM_ALLOWED_READ_ROOTS" not in os.environ:
        errors.append("CLEAN_ROOM_ALLOWED_READ_ROOTS is not set for clean role")
    if role in SOURCE_DENIED_CONTAMINATED_ROLES and "CLEAN_ROOM_ALLOWED_READ_ROOTS" not in os.environ:
        errors.append("CLEAN_ROOM_ALLOWED_READ_ROOTS is not set for source-denied contaminated role")
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SOURCE_ROOTS",
            "CLEAN_ROOM_CLEAN_ROOTS",
            "source roots and clean roots must be separate",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SOURCE_ROOTS",
            "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
            "source roots and contaminated artifact roots must be separate",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_CLEAN_ROOTS",
            "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
            "clean roots and contaminated artifact roots must be separate",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_ALLOWED_READ_ROOTS",
            "CLEAN_ROOM_SOURCE_ROOTS",
            "allowed clean read roots must not expose source roots",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SCHEMA_DIR",
            "CLEAN_ROOM_SOURCE_ROOTS",
            "schema directory must be separate from source roots",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SCHEMA_DIR",
            "CLEAN_ROOM_CLEAN_ROOTS",
            "schema directory must be separate from clean roots",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SCHEMA_DIR",
            "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
            "schema directory must be separate from contaminated artifact roots",
        )
    )
    if errors:
        print("clean-room environment check failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
