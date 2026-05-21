#!/usr/bin/env python3
"""Block shell-style tools for clean-room role sessions."""

from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path

from clean_room_paths import describe_path, env_roots, load_payload, path_is_under, payload_cwd, redact_text


ROLES = {
    "contaminated-manager-verifier",
    "contaminated-source-analyst",
    "contaminated-handoff-sanitizer",
    "clean-architect",
    "clean-qa-editor",
}
AGENT3_ROLE = "clean-qa-editor"
ALLOW_AGENT3_SHELL_ENV = "CLEAN_ROOM_ALLOW_AGENT3_SHELL"
RUNNER_NAME = "agent3-verification-runner.py"
SHELL_META_CHARS = ("|", "&", ";", "<", ">", "`", "$", "\n", "\r")
RUNNER_FLAGS_WITH_VALUE = {"--plan", "--command-index", "--timeout"}
RUNNER_FLAGS_WITHOUT_VALUE = {"--all"}


def tool_input_for(payload: dict) -> dict:
    tool_input = payload.get("tool_input")
    return tool_input if isinstance(tool_input, dict) else {}


def shell_command_for(payload: dict) -> str | None:
    tool_input = tool_input_for(payload)
    for key in ("command", "cmd", "script"):
        value = tool_input.get(key) or payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def split_shell_command(command: str) -> tuple[list[str], str | None]:
    if any(item in command for item in SHELL_META_CHARS):
        return [], "shell syntax is not allowed for Agent 3 verification"
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return [], f"invalid shell command: {exc}"
    if not argv:
        return [], "shell command is empty"
    return argv, None


def expected_runner_path() -> Path:
    return Path(__file__).resolve().parent / RUNNER_NAME


def resolves_to_expected_runner(raw_path: str, cwd: Path) -> bool:
    path = Path(raw_path).expanduser()
    resolved = path.resolve() if path.is_absolute() else (cwd / path).resolve()
    return resolved == expected_runner_path()


def validate_runner_args(argv: list[str], cwd: Path, blocked_roots: list[Path]) -> tuple[bool, str]:
    seen_selector = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if any(str(root) in arg for root in blocked_roots):
            return False, "runner arguments reference a blocked root"
        if arg.startswith("file:"):
            return False, "file URLs are not allowed for Agent 3 verification"
        if arg in RUNNER_FLAGS_WITHOUT_VALUE:
            if arg == "--all":
                if seen_selector:
                    return False, "set exactly one runner command selector"
                seen_selector = True
            index += 1
            continue
        if arg not in RUNNER_FLAGS_WITH_VALUE:
            return False, "unexpected Agent 3 verification runner argument"
        if index + 1 >= len(argv):
            return False, f"{arg} requires a value"
        value = argv[index + 1]
        if any(str(root) in value for root in blocked_roots):
            return False, "runner arguments reference a blocked root"
        if arg == "--plan":
            try:
                plan_path = Path(value).expanduser()
                resolved = plan_path.resolve() if plan_path.is_absolute() else (cwd / plan_path).resolve()
            except OSError as exc:
                return False, f"invalid runner plan path: {exc}"
            clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
            if not any(path_is_under(resolved, root) for root in clean_roots):
                return False, "runner plan path is outside clean roots"
            if any(path_is_under(resolved, root) for root in blocked_roots):
                return False, "runner plan path is under a blocked root"
        elif arg in {"--command-index", "--timeout"}:
            if not value.isdigit():
                return False, f"{arg} must be numeric"
            if arg == "--command-index":
                if seen_selector:
                    return False, "set exactly one runner command selector"
                seen_selector = True
        index += 2
    if not seen_selector:
        return False, "Agent 3 verification runner requires --command-index or --all"
    return True, ""


def command_invokes_runner(argv: list[str], cwd: Path, blocked_roots: list[Path]) -> tuple[bool, str]:
    executable = Path(argv[0]).name
    runner_arg_index = None
    if executable in {"python", "python3"}:
        if len(argv) < 2:
            return False, "python runner command is missing the runner script"
        if Path(argv[1]).name != RUNNER_NAME:
            return False, "Agent 3 may only invoke the verification runner"
        runner_arg_index = 1
    elif executable == RUNNER_NAME:
        runner_arg_index = 0
    else:
        return False, "Agent 3 may only invoke the verification runner"
    if not resolves_to_expected_runner(argv[runner_arg_index], cwd):
        return False, "Agent 3 verification runner path is not the installed runner"
    return validate_runner_args(argv[runner_arg_index + 1 :], cwd, blocked_roots)


def agent3_shell_allowed() -> tuple[bool, str]:
    if os.environ.get(ALLOW_AGENT3_SHELL_ENV) != "1":
        return False, f"{ALLOW_AGENT3_SHELL_ENV}=1 is required"
    payload, payload_error = load_payload()
    if payload_error:
        return False, payload_error
    try:
        cwd = payload_cwd(payload)
    except OSError as exc:
        return False, f"invalid shell cwd: {redact_text(exc)}"
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    if not implementation_roots:
        return False, "CLEAN_ROOM_IMPLEMENTATION_ROOTS has no configured roots"
    if not any(path_is_under(cwd, root) for root in implementation_roots):
        return False, f"shell cwd is outside implementation roots: {describe_path(cwd)}"
    command = shell_command_for(payload)
    if command is None:
        return False, "Agent 3 shell command must invoke the verification runner"
    argv, split_error = split_shell_command(command)
    if split_error:
        return False, split_error
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    allowed, reason = command_invokes_runner(argv, cwd, blocked_roots)
    if not allowed:
        return False, reason
    return True, ""


def main() -> int:
    role = os.environ.get("CLEAN_ROOM_ROLE", "")
    if role == AGENT3_ROLE:
        allowed, reason = agent3_shell_allowed()
        if allowed:
            return 0
        print(
            f"clean-room policy denied shell tool use for role {role}: {redact_text(reason)}",
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
