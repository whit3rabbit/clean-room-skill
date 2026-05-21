#!/usr/bin/env python3
"""Validate clean-room example artifacts with jsonschema Draft 2020-12."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

try:
    import jsonschema
except ImportError:  # pragma: no cover - exercised by missing local dependency.
    print("jsonschema is required; install with: python3 -m pip install 'jsonschema[format]>=4.18,<5'", file=sys.stderr)
    raise SystemExit(2)


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "skills" / "clean-room" / "assets"
EXAMPLE_DIR = ROOT / "skills" / "clean-room" / "examples" / "minimal-spec-package"
EXAMPLE_DIRS = [
    EXAMPLE_DIR,
    ROOT / "skills" / "clean-room" / "examples" / "valid-handoff-package",
]
NEGATIVE_DIR = ROOT / "tests" / "fixtures" / "jsonschema-negative"
SCHEMA_BY_ARTIFACT = {
    "task-manifest": "task-manifest.schema.json",
    "behavior-spec": "behavior-spec.schema.json",
    "skeleton-manifest": "skeleton-manifest.schema.json",
    "qc-report": "qc-report.schema.json",
    "coverage-ledger": "coverage-ledger.schema.json",
    "evidence-ledger": "evidence-ledger.schema.json",
    "source-index": "source-index.schema.json",
    "handoff-package": "handoff-package.schema.json",
    "contamination-incident": "contamination-incident.schema.json",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--examples", action="store_true", help="Validate bundled positive examples")
    parser.add_argument("--negative", action="store_true", help="Validate negative fixtures fail")
    args = parser.parse_args()
    if not args.examples and not args.negative:
        args.examples = True
        args.negative = True
    return args


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def schema_for(kind: str) -> dict[str, Any]:
    schema_name = SCHEMA_BY_ARTIFACT.get(kind)
    if schema_name is None:
        raise ValueError(f"unknown artifact schema kind: {kind}")
    schema = load_json(SCHEMA_DIR / schema_name)
    jsonschema.Draft202012Validator.check_schema(schema)
    return schema


def artifact_kind(path: Path) -> str:
    kind = path.name.removesuffix(".json")
    if kind not in SCHEMA_BY_ARTIFACT:
        raise ValueError(f"no schema mapping for artifact example: {path}")
    return kind


def validator_for(kind: str) -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator(schema_for(kind), format_checker=jsonschema.FormatChecker())


def require_format_assertions() -> None:
    checker = jsonschema.FormatChecker()
    try:
        checker.check("not-a-date", "date-time")
    except jsonschema.exceptions.FormatError:
        return
    print(
        "jsonschema date-time format assertions are unavailable; "
        "install with: python3 -m pip install 'jsonschema[format]>=4.18,<5'",
        file=sys.stderr,
    )
    raise SystemExit(2)


def error_label(error: jsonschema.ValidationError) -> str:
    location = "/" + "/".join(str(part) for part in error.absolute_path)
    if location == "/":
        location = "<root>"
    return f"{location}: {error.message}"


def sorted_errors(validator: jsonschema.Draft202012Validator, instance: Any) -> list[jsonschema.ValidationError]:
    return sorted(validator.iter_errors(instance), key=lambda error: [str(part) for part in error.absolute_path])


def validate_examples() -> int:
    failures: list[str] = []
    for example_dir in EXAMPLE_DIRS:
        for path in sorted(example_dir.glob("*.json")):
            kind = artifact_kind(path)
            errors = sorted_errors(validator_for(kind), load_json(path))
            if errors:
                failures.append(f"{path.relative_to(ROOT)} failed {kind} schema:")
                failures.extend(f"  {error_label(error)}" for error in errors[:10])
                if len(errors) > 10:
                    failures.append(f"  ... {len(errors) - 10} more error(s)")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


def path_get(root: Any, path: list[str | int]) -> Any:
    current = root
    for part in path:
        current = current[part]
    return current


def path_set(root: Any, path: list[str | int], value: Any) -> None:
    parent = path_get(root, path[:-1]) if path[:-1] else root
    parent[path[-1]] = value


def path_remove(root: Any, path: list[str | int]) -> None:
    parent = path_get(root, path[:-1]) if path[:-1] else root
    del parent[path[-1]]


def bundled_example_name(value: Any) -> str:
    if not isinstance(value, str) or value.startswith("."):
        raise ValueError("negative fixture base must name a bundled example JSON file")
    for candidate in (PurePosixPath(value), PureWindowsPath(value)):
        if len(candidate.parts) != 1 or candidate.parts[0] in {"", ".", ".."}:
            raise ValueError("negative fixture base must name a bundled example JSON file")
    return value


def negative_instance(fixture: dict[str, Any]) -> Any:
    base_name = bundled_example_name(fixture.get("base"))
    instance = copy.deepcopy(load_json(EXAMPLE_DIR / base_name))
    for path in fixture.get("remove", []):
        path_remove(instance, path)
    for patch in fixture.get("set", []):
        path_set(instance, patch["path"], patch["value"])
    return instance


def validate_negative_fixtures() -> int:
    failures: list[str] = []
    fixture_paths = sorted(NEGATIVE_DIR.glob("*.json"))
    if not fixture_paths:
        print(f"no negative fixtures found under {NEGATIVE_DIR.relative_to(ROOT)}", file=sys.stderr)
        return 1
    for path in fixture_paths:
        fixture = load_json(path)
        kind = fixture.get("schema_kind")
        expected = fixture.get("expected_error")
        if not isinstance(kind, str) or not isinstance(expected, str) or not expected:
            failures.append(f"{path.relative_to(ROOT)} must set schema_kind and expected_error")
            continue
        try:
            errors = sorted_errors(validator_for(kind), negative_instance(fixture))
        except Exception as exc:
            failures.append(f"{path.relative_to(ROOT)} fixture setup failed: {exc}")
            continue
        labels = [error_label(error) for error in errors]
        if not errors:
            failures.append(f"{path.relative_to(ROOT)} unexpectedly passed {kind} schema")
            continue
        if not any(expected in label for label in labels):
            failures.append(f"{path.relative_to(ROOT)} failed for an unexpected reason:")
            failures.extend(f"  {label}" for label in labels[:10])
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


def main() -> int:
    args = parse_args()
    require_format_assertions()
    status = 0
    if args.examples:
        status |= validate_examples()
    if args.negative:
        status |= validate_negative_fixtures()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
