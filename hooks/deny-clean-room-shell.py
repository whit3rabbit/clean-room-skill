#!/usr/bin/env python3
"""Block shell-style tools for clean-room role sessions."""

from __future__ import annotations

import os
import sys


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "clean-architect",
    "clean-qa-editor",
}


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role in ROLES:
        print(
            f"clean-room policy denied shell tool use for role {role}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
