#!/usr/bin/env python3
"""Run bounded Agent 4 polish verification and local git commit operations."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from clean_room_paths import describe_path, env_roots, path_is_under, paths_overlap, redact_text


AGENT4_ROLE = "clean-polish-reviewer"
ALLOW_AGENT4_SHELL_ENV = "CLEAN_ROOM_ALLOW_AGENT4_SHELL"
DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 600
MAX_OUTPUT_CHARS = 40_000
IMPLEMENTATION_REF = re.compile(r"^CLEAN_ROOM_IMPLEMENTATION_ROOTS\[([0-9]+)\]$")
SHELL_TOKEN_RE = re.compile(r"[|&;<>`$]|\$\(|\$\{|\r|\n")
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", help="Path to clean polish-report.json")
    parser.add_argument("--init-git", action="store_true", help="Initialize git in the implementation root if needed")
    parser.add_argument("--status", action="store_true", help="Print bounded git status for the implementation root")
    parser.add_argument("--verify-index", type=int, help="Zero-based polish verification command index")
    parser.add_argument("--verify-all", action="store_true", help="Run all polish verification commands")
    parser.add_argument("--commit", action="store_true", help="Commit paths listed in polish-report.json")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    actions = [args.init_git, args.status, args.verify_index is not None, args.verify_all, args.commit]
    if not any(actions):
        parser.error("set at least one action")
    if args.verify_index is not None and args.verify_all:
        parser.error("set only one of --verify-index or --verify-all")
    if args.timeout < 1 or args.timeout > MAX_TIMEOUT_SECONDS:
        parser.error(f"--timeout must be between 1 and {MAX_TIMEOUT_SECONDS}")
    return args


def fail(message: str) -> int:
    print(f"clean-room Agent 4 polish denied: {redact_text(message)}", file=sys.stderr)
    return 1


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def default_report_path() -> Path:
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if not clean_roots:
        raise ValueError("CLEAN_ROOM_CLEAN_ROOTS has no configured roots")
    return clean_roots[0] / "polish-report.json"


def validate_environment() -> tuple[list[Path], list[Path], Path]:
    if os.environ.get("CLEAN_ROOM_ROLE") != AGENT4_ROLE:
        raise ValueError("CLEAN_ROOM_ROLE must be clean-polish-reviewer")
    if os.environ.get(ALLOW_AGENT4_SHELL_ENV) != "1":
        raise ValueError(f"{ALLOW_AGENT4_SHELL_ENV}=1 is required")
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    if not implementation_roots:
        raise ValueError("CLEAN_ROOM_IMPLEMENTATION_ROOTS has no configured roots")
    cwd = Path.cwd().resolve()
    matching_roots = [root for root in implementation_roots if path_is_under(cwd, root)]
    if not matching_roots:
        raise ValueError(f"cwd is outside implementation roots: {describe_path(cwd)}")
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    for root in implementation_roots:
        for blocked in blocked_roots:
            if paths_overlap(root, blocked):
                raise ValueError(f"implementation root overlaps blocked root: {describe_path(root)}")
    return implementation_roots, blocked_roots, matching_roots[0]


def resolve_report_path(raw_report: str | None, blocked_roots: list[Path]) -> Path:
    path = Path(raw_report).expanduser().resolve() if raw_report else default_report_path().resolve()
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if not any(path_is_under(path, root) for root in clean_roots):
        raise ValueError(f"polish report path is outside clean roots: {describe_path(path)}")
    if any(path_is_under(path, root) for root in blocked_roots):
        raise ValueError(f"polish report path is under a blocked root: {describe_path(path)}")
    return path


def has_blocked_substring(value: str, blocked_roots: list[Path]) -> bool:
    return any(str(root) in value for root in blocked_roots)


def safe_env(blocked_roots: list[Path]) -> dict[str, str]:
    env = {name: value for name, value in os.environ.items() if name in SAFE_ENV_NAMES}
    for name, value in env.items():
        if has_blocked_substring(value, blocked_roots):
            raise ValueError(f"safe environment variable {name} references a blocked root")
    return env


def run_command(argv: list[str], cwd: Path, timeout: int, blocked_roots: list[Path]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        env=safe_env(blocked_roots),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        timeout=timeout,
        check=False,
    )


def bounded(value: str) -> str:
    if len(value) <= MAX_OUTPUT_CHARS:
        return value
    return value[:MAX_OUTPUT_CHARS] + "\n[truncated]"


def git(argv: list[str], cwd: Path, timeout: int, blocked_roots: list[Path]) -> subprocess.CompletedProcess[str]:
    return run_command(["git", *argv], cwd, timeout, blocked_roots)


def ensure_git_repo(root: Path, timeout: int, blocked_roots: list[Path]) -> None:
    if (root / ".git").exists():
        return
    result = git(["init"], root, timeout, blocked_roots)
    if result.returncode != 0:
        raise ValueError(f"git init failed: {bounded(result.stderr or result.stdout)}")


def git_status(root: Path, timeout: int, blocked_roots: list[Path]) -> dict[str, Any]:
    if not (root / ".git").exists():
        return {"git_initialized": False, "porcelain": ""}
    result = git(["status", "--short"], root, timeout, blocked_roots)
    if result.returncode != 0:
        raise ValueError(f"git status failed: {bounded(result.stderr or result.stdout)}")
    return {"git_initialized": True, "porcelain": bounded(result.stdout)}


def validate_relative_path(raw_path: str) -> str:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("polish report path entries must be non-empty strings")
    for candidate in (PurePosixPath(raw_path), PureWindowsPath(raw_path)):
        if candidate.is_absolute() or candidate.drive:
            raise ValueError("polish report path entries must be relative")
    path = PurePosixPath(raw_path.replace("\\", "/"))
    if ".." in path.parts or ".git" in path.parts:
        raise ValueError("polish report path entries must not contain '..' or '.git'")
    return str(path)


def report_commit_paths(report: dict[str, Any]) -> list[str]:
    git_policy = report.get("git") if isinstance(report.get("git"), dict) else {}
    explicit_paths = git_policy.get("include_paths")
    raw_paths = explicit_paths if isinstance(explicit_paths, list) and explicit_paths else [
        item.get("path")
        for item in report.get("changed_paths", [])
        if isinstance(item, dict)
    ]
    paths: list[str] = []
    seen = set()
    for raw_path in raw_paths:
        rel_path = validate_relative_path(raw_path)
        if rel_path not in seen:
            paths.append(rel_path)
            seen.add(rel_path)
    return paths


def assert_paths_under_root(paths: list[str], root: Path, blocked_roots: list[Path]) -> None:
    for rel_path in paths:
        resolved = (root / rel_path).resolve()
        if not path_is_under(resolved, root):
            raise ValueError(f"commit path escapes implementation root: {rel_path}")
        if any(path_is_under(resolved, blocked) for blocked in blocked_roots):
            raise ValueError(f"commit path is under a blocked root: {rel_path}")


def sanitize_commit_message(report: dict[str, Any]) -> tuple[str, str]:
    git_policy = report.get("git") if isinstance(report.get("git"), dict) else {}
    raw_message = git_policy.get("commit_message") if isinstance(git_policy.get("commit_message"), str) else ""
    spec_slice = str(report.get("spec_slice_ref") or os.environ.get("CLEAN_ROOM_SPEC_SLICE_REF") or "unknown")
    task_id = str(report.get("task_id") or "unknown")
    unit_id = str(report.get("unit_id") or os.environ.get("CLEAN_ROOM_SELECTED_UNIT_ID") or "unknown")
    if raw_message.strip():
        lines = [line.strip() for line in raw_message.strip().splitlines()]
        subject = lines[0]
        body = "\n".join(line for line in lines[1:] if line)
    else:
        subject = f"Complete clean-room spec slice {spec_slice}"
        body = ""
    blocked_text = "\n".join([subject, body])
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    if any(str(root) in blocked_text for root in blocked_roots) or "file:" in blocked_text:
        raise ValueError("commit message references blocked material")
    verification_summary = "verification recorded in polish-report.json"
    if isinstance(report.get("verification_results"), list):
        passed = sum(1 for item in report["verification_results"] if isinstance(item, dict) and item.get("status") == "passed")
        failed = sum(1 for item in report["verification_results"] if isinstance(item, dict) and item.get("status") == "failed")
        verification_summary = f"verification passed={passed} failed={failed}"
    default_body = "\n".join([
        f"Task: {task_id}",
        f"Unit: {unit_id}",
        verification_summary,
        "Reviewer: clean-polish-reviewer",
    ])
    return subject, "\n\n".join(part for part in [body, default_body] if part)


def commit_report_paths(report: dict[str, Any], root: Path, blocked_roots: list[Path], timeout: int) -> dict[str, Any]:
    ensure_git_repo(root, timeout, blocked_roots)
    paths = report_commit_paths(report)
    if not paths:
        raise ValueError("polish report does not list paths to commit")
    assert_paths_under_root(paths, root, blocked_roots)
    add_result = git(["add", "--", *paths], root, timeout, blocked_roots)
    if add_result.returncode != 0:
        raise ValueError(f"git add failed: {bounded(add_result.stderr or add_result.stdout)}")
    diff_result = git(["diff", "--cached", "--quiet"], root, timeout, blocked_roots)
    if diff_result.returncode == 0:
        raise ValueError("no staged implementation-root changes to commit")
    if diff_result.returncode > 1:
        raise ValueError(f"git diff failed: {bounded(diff_result.stderr or diff_result.stdout)}")
    subject, body = sanitize_commit_message(report)
    commit_result = git([
        "-c",
        "user.name=Clean Room Agent 4",
        "-c",
        "user.email=clean-room-agent4@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-verify",
        "-m",
        subject,
        "-m",
        body,
    ], root, timeout, blocked_roots)
    if commit_result.returncode != 0:
        raise ValueError(f"git commit failed: {bounded(commit_result.stderr or commit_result.stdout)}")
    hash_result = git(["rev-parse", "HEAD"], root, timeout, blocked_roots)
    if hash_result.returncode != 0:
        raise ValueError(f"git rev-parse failed: {bounded(hash_result.stderr or hash_result.stdout)}")
    return {
        "commit_status": "committed",
        "commit_hash": hash_result.stdout.strip(),
        "staged_paths": paths,
    }


def command_allowed(command: list[str]) -> bool:
    if not command or any(not isinstance(item, str) or not item for item in command):
        return False
    if any(SHELL_TOKEN_RE.search(item) for item in command):
        return False
    return any(tuple(command[: len(prefix)]) == prefix for prefix in ALLOWED_ARGV_PREFIXES)


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


def resolve_command_cwd(raw_cwd: str, implementation_roots: list[Path]) -> Path:
    match = IMPLEMENTATION_REF.fullmatch(raw_cwd or "")
    if not match:
        raise ValueError("verification cwd must be CLEAN_ROOM_IMPLEMENTATION_ROOTS[n]")
    index = int(match.group(1))
    if index >= len(implementation_roots):
        raise ValueError("verification cwd references missing implementation root")
    return implementation_roots[index]


def verification_commands(report: dict[str, Any]) -> list[dict[str, Any]]:
    commands = []
    for item in report.get("verification_results", []):
        if isinstance(item, dict) and isinstance(item.get("command"), list):
            commands.append(item)
    return commands


def run_verification(report: dict[str, Any], implementation_roots: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:
    commands = verification_commands(report)
    if args.verify_index is not None:
        if args.verify_index < 0 or args.verify_index >= len(commands):
            raise ValueError("--verify-index is outside verification_results")
        selected = [(args.verify_index, commands[args.verify_index])]
    elif args.verify_all:
        selected = list(enumerate(commands))
    else:
        return []
    results = []
    for index, item in selected:
        command = item.get("command")
        if not command_allowed(command):
            raise ValueError("verification command is not in the Agent 4 allowlist")
        cwd = resolve_command_cwd(item.get("cwd"), implementation_roots)
        validate_arg_paths(command, cwd, env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS"))
        result = run_command(command, cwd, args.timeout, env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS"))
        results.append({
            "index": index,
            "status": "passed" if result.returncode == 0 else "failed",
            "exit_code": result.returncode,
            "stdout": bounded(result.stdout),
            "stderr": bounded(result.stderr),
        })
    return results


def main() -> int:
    args = parse_args()
    try:
        implementation_roots, blocked_roots, implementation_root = validate_environment()
        report_path = resolve_report_path(args.report, blocked_roots)
        report = load_json(report_path) if report_path.exists() else {}
        output: dict[str, Any] = {}
        if args.init_git:
            ensure_git_repo(implementation_root, args.timeout, blocked_roots)
            output["git_initialized"] = True
        if args.status:
            output["status"] = git_status(implementation_root, args.timeout, blocked_roots)
        verification = run_verification(report, implementation_roots, args)
        if verification:
            output["verification"] = verification
        if args.commit:
            output["commit"] = commit_report_paths(report, implementation_root, blocked_roots, args.timeout)
        print(json.dumps(output, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        return fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
