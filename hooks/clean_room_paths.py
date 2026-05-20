"""Shared path and payload helpers for clean-room hook scripts."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "clean-architect",
    "clean-qa-editor",
}
CLEAN_ROLES = {"clean-architect", "clean-qa-editor"}
WRITE_TOOL_NAMES = {"Write", "Edit", "MultiEdit"}
PATH_KEYS = {
    "file_path",
    "filePath",
    "path",
    "output_path",
    "outputPath",
}


def path_is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def paths_overlap(left: Path, right: Path) -> bool:
    return path_is_under(left, right) or path_is_under(right, left)


def split_paths(value: str) -> list[Path]:
    paths: list[Path] = []
    for item in value.split(os.pathsep):
        if not item:
            continue
        paths.append(Path(item).expanduser().resolve())
    return paths


def env_roots(name: str) -> list[Path]:
    try:
        return split_paths(os.environ.get(name, ""))
    except OSError:
        return []


def path_under_env(path: Path, name: str) -> bool:
    roots = env_roots(name)
    return bool(roots) and any(path_is_under(path, root) for root in roots)


def payload_cwd(payload: dict[str, Any]) -> Path:
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    raw = tool_input.get("cwd") or payload.get("cwd")
    if isinstance(raw, str) and raw:
        return Path(raw).expanduser().resolve()
    return Path.cwd().resolve()


def resolve_payload_path(value: str, base: Path) -> Path:
    p = Path(value).expanduser()
    return p.resolve() if p.is_absolute() else (base / p).resolve()


def active_clean_room_role() -> str:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    return role if role in ROLES else ""


def load_payload() -> tuple[dict[str, Any], str | None]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {}, f"malformed hook JSON payload: {exc}"
    if not isinstance(data, dict):
        return {}, "hook payload must be a JSON object"
    return data, None


def tool_name(payload: dict[str, Any]) -> str:
    for key in ("tool_name", "tool", "name"):
        value = payload.get(key)
        if isinstance(value, str):
            return value
    return ""


def should_fail_closed_for_write(payload: dict[str, Any]) -> bool:
    if not active_clean_room_role():
        return False
    name = tool_name(payload)
    return not name or name in WRITE_TOOL_NAMES


def _path_values(value: Any) -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in PATH_KEYS and isinstance(item, str):
                paths.append(item)
            elif isinstance(item, (dict, list)):
                paths.extend(_path_values(item))
    elif isinstance(value, list):
        for item in value:
            paths.extend(_path_values(item))
    return paths


def candidate_paths(payload: dict[str, Any]) -> tuple[list[Path], list[str]]:
    paths: list[Path] = []
    errors: list[str] = []
    seen: set[Path] = set()
    try:
        base = payload_cwd(payload)
    except OSError as exc:
        return [], [f"invalid hook cwd: {exc}"]
    for value in _path_values(payload):
        try:
            path = resolve_payload_path(value, base)
        except OSError as exc:
            errors.append(f"invalid hook path {value!r}: {exc}")
            continue
        if path in seen:
            continue
        seen.add(path)
        paths.append(path)
    return paths, errors


def checked_write_paths(payload: dict[str, Any], hook_name: str) -> tuple[list[Path], list[str]]:
    paths, errors = candidate_paths(payload)
    if should_fail_closed_for_write(payload):
        if not paths:
            errors.append(f"{hook_name} could not determine the written path from the hook payload")
        for path in paths:
            if not path.is_file():
                errors.append(f"{hook_name} could not read written file: {path}")
    return paths, errors
