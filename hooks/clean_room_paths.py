"""Shared path and payload helpers for clean-room hook scripts."""

from __future__ import annotations

import json
import os
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "contaminated-handoff-sanitizer",
    "clean-architect",
    "clean-qa-editor",
    "clean-polish-reviewer",
}
CLEAN_ROLES = {"clean-architect", "clean-qa-editor", "clean-polish-reviewer"}
SOURCE_DENIED_ROLES = CLEAN_ROLES | {"contaminated-handoff-sanitizer"}
PATH_KEYS = {
    "file_path",
    "filePath",
    "path",
    "output_path",
    "outputPath",
}
MAX_HOOK_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_PATH_EXTRACTION_DEPTH = 40
DEBUG_PATHS_ENV = "CLEAN_ROOM_DEBUG_PATHS"
ROOT_LABELS = (
    ("CLEAN_ROOM_SOURCE_ROOTS", "source-root"),
    ("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS", "contaminated-root"),
    ("CLEAN_ROOM_CLEAN_ROOTS", "clean-root"),
    ("CLEAN_ROOM_IMPLEMENTATION_ROOTS", "implementation-root"),
    ("CLEAN_ROOM_ALLOWED_READ_ROOTS", "allowed-read-root"),
    ("CLEAN_ROOM_SCHEMA_DIR", "schema-root"),
)
GENERIC_PATH_TOKENS = {
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
MIN_PRIVATE_TOKEN_LENGTH = 4


def path_is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def paths_overlap(left: Path, right: Path) -> bool:
    return path_is_under(left, right) or path_is_under(right, left)


def normalize_path_name(value: str) -> str:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", value)
    return re.sub(r"[^a-z0-9]+", "-", separated.lower()).strip("-")


def private_name_tokens(value: str) -> set[str]:
    normalized = normalize_path_name(value)
    if not normalized:
        return set()
    return {
        token
        for token in normalized.split("-")
        if len(token) >= MIN_PRIVATE_TOKEN_LENGTH and token not in GENERIC_PATH_TOKENS
    }


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


def should_redact_paths(role: str | None = None) -> bool:
    active_role = role if role is not None else active_clean_room_role()
    if active_role in SOURCE_DENIED_ROLES:
        return True
    if active_role in ROLES:
        return os.environ.get(DEBUG_PATHS_ENV) != "1"
    return False


def root_label_for_path(path: Path) -> str | None:
    for env_name, label in ROOT_LABELS:
        for index, root in enumerate(env_roots(env_name)):
            if path_is_under(path, root):
                return f"{label}[{index}]"
    return None


def describe_path(path: Path | str, role: str | None = None) -> str:
    if not should_redact_paths(role):
        return str(path)
    try:
        resolved = Path(path).expanduser().resolve()
    except OSError:
        return "path"
    return root_label_for_path(resolved) or "path"


@lru_cache(maxsize=1)
def _redaction_replacements() -> list[tuple[str, str]]:
    replacements: list[tuple[str, str]] = []
    private_terms: set[str] = set()
    for env_name, label in ROOT_LABELS:
        raw_items = [item for item in os.environ.get(env_name, "").split(os.pathsep) if item]
        for index, raw in enumerate(raw_items):
            root_label = f"{label}[{index}]"
            replacements.append((raw, root_label))
            try:
                resolved = str(Path(raw).expanduser().resolve())
            except OSError:
                resolved = ""
            if resolved:
                replacements.append((resolved, root_label))
            if env_name in {
                "CLEAN_ROOM_SOURCE_ROOTS",
                "CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS",
                "CLEAN_ROOM_CLEAN_ROOTS",
                "CLEAN_ROOM_IMPLEMENTATION_ROOTS",
            }:
                private_terms.update(private_name_tokens(Path(raw).name))
                if resolved:
                    private_terms.update(private_name_tokens(Path(resolved).name))
    for term in sorted(private_terms, key=len, reverse=True):
        replacements.append((term, "private-name"))
    return replacements


def redact_text(value: object, role: str | None = None) -> str:
    text = str(value)
    if not should_redact_paths(role):
        return text
    for needle, replacement in _redaction_replacements():
        if needle:
            text = text.replace(needle, replacement)
    return text


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
    raw_bytes = sys.stdin.buffer.read(MAX_HOOK_PAYLOAD_BYTES + 1)
    if len(raw_bytes) > MAX_HOOK_PAYLOAD_BYTES:
        return {}, f"hook payload exceeds {MAX_HOOK_PAYLOAD_BYTES} bytes"
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        return {}, f"malformed hook JSON payload: {exc}"
    if not raw.strip():
        return {}, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {}, f"malformed hook JSON payload: {exc}"
    if not isinstance(data, dict):
        return {}, "hook payload must be a JSON object"
    return data, None


def should_fail_closed_for_write(payload: dict[str, Any]) -> bool:
    return bool(active_clean_room_role())


def _path_values(value: Any, depth: int = 0) -> list[str]:
    if depth > MAX_PATH_EXTRACTION_DEPTH:
        raise ValueError(f"hook payload path extraction exceeded depth {MAX_PATH_EXTRACTION_DEPTH}")
    paths: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in PATH_KEYS and isinstance(item, str):
                paths.append(item)
            elif isinstance(item, (dict, list)):
                paths.extend(_path_values(item, depth + 1))
    elif isinstance(value, list):
        for item in value:
            paths.extend(_path_values(item, depth + 1))
    return paths


def candidate_paths(payload: dict[str, Any]) -> tuple[list[Path], list[str]]:
    paths: list[Path] = []
    errors: list[str] = []
    seen: set[Path] = set()
    try:
        base = payload_cwd(payload)
    except OSError as exc:
        return [], [f"invalid hook cwd: {redact_text(exc)}"]
    try:
        raw_paths = _path_values(payload)
    except ValueError as exc:
        return [], [str(exc)]
    for value in raw_paths:
        try:
            path = resolve_payload_path(value, base)
        except OSError as exc:
            errors.append(f"invalid hook path: {redact_text(exc)}")
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
            try:
                is_file = path.is_file()
            except OSError as exc:
                errors.append(f"{hook_name} could not stat written file: {describe_path(path)}: {redact_text(exc)}")
                continue
            if not is_file:
                errors.append(f"{hook_name} could not read written file: {describe_path(path)}")
    return paths, errors


def stat_artifact(path: Path, label: str) -> tuple[os.stat_result | None, str | None]:
    try:
        return path.stat(), None
    except OSError as exc:
        return None, f"{label} could not stat {describe_path(path)}: {redact_text(exc)}"


def read_artifact_bytes(path: Path, label: str) -> tuple[bytes | None, str | None]:
    try:
        return path.read_bytes(), None
    except OSError as exc:
        return None, f"{label} could not read {describe_path(path)}: {redact_text(exc)}"


def read_artifact_text(path: Path, label: str) -> tuple[str | None, str | None]:
    try:
        return path.read_text(encoding="utf-8"), None
    except OSError as exc:
        return None, f"{label} could not read {describe_path(path)}: {redact_text(exc)}"
