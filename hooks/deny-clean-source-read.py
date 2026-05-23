#!/usr/bin/env python3
"""Deny source-denied role reads outside explicitly configured roots."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from clean_room_paths import describe_path, env_roots, load_payload, path_is_under, payload_cwd, redact_text, resolve_payload_path


CLEAN_ROLES = {"clean-architect", "clean-qa-editor", "clean-polish-reviewer"}
SANITIZER_ROLE = "contaminated-handoff-sanitizer"
SOURCE_DENIED_ROLES = CLEAN_ROLES | {SANITIZER_ROLE}
ADDITIONAL_CLEAN_READ_ROOTS = "CLEAN_ROOM_ALLOWED_READ_ROOTS"
SCHEMA_READ_ROOTS = "CLEAN_ROOM_SCHEMA_DIR"
DIRECTORY_SCOPED_READ_TOOLS = {"glob", "grep", "ls", "lsp", "list_dir"}
PATH_REQUIRED_READ_TOOLS = {"read", "notebookread", "view_image"}
MCP_RESOURCE_TOOLS = {
    "listmcpresourcestool",
    "readmcpresourcetool",
    "listmcpresourcetemplatestool",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
}
READ_PATH_KEYS = ("file_path", "filePath", "path", "notebook_path", "notebookPath")
CONTAMINATED_ONLY_SANITIZER_ARTIFACTS = {
    "coverage-ledger.json": "coverage-ledger artifact",
    "evidence-ledger.json": "evidence-ledger artifact",
    "preflight-goal.json": "preflight-goal artifact",
    "source-index.json": "source-index artifact",
    "task-manifest.json": "task-manifest artifact",
}


def tool_name_for(payload: dict) -> str:
    return str(payload.get("tool_name") or payload.get("tool") or "").lower()


def append_path_value(paths: list[Path], value: str, base: Path) -> None:
    try:
        paths.append(resolve_payload_path(value, base))
    except OSError:
        return


def candidate_paths(payload: dict) -> list[Path]:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_name = tool_name_for(payload)
    try:
        base = payload_cwd(payload)
    except OSError:
        return []
    paths = []
    for key in READ_PATH_KEYS:
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


def sanitizer_allowed_roots() -> list[Path]:
    contaminated_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    allowed_roots = []
    for root in env_roots(ADDITIONAL_CLEAN_READ_ROOTS):
        if any(is_under(contaminated_root, root) for contaminated_root in contaminated_roots):
            continue
        allowed_roots.append(root)
    return allowed_roots + env_roots(SCHEMA_READ_ROOTS)


def allowed_roots_for_role(role: str) -> list[Path]:
    if role in CLEAN_ROLES:
        return (
            env_roots("CLEAN_ROOM_CLEAN_ROOTS")
            + env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
            + env_roots(ADDITIONAL_CLEAN_READ_ROOTS)
            + env_roots(SCHEMA_READ_ROOTS)
        )
    if role == SANITIZER_ROLE:
        return sanitizer_allowed_roots()
    return []


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role not in SOURCE_DENIED_ROLES:
        return 0
    payload, payload_error = load_payload()
    if payload_error:
        print(
            f"clean-room policy denied role {role} read: {redact_text(payload_error)}",
            file=sys.stderr,
        )
        return 1
    tool = tool_name_for(payload)
    if tool in MCP_RESOURCE_TOOLS:
        print(
            f"clean-room policy denied role {role} MCP resource access: no MCP resource allowlist configured",
            file=sys.stderr,
        )
        return 1
    source_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS")
    contaminated_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    allowed_roots = allowed_roots_for_role(role)
    paths = candidate_paths(payload)
    if not paths:
        if tool and tool not in PATH_REQUIRED_READ_TOOLS and tool not in DIRECTORY_SCOPED_READ_TOOLS:
            return 0
        print(
            f"clean-room policy denied role {role} read with no resolved path",
            file=sys.stderr,
        )
        return 1
    for path in paths:
        if any(is_under(path, root) for root in source_roots):
            print(
                f"clean-room policy denied role {role} reading {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and any(is_under(path, root) for root in clean_roots):
            print(
                f"clean-room policy denied role {role} reading {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and any(is_under(path, root) for root in implementation_roots):
            print(
                f"clean-room policy denied role {role} reading {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and any(is_under(path, root) for root in contaminated_roots):
            artifact_label = CONTAMINATED_ONLY_SANITIZER_ARTIFACTS.get(path.name)
            if artifact_label:
                print(
                    f"clean-room policy denied role {role} reading {artifact_label} in {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
        if role in SOURCE_DENIED_ROLES and path.name == "preflight-goal.json":
            print(
                f"clean-room policy denied role {role} reading preflight-goal artifact in {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if role == SANITIZER_ROLE and path.name == "source-index.json":
            print(
                f"clean-room policy denied role {role} reading source-index artifact in {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if not allowed_roots:
            print(
                f"clean-room policy denied role {role} reading {describe_path(path)}: no allowed read roots configured",
                file=sys.stderr,
            )
            return 1
        if not any(is_under(path, root) for root in allowed_roots):
            print(
                f"clean-room policy denied role {role} reading outside allowed roots: {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
