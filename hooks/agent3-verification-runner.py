#!/usr/bin/env python3
"""Run Agent 3 verification commands without shell expansion."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
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
BACKENDS = {"host", "docker", "podman"}
CONTAINER_PROFILES = {
    "node22": "clean-room-skill/node22:local",
    "python312": "clean-room-skill/python312:local",
    "go126": "clean-room-skill/go126:local",
    "rust-stable": "clean-room-skill/rust-stable:local",
}
RUN_TYPES = {"verify", "package"}
NETWORK_POLICIES = {"off", "deps-only", "on"}
DEPENDENCY_MODES = {"offline", "locked", "allow-new"}
DEFAULT_CPUS = 2
DEFAULT_MEMORY_MB = 2048
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
CONTAINER_ENV_NAMES = {
    "CI",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "TERM",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", help="Path to clean implementation-plan.json")
    parser.add_argument("--command-index", type=int, help="Zero-based verification command index")
    parser.add_argument("--all", action="store_true", help="Run all verification commands")
    parser.add_argument("--backend", choices=sorted(BACKENDS), default="host")
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


def schema_root() -> Path:
    roots = env_roots("CLEAN_ROOM_SCHEMA_DIR")
    if not roots:
        raise ValueError("CLEAN_ROOM_SCHEMA_DIR has no configured roots")
    return roots[0]


def assert_not_blocked_root(root: Path, blocked_roots: list[Path], label: str) -> None:
    for blocked in blocked_roots:
        if paths_overlap(root, blocked):
            raise ValueError(f"{label} overlaps blocked root: {describe_path(root)}")


def validate_container_mount_roots(cwd: Path, blocked_roots: list[Path]) -> tuple[list[Path], Path, list[Path]]:
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if not clean_roots:
        raise ValueError("CLEAN_ROOM_CLEAN_ROOTS has no configured roots")
    refs = env_roots("CLEAN_ROOM_ALLOWED_READ_ROOTS")
    schemas = schema_root()
    for index, root in enumerate(clean_roots):
        assert_not_blocked_root(root, blocked_roots, f"clean root {index}")
    for index, root in enumerate(refs):
        assert_not_blocked_root(root, blocked_roots, f"allowed reference root {index}")
    assert_not_blocked_root(schemas, blocked_roots, "schema root")
    assert_not_blocked_root(cwd, blocked_roots, "implementation root")
    return clean_roots, schemas, refs


def load_clean_run_context(clean_roots: list[Path], blocked_roots: list[Path]) -> dict[str, Any]:
    for root in clean_roots:
        path = (root / "clean-run-context.json").resolve()
        if any(path_is_under(path, blocked) for blocked in blocked_roots):
            raise ValueError("clean-run-context path is under a blocked root")
        if path.is_file():
            data = load_json(path)
            return data if isinstance(data, dict) else {}
    return {}


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


def optional_string_field(command: dict[str, Any], field: str, allowed: set[str]) -> str | None:
    value = command.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"verification command {field} is not supported")
    return value


def command_timeout(command: dict[str, Any], fallback: int) -> int:
    value = command.get("timeout_seconds")
    if value is None:
        return fallback
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > MAX_TIMEOUT_SECONDS:
        raise ValueError(f"verification command timeout_seconds must be between 1 and {MAX_TIMEOUT_SECONDS}")
    return value


def execution_policy(context: dict[str, Any]) -> dict[str, Any]:
    policy = context.get("execution_policy")
    return policy if isinstance(policy, dict) else {}


def execution_resource_limits(policy: dict[str, Any]) -> dict[str, Any]:
    limits = policy.get("resource_limits")
    return limits if isinstance(limits, dict) else {}


def policy_string(policy: dict[str, Any], field: str, allowed: set[str], default: str) -> str:
    value = policy.get(field, default)
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"execution_policy.{field} is not supported")
    return value


def policy_positive_number(policy: dict[str, Any], field: str, default: int | float, upper: int) -> int | float:
    value = policy.get(field, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 1 or value > upper:
        raise ValueError(f"execution_policy.resource_limits.{field} must be between 1 and {upper}")
    return value


def policy_timeout(limits: dict[str, Any], fallback: int) -> int:
    value = limits.get("timeout_seconds", fallback)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > MAX_TIMEOUT_SECONDS:
        raise ValueError(f"execution_policy.resource_limits.timeout_seconds must be between 1 and {MAX_TIMEOUT_SECONDS}")
    return value


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


def container_env_values(blocked_roots: list[Path]) -> dict[str, str]:
    env = {name: os.environ[name] for name in CONTAINER_ENV_NAMES if name in os.environ}
    for name, value in env.items():
        if has_blocked_substring(value, blocked_roots):
            raise ValueError(f"container environment variable {name} references a blocked root")
    env["CLEAN_ROOM_AGENT3_VERIFY"] = "1"
    env["HOME"] = "/tmp"
    env["TMPDIR"] = "/tmp"
    return env


def bind_mount_arg(source: Path, target: str, mode: str) -> str:
    return f"{source}:{target}:{mode}"


def container_command_settings(
    command: dict[str, Any],
    context: dict[str, Any],
    fallback_timeout: int,
) -> tuple[str, str, str, str, int, float, int]:
    policy = execution_policy(context)
    limits = execution_resource_limits(policy)
    optional_string_field(command, "run_type", RUN_TYPES)
    profile = command.get("container_profile")
    if profile is None:
        profile = policy_string(policy, "preferred_container_profile", set(CONTAINER_PROFILES), "")
    if not isinstance(profile, str) or profile not in CONTAINER_PROFILES:
        raise ValueError("verification command container_profile is required for container backend")
    network = command.get("network")
    if network is None:
        network = policy_string(policy, "network_policy", NETWORK_POLICIES, "off")
    if not isinstance(network, str) or network not in NETWORK_POLICIES:
        raise ValueError("verification command network is not supported")
    dependency_mode = command.get("dependency_mode")
    if dependency_mode is None:
        dependency_mode = policy_string(policy, "dependency_install_policy", DEPENDENCY_MODES, "offline")
    if not isinstance(dependency_mode, str) or dependency_mode not in DEPENDENCY_MODES:
        raise ValueError("verification command dependency_mode is not supported")
    if network != "off":
        raise ValueError("container verification currently supports network=off only")
    if dependency_mode == "allow-new":
        raise ValueError("container verification currently rejects dependency_mode=allow-new")
    timeout = command_timeout(command, policy_timeout(limits, fallback_timeout))
    cpus = policy_positive_number(limits, "cpus", DEFAULT_CPUS, 16)
    memory_mb = policy_positive_number(limits, "memory_mb", DEFAULT_MEMORY_MB, 65536)
    if not isinstance(memory_mb, int):
        raise ValueError("execution_policy.resource_limits.memory_mb must be an integer")
    return profile, CONTAINER_PROFILES[profile], network, dependency_mode, timeout, cpus, memory_mb


def container_executable(backend: str) -> str:
    resolved = shutil.which(backend)
    if not resolved:
        raise ValueError(f"{backend} executable was not found")
    return resolved


def build_container_argv(
    backend: str,
    command: dict[str, Any],
    argv: list[str],
    cwd: Path,
    clean_roots: list[Path],
    schema_dir: Path,
    refs: list[Path],
    blocked_roots: list[Path],
    context: dict[str, Any],
    fallback_timeout: int,
) -> tuple[list[str], int]:
    profile, image, network, _dependency_mode, timeout, cpus, memory_mb = container_command_settings(
        command,
        context,
        fallback_timeout,
    )
    runtime_network = "none" if network == "off" else network
    validate_container_mount_roots(cwd, blocked_roots)
    container_argv = [
        container_executable(backend),
        "run",
        "--rm",
        "--network",
        runtime_network,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--memory",
        f"{memory_mb}m",
        "--cpus",
        str(cpus),
        "--user",
        "1000:1000",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=512m",
        "--workdir",
        "/work",
        "--volume",
        bind_mount_arg(cwd, "/work", "rw"),
    ]
    for index, root in enumerate(clean_roots):
        target = "/clean" if index == 0 else f"/clean-{index}"
        container_argv.extend(["--volume", bind_mount_arg(root, target, "ro")])
    container_argv.extend(["--volume", bind_mount_arg(schema_dir, "/schemas", "ro")])
    for index, root in enumerate(refs):
        container_argv.extend(["--volume", bind_mount_arg(root, f"/refs/{index}", "ro")])
    for name, value in container_env_values(blocked_roots).items():
        container_argv.extend(["--env", f"{name}={value}"])
    container_argv.extend(["--label", f"clean-room.container-profile={profile}", image, *argv])
    return container_argv, timeout


def print_bounded(label: str, text: str) -> None:
    if not text:
        return
    if len(text) > MAX_OUTPUT_CHARS:
        text = f"{text[:MAX_OUTPUT_CHARS]}\n[{label} truncated at {MAX_OUTPUT_CHARS} characters]\n"
    stream = sys.stdout if label == "stdout" else sys.stderr
    print(text, end="" if text.endswith("\n") else "\n", file=stream)


def run_command(
    command: dict[str, Any],
    implementation_roots: list[Path],
    blocked_roots: list[Path],
    backend: str,
    timeout: int,
    context: dict[str, Any],
) -> int:
    cwd = command_cwd(command, implementation_roots)
    argv = command_argv(command)
    if not allowed_prefix(argv):
        raise ValueError("verification command is not in the allowlist")
    validate_arg_paths(argv, cwd, blocked_roots)
    effective_timeout = command_timeout(command, timeout)
    run_argv = argv
    run_cwd = cwd
    if backend != "host":
        clean_roots, schemas, refs = validate_container_mount_roots(cwd, blocked_roots)
        run_argv, effective_timeout = build_container_argv(
            backend,
            command,
            argv,
            cwd,
            clean_roots,
            schemas,
            refs,
            blocked_roots,
            context,
            timeout,
        )
        run_cwd = Path.cwd().resolve()
    result = subprocess.run(
        run_argv,
        cwd=str(run_cwd),
        env=sanitized_env(blocked_roots),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=effective_timeout,
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
        clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
        context = load_clean_run_context(clean_roots, blocked_roots) if args.backend != "host" else {}
    except IndexError:
        return fail("verification command index is out of range")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return fail(str(exc))

    status = 0
    for command in selected:
        try:
            status |= run_command(command, implementation_roots, blocked_roots, args.backend, args.timeout, context)
        except subprocess.TimeoutExpired:
            return fail("verification command timed out")
        except (OSError, ValueError) as exc:
            return fail(str(exc))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
