#!/usr/bin/env python3
"""Verify clean-room handoff package paths and hashes."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from clean_room_paths import (
    checked_write_paths,
    describe_path,
    env_roots,
    load_payload,
    path_is_under,
    redact_text,
    read_artifact_text,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_handoff_package(path: Path, data: object) -> bool:
    if not isinstance(data, dict):
        return False
    return (
        path.name == "handoff-package.json"
        or data.get("package_id") is not None
        or (
            data.get("from_domain") == "contaminated"
            and data.get("to_domain") == "clean"
            and isinstance(data.get("artifacts"), list)
        )
    )


def resolve_artifact_path(raw_path: str, clean_roots: list[Path]) -> tuple[Path | None, list[str]]:
    errors: list[str] = []
    path = Path(raw_path).expanduser()
    if path.is_absolute():
        try:
            resolved = path.resolve()
        except OSError as exc:
            return None, [f"artifact path could not be resolved: {redact_text(exc)}"]
        if not any(path_is_under(resolved, root) for root in clean_roots):
            errors.append(f"artifact path is outside CLEAN_ROOM_CLEAN_ROOTS: {describe_path(resolved)}")
        return resolved, errors

    matches: list[Path] = []
    for root in clean_roots:
        candidate = root / path
        try:
            is_file = candidate.is_file()
        except OSError as exc:
            errors.append(f"artifact path could not be checked: {redact_text(exc)}")
            continue
        if not is_file:
            continue
        try:
            matches.append(candidate.resolve())
        except OSError as exc:
            errors.append(f"artifact path could not be resolved: {redact_text(exc)}")
    if len(matches) > 1:
        errors.append("artifact path is ambiguous across clean roots")
        return None, errors
    if matches:
        return matches[0], errors
    if not clean_roots:
        errors.append("CLEAN_ROOM_CLEAN_ROOTS must be set to verify handoff artifacts")
        return None, errors
    return (clean_roots[0] / path).resolve(), errors


def validate_artifact(
    item: Any,
    clean_roots: list[Path],
    blocked_roots: list[Path],
) -> list[str]:
    errors: list[str] = []
    if not isinstance(item, dict):
        return ["handoff artifact entry must be an object"]
    raw_path = item.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        return ["handoff artifact path must be a non-empty string"]
    if Path(raw_path).name == "source-index.json" or item.get("artifact_type") == "source-index":
        errors.append("source-index.json must not be included in a clean handoff package")
    if Path(raw_path).name == "task-manifest.json" or item.get("artifact_type") == "task-manifest":
        errors.append("task-manifest.json must not be included in a clean handoff package; use clean-run-context.json")
    if Path(raw_path).name == "preflight-goal.json" or item.get("artifact_type") == "preflight-goal":
        errors.append("preflight-goal.json must not be included in a clean handoff package; use clean-run-context.json goal_contract")

    artifact_path, path_errors = resolve_artifact_path(raw_path, clean_roots)
    errors.extend(path_errors)
    if artifact_path is None:
        return errors
    if not any(path_is_under(artifact_path, root) for root in clean_roots):
        errors.append(f"artifact path is outside CLEAN_ROOM_CLEAN_ROOTS: {describe_path(artifact_path)}")
    if any(path_is_under(artifact_path, root) for root in blocked_roots):
        errors.append(f"artifact path points into a contaminated or source root: {describe_path(artifact_path)}")
    if not artifact_path.is_file():
        errors.append(f"referenced artifact does not exist: {describe_path(artifact_path)}")
        return errors

    expected_sha = item.get("sha256")
    if not isinstance(expected_sha, str) or len(expected_sha) != 64:
        errors.append("artifact sha256 must be a 64-character hex string")
        return errors
    try:
        actual_sha = sha256_file(artifact_path)
    except OSError as exc:
        errors.append(f"referenced artifact could not be hashed: {describe_path(artifact_path)}: {redact_text(exc)}")
        return errors
    if actual_sha.lower() != expected_sha.lower():
        errors.append(f"artifact sha256 mismatch for {describe_path(artifact_path)}")
    return errors


def validate_handoff(path: Path) -> list[str]:
    text, read_error = read_artifact_text(path, "handoff package")
    if read_error:
        return [read_error]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return [f"JSON parse failed for {describe_path(path)}: {redact_text(exc)}"]
    if not is_handoff_package(path, data):
        return []
    if not isinstance(data, dict):
        return [f"handoff package must be an object: {describe_path(path)}"]

    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        return [f"handoff package artifacts must be an array: {describe_path(path)}"]
    errors: list[str] = []
    for item in artifacts:
        errors.extend(validate_artifact(item, clean_roots, blocked_roots))
    return errors


def main() -> int:
    payload, payload_error = load_payload()
    if payload_error:
        print(f"clean-room handoff integrity failed: {redact_text(payload_error)}", file=sys.stderr)
        return 1
    paths, path_errors = checked_write_paths(payload, "clean-room handoff integrity")
    if path_errors:
        for error in path_errors:
            print(f"clean-room handoff integrity failed: {redact_text(error)}", file=sys.stderr)
        return 1
    for path in paths:
        if path.suffix.lower() != ".json" or not path.is_file():
            continue
        errors = validate_handoff(path)
        if errors:
            print(f"clean-room handoff integrity failed for {describe_path(path)}:", file=sys.stderr)
            for error in errors[:20]:
                print(f"  {redact_text(error)}", file=sys.stderr)
            if len(errors) > 20:
                print(f"  ... {len(errors) - 20} more error(s)", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
