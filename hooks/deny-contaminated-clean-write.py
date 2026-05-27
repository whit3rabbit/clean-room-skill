#!/usr/bin/env python3
"""Enforce clean-room write roots for contaminated and clean roles."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from clean_room_paths import (
    candidate_paths,
    describe_path,
    env_roots,
    load_payload,
    path_is_under,
    redact_text,
    should_fail_closed_for_write,
)


CONTAMINATED_ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "contaminated-handoff-sanitizer",
}
CLEAN_ROLES = {"clean-architect", "clean-qa-editor", "clean-polish-reviewer"}
CONTAMINATED_ONLY_ARTIFACT_NAMES = {
    "clean-room-result.json",
    "init-config.json",
    "preflight-goal.json",
    "task-manifest.json",
}
CLEAN_ROOM_ARTIFACT_PREFIXES = (
    "behavior-spec",
    "clean-room-result",
    "clean-run-context",
    "contamination-incident",
    "controller-status",
    "coverage-ledger",
    "evidence-ledger",
    "handoff-package",
    "implementation-plan",
    "implementation-report",
    "init-config",
    "polish-report",
    "preflight-goal",
    "qc-report",
    "role-session-brief",
    "skeleton-manifest",
    "source-index",
    "task-manifest",
    "visual-index",
)


def is_under(path: Path, root: Path) -> bool:
    return path_is_under(path, root)


def is_clean_room_artifact_name(path: Path) -> bool:
    if path.suffix.lower() != ".json":
        return False
    stem = path.name[:-5]
    return any(stem == prefix or stem.startswith(f"{prefix}-") for prefix in CLEAN_ROOM_ARTIFACT_PREFIXES)


def is_contaminated_only_artifact_name(path: Path) -> bool:
    return path.name in CONTAMINATED_ONLY_ARTIFACT_NAMES


def deny_contaminated_only_outside_root(path: Path, contaminated_artifact_roots: list[Path]) -> bool:
    return is_contaminated_only_artifact_name(path) and not any(is_under(path, root) for root in contaminated_artifact_roots)


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role not in CONTAMINATED_ROLES and role not in CLEAN_ROLES:
        return 0
    payload, payload_error = load_payload()
    if payload_error:
        print(
            f"clean-room policy denied role {role} write: {redact_text(payload_error)}",
            file=sys.stderr,
        )
        return 1
    paths, path_errors = candidate_paths(payload)
    if path_errors:
        for error in path_errors:
            print(f"clean-room policy denied role {role} write: {redact_text(error)}", file=sys.stderr)
        return 1
    if not paths:
        if not should_fail_closed_for_write(payload):
            return 0
        print(
            f"clean-room policy denied role {role} write with no resolved path",
            file=sys.stderr,
        )
        return 1

    source_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS")
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    contaminated_artifact_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")

    if role in CLEAN_ROLES:
        allowed_read_roots = env_roots("CLEAN_ROOM_ALLOWED_READ_ROOTS")
        for path in paths:
            if deny_contaminated_only_outside_root(path, contaminated_artifact_roots):
                print(
                    f"clean-room policy denied role {role} writing contaminated-only artifact outside "
                    f"CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
            if any(is_under(path, root) for root in source_roots):
                print(
                    f"clean-room policy denied clean role {role} writing {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
            if any(is_under(path, root) for root in allowed_read_roots) and not any(
                is_under(path, root) for root in clean_roots + implementation_roots
            ):
                print(
                    f"clean-room policy denied clean role {role} writing read-only {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
            if not clean_roots:
                print(
                    f"clean-room policy denied clean role {role} writing {describe_path(path)}: no clean write roots configured",
                    file=sys.stderr,
                )
                return 1
            if role == "clean-architect" and any(is_under(path, root) for root in implementation_roots):
                print(
                    f"clean-room policy denied Agent 2 writing {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
            if role in {"clean-qa-editor", "clean-polish-reviewer"} and any(
                is_under(path, root) for root in implementation_roots
            ):
                if is_clean_room_artifact_name(path):
                    print(
                        f"clean-room policy denied clean role {role} writing clean-room artifact under "
                        f"CLEAN_ROOM_IMPLEMENTATION_ROOTS: {describe_path(path)}",
                        file=sys.stderr,
                    )
                    return 1
                continue
            if not any(is_under(path, root) for root in clean_roots):
                print(
                    f"clean-room policy denied clean role {role} writing outside clean roots: {describe_path(path)}",
                    file=sys.stderr,
                )
                return 1
        return 0

    for path in paths:
        if deny_contaminated_only_outside_root(path, contaminated_artifact_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing contaminated-only artifact outside "
                f"CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if any(is_under(path, root) for root in clean_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if any(is_under(path, root) for root in implementation_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if any(is_under(path, root) for root in source_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
        if not contaminated_artifact_roots:
            print(
                f"clean-room policy denied contaminated role {role} writing {describe_path(path)}: no contaminated artifact roots configured",
                file=sys.stderr,
            )
            return 1
        if not any(is_under(path, root) for root in contaminated_artifact_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing outside contaminated artifact roots: {describe_path(path)}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
