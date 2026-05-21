#!/usr/bin/env python3
"""Run Agent 3 verification commands without shell expansion."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from clean_room_paths import describe_path, env_roots, path_is_under, paths_overlap, redact_text


AGENT3_ROLE = "clean-qa-editor"
ALLOW_AGENT3_SHELL_ENV = "CLEAN_ROOM_ALLOW_AGENT3_SHELL"
DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 600
MAX_OUTPUT_CHARS = 40_000
IMPLEMENTATION_REF = re.compile(r"^CLEAN_ROOM_IMPLEMENTATION_ROOTS\[([0-9]+)\]$")
SHELL_TOKEN_RE = re.compile(r"[|&;<>`$]|\$\(|\$\{|\r|\n")
SAFE_ENV_NAMES = {
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "PATH",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
}
ALLOWED_ARGV_PREFIXES = (
    ("npm", "test"),
    ("npm", "run", "test"),
    ("pnpm", "test"),
    ("pnpm", "run", "test"),
    ("yarn", "test"),
    ("yarn", "run", "test"),
    ("bun", "test"),
    ("deno", "test"),
    ("pytest",),
    ("python", "-m", "pytest"),
    ("python3", "-m", "pytest"),
    ("cargo", "test"),
    ("go", "test"),
    ("zig", "build", "test"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", help="Path to clean implementation-plan.json")
    parser.add_argument("--command-index", type=int, help="Zero-based verification command index")
    parser.add_argument("--all", action="store_true", help="Run all verification commands")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    if args.all == (args.command_index is not None):
        parser.error("set exactly one of --all or --command-index")
    if args.timeout < 1 or args.timeout > MAX_TIMEOUT_SECONDS:
        parser.error(f"--timeout must be between 1 and {MAX_TIMEOUT_SECONDS}")
    return args


def fail(message: str) -> int:
    print(f"clean-room Agent 3 verification denied: {redact_text(message)}", file=sys.stderr)
    return 1


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def default_plan_path() -> Path:
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if not clean_roots:
        raise ValueError("CLEAN_ROOM_CLEAN_ROOTS has no configured roots")
    return clean_roots[0] / "implementation-plan.json"


def validate_runner_environment() -> tuple[list[Path], list[Path]]:
    if os.environ.get("CLEAN_ROOM_ROLE") != AGENT3_ROLE:
        raise ValueError("CLEAN_ROOM_ROLE must be clean-qa-editor")
    if os.environ.get(ALLOW_AGENT3_SHELL_ENV) != "1":
        raise ValueError(f"{ALLOW_AGENT3_SHELL_ENV}=1 is required")
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    if not implementation_roots:
        raise ValueError("CLEAN_ROOM_IMPLEMENTATION_ROOTS has no configured roots")
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    for root in implementation_roots:
        for blocked in blocked_roots:
            if paths_overlap(root, blocked):
                raise ValueError(f"implementation root overlaps blocked root: {describe_path(root)}")
    return implementation_roots, blocked_roots


def resolve_plan_path(raw_plan: str | None, blocked_roots: list[Path]) -> Path:
    path = Path(raw_plan).expanduser().resolve() if raw_plan else default_plan_path().resolve()
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if not any(path_is_under(path, root) for root in clean_roots):
        raise ValueError(f"plan path is outside clean roots: {describe_path(path)}")
    if any(path_is_under(path, root) for root in blocked_roots):
        raise ValueError(f"plan path is under a blocked root: {describe_path(path)}")
    return path


def flatten_verification_commands(plan: dict[str, Any]) -> list[dict[str, Any]]:
    commands: list[dict[str, Any]] = []
    for item in plan.get("verification_strategy", []):
        if isinstance(item, dict):
            commands.append(item)
    for work_item in plan.get("work_items", []):
        if not isinstance(work_item, dict):
            continue
        for item in work_item.get("verification_commands", []):
            if isinstance(item, dict):
                commands.append(item)
    return commands


def command_cwd(command: dict[str, Any], implementation_roots: list[Path]) -> Path:
    raw = command.get("cwd")
    if not isinstance(raw, str):
        raise ValueError("verification command cwd must be an implementation root ref")
    match = IMPLEMENTATION_REF.match(raw)
    if not match:
        raise ValueError("verification command cwd must use CLEAN_ROOM_IMPLEMENTATION_ROOTS[n]")
    index = int(match.group(1))
    if index >= len(implementation_roots):
        raise ValueError("verification command cwd references a missing implementation root")
    return implementation_roots[index]


def command_argv(command: dict[str, Any]) -> list[str]:
    raw = command.get("command")
    if not isinstance(raw, list) or not raw:
        raise ValueError("verification command must be a non-empty argv array")
    argv: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item:
            raise ValueError("verification command argv entries must be non-empty strings")
        argv.append(item)
    return argv


def executable_name(value: str) -> str:
    return Path(value).name


def allowed_prefix(argv: list[str]) -> bool:
    if "/" in argv[0] or "\\" in argv[0]:
        return False
    normalized = [executable_name(argv[0]), *argv[1:]]
    return any(tuple(normalized[: len(prefix)]) == prefix for prefix in ALLOWED_ARGV_PREFIXES)


def has_blocked_substring(value: str, blocked_roots: list[Path]) -> bool:
    return any(str(root) in value for root in blocked_roots)


def looks_path_like(value: str) -> bool:
    return (
        value.startswith(("/", "~", "."))
        or "/" in value
        or "\\" in value
        or value.startswith("file:")
    )


def validate_arg_paths(argv: list[str], cwd: Path, blocked_roots: list[Path]) -> None:
    for arg in argv:
        if SHELL_TOKEN_RE.search(arg):
            raise ValueError("verification argv contains shell syntax")
        if has_blocked_substring(arg, blocked_roots):
            raise ValueError("verification argv references a blocked root")
        if arg.startswith("file:"):
            raise ValueError("file URLs are not allowed in verification argv")
        if not looks_path_like(arg):
            continue
        candidate = Path(arg).expanduser()
        resolved = candidate.resolve() if candidate.is_absolute() else (cwd / candidate).resolve()
        if any(path_is_under(resolved, root) for root in blocked_roots):
            raise ValueError(f"verification argv resolves into a blocked root: {describe_path(resolved)}")
        if not path_is_under(resolved, cwd):
            raise ValueError(f"verification argv path is outside implementation root: {describe_path(resolved)}")


def sanitized_env(blocked_roots: list[Path]) -> dict[str, str]:
    env = {name: os.environ[name] for name in SAFE_ENV_NAMES if name in os.environ}
    for name, value in env.items():
        if has_blocked_substring(value, blocked_roots):
            raise ValueError(f"safe environment variable {name} references a blocked root")
    env["CLEAN_ROOM_AGENT3_VERIFY"] = "1"
    return env


def print_bounded(label: str, text: str) -> None:
    if not text:
        return
    if len(text) > MAX_OUTPUT_CHARS:
        text = f"{text[:MAX_OUTPUT_CHARS]}\n[{label} truncated at {MAX_OUTPUT_CHARS} characters]\n"
    stream = sys.stdout if label == "stdout" else sys.stderr
    print(text, end="" if text.endswith("\n") else "\n", file=stream)


def run_command(command: dict[str, Any], implementation_roots: list[Path], blocked_roots: list[Path], timeout: int) -> int:
    cwd = command_cwd(command, implementation_roots)
    argv = command_argv(command)
    if not allowed_prefix(argv):
        raise ValueError("verification command is not in the allowlist")
    validate_arg_paths(argv, cwd, blocked_roots)
    result = subprocess.run(
        argv,
        cwd=str(cwd),
        env=sanitized_env(blocked_roots),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        shell=False,
        check=False,
    )
    print_bounded("stdout", result.stdout)
    print_bounded("stderr", result.stderr)
    return result.returncode


def main() -> int:
    args = parse_args()
    try:
        implementation_roots, blocked_roots = validate_runner_environment()
        plan_path = resolve_plan_path(args.plan, blocked_roots)
        plan = load_json(plan_path)
        if not isinstance(plan, dict):
            return fail("implementation plan must be a JSON object")
        commands = flatten_verification_commands(plan)
        if not commands:
            return fail("implementation plan has no verification commands")
        selected = commands if args.all else [commands[args.command_index]]
    except IndexError:
        return fail("verification command index is out of range")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return fail(str(exc))

    status = 0
    for command in selected:
        try:
            status |= run_command(command, implementation_roots, blocked_roots, args.timeout)
        except subprocess.TimeoutExpired:
            return fail("verification command timed out")
        except (OSError, ValueError) as exc:
            return fail(str(exc))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
