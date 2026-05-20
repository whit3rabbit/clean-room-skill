#!/usr/bin/env python3
"""Explicit local tool setup for clean-room source-index preflight."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any

import clean_room_tooling


LOCAL_INSTALL_TIMEOUT_SECONDS = 600
NPM_TOOLS = {
    "ast-grep": {
        "package": "@ast-grep/cli",
        "source": "https://www.npmjs.com/package/@ast-grep/cli",
        "bin": "ast-grep",
    },
}
STATUS_TOOLS = [
    "node",
    "npm",
    "ast-grep",
    "sg",
    "ctags",
    "universal-ctags",
    "scip",
]
STATUS_PACKAGES = ["@ast-grep/cli"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Report or explicitly install local clean-room source-index helper tools into the user cache."
    )
    parser.add_argument("--status", action="store_true", help="Print tool discovery status as JSON")
    parser.add_argument(
        "--install-local",
        choices=sorted(NPM_TOOLS),
        help="Install one approved npm-backed tool into ~/.cache/re-skills/clean-room-tools/npm",
    )
    parser.add_argument(
        "--version",
        help="Exact npm package version to install. Required with --install-local.",
    )
    parser.add_argument(
        "--allow-npm-scripts",
        action="store_true",
        help="Allow npm lifecycle scripts during local install. Default is --ignore-scripts.",
    )
    parser.add_argument(
        "--allow-working-project-tools",
        action="store_true",
        help="Include project-local .local/bin, .bin, node_modules/.bin, and npm prefix/global tools in --status output.",
    )
    parser.add_argument(
        "--probe-tools",
        action="store_true",
        help="Execute discovered tools with version commands in --status output. Default is stat-only.",
    )
    args = parser.parse_args()
    if not args.status and not args.install_local:
        parser.error("choose --status or --install-local")
    if args.install_local and not args.version:
        parser.error("--install-local requires --version")
    return args


def write_json(data: dict[str, Any]) -> None:
    json.dump(data, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def package_status(allow_project_tools: bool = False) -> dict[str, Any]:
    status: dict[str, Any] = {}
    for package in STATUS_PACKAGES:
        parts = package.split("/")
        checked = [
            (root / "node_modules").joinpath(*parts)
            for root in clean_room_tooling.node_resolver_roots(allow_project_tools)
        ]
        found = next((path for path in checked if path.exists()), None)
        status[package] = (
            clean_room_tooling.observed(found.as_posix())
            if found
            else clean_room_tooling.unknown(
                "package unavailable",
                value={"checked_locations": [path.as_posix() for path in checked]},
            )
        )
    return status


def status_report(allow_project_tools: bool = False, probe_tools: bool = False) -> dict[str, Any]:
    dependency_report = clean_room_tooling.dependency_report(allow_project_tools, probe_tools)
    return {
        "schema_version": 1,
        "policy": dependency_report["external_tools_policy"],
        "tool_probe_mode": dependency_report["tool_probe_mode"],
        "tool_trust_mode": clean_room_tooling.tool_trust_mode(allow_project_tools),
        "local_cache": clean_room_tooling.observed(clean_room_tooling.USER_TOOLS_DIR.as_posix()),
        "installable_local_tools": {
            name: {"package": item["package"], "source": item["source"]}
            for name, item in sorted(NPM_TOOLS.items())
        },
        "tools": {
            name: clean_room_tooling.executable_status(
                name,
                allow_project_tools=allow_project_tools,
                probe_tools=probe_tools,
            )
            for name in STATUS_TOOLS
        },
        "node_packages": package_status(allow_project_tools),
    }


def npm_package_spec(package: str, version: str) -> str:
    return f"{package}@{version}"


def install_npm_tool(tool: str, version: str, allow_npm_scripts: bool = False) -> dict[str, Any]:
    spec = NPM_TOOLS[tool]
    npm = clean_room_tooling.find_executable("npm")
    if npm is None:
        return clean_room_tooling.error_fact(
            "npm unavailable; install Node/npm first or set NPM_BIN",
            evidence={"checked_locations": clean_room_tooling.checked_executable_locations("npm")},
        )

    prefix = clean_room_tooling.USER_NPM_PREFIX
    prefix.mkdir(parents=True, exist_ok=True)
    package_spec = npm_package_spec(str(spec["package"]), version)
    argv = [
        npm.path.as_posix(),
        "install",
        "--prefix",
        prefix.as_posix(),
        "--save-exact",
    ]
    if not allow_npm_scripts:
        argv.append("--ignore-scripts")
    argv.append(package_spec)

    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=LOCAL_INSTALL_TIMEOUT_SECONDS,
        check=False,
    )
    status = "observed" if completed.returncode == 0 else "error"
    result: dict[str, Any] = {
        "schema_version": 1,
        "tool": tool,
        "source": spec["source"],
        "version": version,
        "package_spec": package_spec,
        "install_root": clean_room_tooling.observed(prefix.as_posix()),
        "install_trust_mode": clean_room_tooling.observed(
            "explicit-version",
            evidence={"npm_lifecycle_scripts": "allowed" if allow_npm_scripts else "ignored"},
        ),
        "command": clean_room_tooling.fact(
            status,
            {
                "argv": argv,
                "returncode": completed.returncode,
                "stdout": completed.stdout.strip(),
                "stderr": completed.stderr.strip(),
            },
        ),
    }
    resolved = clean_room_tooling.find_executable(str(spec["bin"]))
    result["resolved_tool"] = (
        clean_room_tooling.observed({"path": resolved.path.as_posix(), "source": resolved.source})
        if resolved
        else clean_room_tooling.unknown("tool installed but executable was not resolved")
    )
    return result


def main() -> int:
    args = parse_args()
    if args.status:
        write_json(status_report(args.allow_working_project_tools, args.probe_tools))
    if args.install_local:
        result = install_npm_tool(args.install_local, args.version, args.allow_npm_scripts)
        write_json(result)
        if result.get("command", {}).get("status") == "error":
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
