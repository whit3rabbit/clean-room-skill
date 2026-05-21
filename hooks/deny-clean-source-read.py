#!/usr/bin/env python3
"""Deny source-denied role reads outside explicitly configured roots."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from clean_room_paths import env_roots, load_payload, path_is_under, payload_cwd, resolve_payload_path


CLEAN_ROLES = {"clean-architect", "clean-qa-editor"}
SANITIZER_ROLE = "contaminated-handoff-sanitizer"
SOURCE_DENIED_ROLES = CLEAN_ROLES | {SANITIZER_ROLE}
ADDITIONAL_CLEAN_READ_ROOTS = "CLEAN_ROOM_ALLOWED_READ_ROOTS"
SCHEMA_READ_ROOTS = "CLEAN_ROOM_SCHEMA_DIR"
DIRECTORY_SCOPED_READ_TOOLS = {"glob", "grep"}
PATH_REQUIRED_READ_TOOLS = {"read"}


def append_path_value(paths: list[Path], value: str, base: Path) -> None:
    try:
        paths.append(resolve_payload_path(value, base))
    except OSError:
        return


def candidate_paths(payload: dict) -> list[Path]:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_name = str(payload.get("tool_name") or payload.get("tool") or "").lower()
    try:
        base = payload_cwd(payload)
    except OSError:
        return []
    paths = []
    for key in ("file_path", "path"):
        value = tool_input.get(key) or payload.get(key)
        if isinstance(value, str):
            append_path_value(paths, value, base)
    glob_value = tool_input.get("glob") or payload.get("glob")
    if isinstance(glob_value, str) and (glob_value.startswith(("/", "~")) or "/" in glob_value):
        append_path_value(paths, glob_value, base)
    pattern_value = tool_input.get("pattern") or payload.get("pattern")
    if "glob" in tool_name and isinstance(pattern_value, str) and (
        pattern_value.startswith(("/", "~")) or "/" in pattern_value
    ):
        append_path_value(paths, pattern_value, base)
    if not paths and tool_name in DIRECTORY_SCOPED_READ_TOOLS:
        paths.append(base)
    return paths


def is_under(path: Path, root: Path) -> bool:
    return path_is_under(path, root)


def allowed_roots_for_role(role: str) -> list[Path]:
    if role in CLEAN_ROLES:
        return (
            env_roots("CLEAN_ROOM_CLEAN_ROOTS")
            + env_roots(ADDITIONAL_CLEAN_READ_ROOTS)
            + env_roots(SCHEMA_READ_ROOTS)
        )
    if role == SANITIZER_ROLE:
        return (
            env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
            + env_roots(ADDITIONAL_CLEAN_READ_ROOTS)
            + env_roots(SCHEMA_READ_ROOTS)
        )
    return []


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role not in SOURCE_DENIED_ROLES:
        return 0
    payload, payload_error = load_payload()
    if payload_error:
        print(
            f"clean-room policy denied role {role} read: {payload_error}",
            file=sys.stderr,
        )
        return 1
    source_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS")
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    allowed_roots = allowed_roots_for_role(role)
    paths = candidate_paths(payload)
    if not paths:
        tool = str(payload.get("tool_name") or payload.get("tool") or "").lower()
        if tool and tool not in PATH_REQUIRED_READ_TOOLS:
            return 0
        print(
            f"clean-room policy denied role {role} read with no resolved path",
            file=sys.stderr,
        )
        return 1
    for path in paths:
        if any(is_under(path, root) for root in source_roots):
            print(
                f"clean-room policy denied role {role} reading source path {path}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and any(is_under(path, root) for root in clean_roots):
            print(
                f"clean-room policy denied role {role} reading clean path {path}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and path.name == "source-index.json":
            print(
                f"clean-room policy denied role {role} reading source-index artifact {path}",
                file=sys.stderr,
            )
            return 1
        if not allowed_roots:
            print(
                f"clean-room policy denied role {role} reading {path}: no allowed read roots configured",
                file=sys.stderr,
            )
            return 1
        if not any(is_under(path, root) for root in allowed_roots):
            print(
                f"clean-room policy denied role {role} reading outside allowed roots: {path}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
