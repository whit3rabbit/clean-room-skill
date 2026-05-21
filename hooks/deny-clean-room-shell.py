#!/usr/bin/env python3
"""Block shell-style tools for clean-room role sessions."""

from __future__ import annotations

import os
import sys

from clean_room_paths import env_roots, load_payload, path_is_under, payload_cwd


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "contaminated-handoff-sanitizer",
    "clean-architect",
    "clean-qa-editor",
}
AGENT3_ROLE = "clean-qa-editor"
ALLOW_AGENT3_SHELL_ENV = "CLEAN_ROOM_ALLOW_AGENT3_SHELL"


def agent3_shell_allowed() -> tuple[bool, str]:
    if os.environ.get(ALLOW_AGENT3_SHELL_ENV) != "1":
        return False, f"{ALLOW_AGENT3_SHELL_ENV}=1 is required"
    payload, payload_error = load_payload()
    if payload_error:
        return False, payload_error
    try:
        cwd = payload_cwd(payload)
    except OSError as exc:
        return False, f"invalid shell cwd: {exc}"
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    if not implementation_roots:
        return False, "CLEAN_ROOM_IMPLEMENTATION_ROOTS has no configured roots"
    if not any(path_is_under(cwd, root) for root in implementation_roots):
        return False, f"shell cwd is outside implementation roots: {cwd}"
    return True, ""


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role == AGENT3_ROLE:
        allowed, reason = agent3_shell_allowed()
        if allowed:
            return 0
        print(
            f"clean-room policy denied shell tool use for role {role}: {reason}",
            file=sys.stderr,
        )
        return 1
    if role in ROLES:
        print(
            f"clean-room policy denied shell tool use for role {role}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
