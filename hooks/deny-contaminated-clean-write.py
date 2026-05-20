#!/usr/bin/env python3
"""Enforce clean-room write roots for contaminated and clean roles."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from clean_room_paths import candidate_paths, env_roots, load_payload, path_is_under


CONTAMINATED_ROLES = {"contaminated-manager-verifier", "contaminated-source-analyst"}
CLEAN_ROLES = {"clean-architect", "clean-qa-editor"}


def is_under(path: Path, root: Path) -> bool:
    return path_is_under(path, root)


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role not in CONTAMINATED_ROLES and role not in CLEAN_ROLES:
        return 0
    payload, payload_error = load_payload()
    if payload_error:
        print(
            f"clean-room policy denied role {role} write: {payload_error}",
            file=sys.stderr,
        )
        return 1
    paths, path_errors = candidate_paths(payload)
    if path_errors:
        for error in path_errors:
            print(f"clean-room policy denied role {role} write: {error}", file=sys.stderr)
        return 1
    if not paths:
        print(
            f"clean-room policy denied role {role} write with no resolved path",
            file=sys.stderr,
        )
        return 1

    source_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS")
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    contaminated_artifact_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")

    if role in CLEAN_ROLES:
        allowed_read_roots = env_roots("CLEAN_ROOM_ALLOWED_READ_ROOTS")
        for path in paths:
            if any(is_under(path, root) for root in source_roots):
                print(
                    f"clean-room policy denied clean role {role} writing source path {path}",
                    file=sys.stderr,
                )
                return 1
            if any(is_under(path, root) for root in allowed_read_roots) and not any(
                is_under(path, root) for root in clean_roots
            ):
                print(
                    f"clean-room policy denied clean role {role} writing read-only allowed-read path {path}",
                    file=sys.stderr,
                )
                return 1
            if not clean_roots:
                print(
                    f"clean-room policy denied clean role {role} writing {path}: no clean write roots configured",
                    file=sys.stderr,
                )
                return 1
            if not any(is_under(path, root) for root in clean_roots):
                print(
                    f"clean-room policy denied clean role {role} writing outside clean roots: {path}",
                    file=sys.stderr,
                )
                return 1
        return 0

    for path in paths:
        if any(is_under(path, root) for root in clean_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing clean path {path}",
                file=sys.stderr,
            )
            return 1
        if any(is_under(path, root) for root in source_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing source path {path}",
                file=sys.stderr,
            )
            return 1
        if not contaminated_artifact_roots:
            print(
                f"clean-room policy denied contaminated role {role} writing {path}: no contaminated artifact roots configured",
                file=sys.stderr,
            )
            return 1
        if not any(is_under(path, root) for root in contaminated_artifact_roots):
            print(
                f"clean-room policy denied contaminated role {role} writing outside contaminated artifact roots: {path}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
