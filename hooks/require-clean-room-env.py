#!/usr/bin/env python3
"""Require explicit clean-room role and root configuration before tool use."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from clean_room_paths import describe_path, paths_overlap, redact_text


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
    "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
    "CLEAN_ROOM_SCHEMA_DIR",
)
ROOT_VARS = (
    "CLEAN_ROOM_SOURCE_ROOTS",
    "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
    "CLEAN_ROOM_CLEAN_ROOTS",
    "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
    "CLEAN_ROOM_SCHEMA_DIR",
    "CLEAN_ROOM_ALLOWED_READ_ROOTS",
)
GENERIC_SOURCE_NAME_TOKENS = {
    "app",
    "apps",
    "artifact",
    "artifacts",
    "clean",
    "code",
    "contaminated",
    "doc",
    "docs",
    "document",
    "documents",
    "implementation",
    "impl",
    "lib",
    "main",
    "output",
    "outputs",
    "project",
    "quarantine",
    "repo",
    "room",
    "source",
    "spec",
    "src",
    "test",
    "tests",
    "workspace",
    "worktree",
}
MIN_SOURCE_NAME_TOKEN_LENGTH = 4


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
            errors.append(f"{name} has invalid path: {redact_text(exc)}")
            continue
        if require_existing and not path.exists():
            errors.append(f"{name} path does not exist: {describe_path(path)}")
    return errors


def resolved_roots(name: str) -> tuple[list[Path], list[str]]:
    roots: list[Path] = []
    errors: list[str] = []
    for item in split_roots(os.environ.get(name, "")):
        try:
            roots.append(Path(item).expanduser().resolve())
        except OSError as exc:
            errors.append(f"{name} has invalid path: {redact_text(exc)}")
    return roots, errors


def normalize_path_name(value: str) -> str:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", value)
    return re.sub(r"[^a-z0-9]+", "-", separated.lower()).strip("-")


def compact_path_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def source_name_terms(source_root: Path) -> tuple[set[str], set[str]]:
    normalized = normalize_path_name(source_root.name)
    if not normalized:
        return set(), set()
    raw_tokens = [token for token in normalized.split("-") if token]
    tokens = {
        token
        for token in raw_tokens
        if len(token) >= MIN_SOURCE_NAME_TOKEN_LENGTH and token not in GENERIC_SOURCE_NAME_TOKENS
    }
    exact_names = (
        {normalized}
        if any(token not in GENERIC_SOURCE_NAME_TOKENS for token in raw_tokens)
        else set()
    )
    return exact_names, tokens


def artifact_components_after_common_prefix(source_root: Path, artifact_root: Path) -> tuple[str, ...]:
    try:
        common = Path(os.path.commonpath([str(source_root), str(artifact_root)]))
        return artifact_root.relative_to(common).parts
    except ValueError:
        return artifact_root.parts


def has_source_derived_name(source_root: Path, artifact_root: Path) -> bool:
    exact_names, tokens = source_name_terms(source_root)
    if not exact_names and not tokens:
        return False
    for component in artifact_components_after_common_prefix(source_root, artifact_root):
        normalized = normalize_path_name(component)
        compact = compact_path_name(component)
        if not normalized and not compact:
            continue
        if normalized in exact_names or compact in exact_names:
            return True
        if any(token in normalized or token in compact for token in tokens):
            return True
    return False


def reject_source_derived_artifact_names(target_name: str) -> list[str]:
    source_roots, source_errors = resolved_roots("CLEAN_ROOM_SOURCE_ROOTS")
    target_roots, target_errors = resolved_roots(target_name)
    errors = source_errors + target_errors
    for source_root in source_roots:
        for target_root in target_roots:
            if has_source_derived_name(source_root, target_root):
                errors.append(
                    f"{target_name} path appears source-derived from a source root name; "
                    "use a neutral task id such as task-8af2c91d"
                )
    return errors


def reject_overlaps(left_name: str, right_name: str, message: str) -> list[str]:
    left_roots, left_errors = resolved_roots(left_name)
    right_roots, right_errors = resolved_roots(right_name)
    errors = left_errors + right_errors
    for left in left_roots:
        for right in right_roots:
            if paths_overlap(left, right):
                errors.append(f"{message}: {left_name} overlaps {right_name}")
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
            "CLEAN_ROOM_SOURCE_ROOTS",
            "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
            "source roots and implementation roots must be separate",
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
            "CLEAN_ROOM_CLEAN_ROOTS",
            "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
            "clean roots and implementation roots must be separate",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
            "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
            "contaminated artifact roots and implementation roots must be separate",
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
            "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
            "schema directory must be separate from implementation roots",
        )
    )
    errors.extend(
        reject_overlaps(
            "CLEAN_ROOM_SCHEMA_DIR",
            "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
            "schema directory must be separate from contaminated artifact roots",
        )
    )
    errors.extend(reject_source_derived_artifact_names("CLEAN_ROOM_CLEAN_ROOTS"))
    errors.extend(reject_source_derived_artifact_names("CLEAN_ROOM_IMPLEMENTATION_ROOTS"))
    errors.extend(reject_source_derived_artifact_names("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS"))
    if errors:
        print("clean-room environment check failed:", file=sys.stderr)
        for error in errors:
            print(f"  {redact_text(error)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
