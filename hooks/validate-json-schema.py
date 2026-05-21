#!/usr/bin/env python3
"""Lightweight JSON artifact validator for bundled clean-room schemas."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from clean_room_paths import checked_write_paths, load_payload, path_under_env


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
CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV = "CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST"
MAX_REPORTED_ERRORS = 20
MAX_VALIDATION_ERRORS = MAX_REPORTED_ERRORS + 1


def schema_dir() -> Path:
    configured = os.environ.get("CLEAN_ROOM_SCHEMA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[1] / "skills" / "clean-room" / "assets"


def artifact_kind(path: Path, data: dict) -> str | None:
    name = path.name.removesuffix(".json")
    if name in SCHEMA_BY_ARTIFACT:
        return name
    if "spec_id" in data:
        return "behavior-spec"
    if "manifest_id" in data:
        return "skeleton-manifest"
    if "report_id" in data:
        return "qc-report"
    if "package_id" in data:
        return "handoff-package"
    if "incident_id" in data:
        return "contamination-incident"
    if "index_id" in data and data.get("domain") == "contaminated" and "recommended_batches" in data:
        return "source-index"
    if "ledger_id" in data:
        if data.get("domain") == "contaminated" and "entries" in data:
            return "evidence-ledger"
        if {"source_units", "behavior_spec_refs", "coverage_status"} & data.keys():
            return "coverage-ledger"
    if data.get("from_domain") == "contaminated" and data.get("to_domain") == "clean" and "artifacts" in data:
        return "handoff-package"
    for kind in SCHEMA_BY_ARTIFACT:
        if kind in name:
            return kind
    if "task_id" in data:
        return "task-manifest"
    return None


def auxiliary_json_allowed(path: Path) -> tuple[bool, list[str]]:
    errors: list[str] = []
    for item in os.environ.get(CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV, "").split(os.pathsep):
        if not item:
            continue
        try:
            allowed = Path(item).expanduser().resolve()
        except OSError as exc:
            errors.append(f"{CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV} has invalid path {item!r}: {exc}")
            continue
        if not path_under_env(allowed, "CLEAN_ROOM_CLEAN_ROOTS"):
            errors.append(f"{CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV} path is outside CLEAN_ROOM_CLEAN_ROOTS: {allowed}")
            continue
        if path == allowed:
            return True, errors
    return False, errors


def resolve_ref(root_schema: dict, ref: str) -> dict:
    if not ref.startswith("#/"):
        raise ValueError(f"unsupported external schema ref {ref}")
    current: Any = root_schema
    for part in ref[2:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or key not in current:
            raise ValueError(f"unresolvable schema ref {ref}")
        current = current[key]
    if not isinstance(current, dict):
        raise ValueError(f"schema ref {ref} did not resolve to an object")
    return current


def path_label(path: tuple[str | int, ...]) -> str:
    if not path:
        return "<root>"
    return "/" + "/".join(str(part) for part in path)


def type_matches(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def valid_date_time(value: str) -> bool:
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        datetime.fromisoformat(candidate)
    except ValueError:
        return False
    return True


def add_error(errors: list[str], message: str) -> None:
    if len(errors) < MAX_VALIDATION_ERRORS:
        errors.append(message)


def extend_errors(errors: list[str], new_errors: list[str]) -> None:
    remaining = MAX_VALIDATION_ERRORS - len(errors)
    if remaining > 0:
        errors.extend(new_errors[:remaining])


def error_limit_reached(errors: list[str]) -> bool:
    return len(errors) >= MAX_VALIDATION_ERRORS


def validate_combinator(
    value: Any,
    schema: dict,
    root_schema: dict,
    path: tuple[str | int, ...],
    keyword: str,
    require_exactly_one: bool,
) -> list[str]:
    errors: list[str] = []
    subschemas = schema.get(keyword)
    if not isinstance(subschemas, list):
        return errors
    valid_count = 0
    for index, subschema in enumerate(subschemas):
        if not isinstance(subschema, dict):
            add_error(errors, f"{path_label(path)}: {keyword}[{index}] is not a schema object")
            continue
        if not validate_value(value, subschema, root_schema, path):
            valid_count += 1
    if require_exactly_one:
        if valid_count != 1:
            add_error(errors, f"{path_label(path)}: expected exactly one matching oneOf schema")
    elif valid_count == 0:
        add_error(errors, f"{path_label(path)}: expected at least one matching anyOf schema")
    return errors


def validate_value(value: Any, schema: dict, root_schema: dict, path: tuple[str | int, ...] = ()) -> list[str]:
    errors: list[str] = []
    if "$ref" in schema:
        try:
            extend_errors(errors, validate_value(value, resolve_ref(root_schema, schema["$ref"]), root_schema, path))
        except ValueError as exc:
            add_error(errors, f"{path_label(path)}: {exc}")
            return errors
        if error_limit_reached(errors):
            return errors
        schema = {key: item for key, item in schema.items() if key != "$ref"}
        if not schema:
            return errors

    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for index, subschema in enumerate(all_of):
            if isinstance(subschema, dict):
                extend_errors(errors, validate_value(value, subschema, root_schema, path))
            else:
                add_error(errors, f"{path_label(path)}: allOf[{index}] is not a schema object")
            if error_limit_reached(errors):
                return errors

    extend_errors(errors, validate_combinator(value, schema, root_schema, path, "anyOf", False))
    if error_limit_reached(errors):
        return errors
    extend_errors(errors, validate_combinator(value, schema, root_schema, path, "oneOf", True))
    if error_limit_reached(errors):
        return errors

    if_schema = schema.get("if")
    if isinstance(if_schema, dict):
        if_errors = validate_value(value, if_schema, root_schema, path)
        branch_schema = schema.get("then") if not if_errors else schema.get("else")
        if isinstance(branch_schema, dict):
            extend_errors(errors, validate_value(value, branch_schema, root_schema, path))
            if error_limit_reached(errors):
                return errors

    if "const" in schema and value != schema["const"]:
        add_error(errors, f"{path_label(path)}: expected const {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        add_error(errors, f"{path_label(path)}: expected one of {schema['enum']!r}")
    if error_limit_reached(errors):
        return errors

    expected_type = schema.get("type")
    if isinstance(expected_type, str) and not type_matches(value, expected_type):
        add_error(errors, f"{path_label(path)}: expected {expected_type}")
        return errors
    if isinstance(expected_type, list) and not any(type_matches(value, item) for item in expected_type):
        add_error(errors, f"{path_label(path)}: expected one of types {expected_type!r}")
        return errors

    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            for field in required:
                if isinstance(field, str) and field not in value:
                    add_error(errors, f"{path_label(path)}: missing required field {field!r}")
                    if error_limit_reached(errors):
                        return errors

        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for field, field_schema in properties.items():
                if field in value and isinstance(field_schema, dict):
                    extend_errors(errors, validate_value(value[field], field_schema, root_schema, path + (field,)))
                    if error_limit_reached(errors):
                        return errors
            if schema.get("additionalProperties") is False:
                for field in sorted(set(value) - set(properties)):
                    add_error(errors, f"{path_label(path + (field,))}: additional property is not allowed")
                    if error_limit_reached(errors):
                        return errors

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            add_error(errors, f"{path_label(path)}: fewer than minItems {min_items}")
        max_items = schema.get("maxItems")
        if isinstance(max_items, int) and len(value) > max_items:
            add_error(errors, f"{path_label(path)}: more than maxItems {max_items}")
        if error_limit_reached(errors):
            return errors
        if schema.get("uniqueItems") is True:
            seen: set[str] = set()
            for item in value:
                marker = json.dumps(item, sort_keys=True, separators=(",", ":"))
                if marker in seen:
                    add_error(errors, f"{path_label(path)}: duplicate item violates uniqueItems")
                    break
                seen.add(marker)
            if error_limit_reached(errors):
                return errors
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                extend_errors(errors, validate_value(item, item_schema, root_schema, path + (index,)))
                if error_limit_reached(errors):
                    return errors

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            add_error(errors, f"{path_label(path)}: less than minimum {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            add_error(errors, f"{path_label(path)}: greater than maximum {maximum}")
        if error_limit_reached(errors):
            return errors

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(value) < min_length:
            add_error(errors, f"{path_label(path)}: shorter than minLength {min_length}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            add_error(errors, f"{path_label(path)}: does not match pattern {pattern!r}")
        if schema.get("format") == "date-time" and not valid_date_time(value):
            add_error(errors, f"{path_label(path)}: invalid date-time")

    return errors


def main() -> int:
    payload, payload_error = load_payload()
    if payload_error:
        print(f"clean-room schema check failed: {payload_error}", file=sys.stderr)
        return 1
    paths, path_errors = checked_write_paths(payload, "clean-room schema check")
    if path_errors:
        for error in path_errors:
            print(f"clean-room schema check failed: {error}", file=sys.stderr)
        return 1
    for path in paths:
        if path.suffix.lower() != ".json" or not path.is_file():
            continue
        in_clean_root = path_under_env(path, "CLEAN_ROOM_CLEAN_ROOTS")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"clean-room JSON parse failed for {path}: {exc}", file=sys.stderr)
            return 1
        if not isinstance(data, dict):
            if in_clean_root:
                print(f"clean-room schema check failed for {path}: clean JSON artifact must be an object", file=sys.stderr)
                return 1
            continue
        kind = artifact_kind(path, data)
        if not kind:
            allowed, allowlist_errors = auxiliary_json_allowed(path)
            if allowlist_errors:
                for error in allowlist_errors:
                    print(f"clean-room schema check failed: {error}", file=sys.stderr)
                return 1
            if in_clean_root and not allowed:
                print(f"clean-room schema check failed for {path}: unrecognized clean JSON artifact", file=sys.stderr)
                return 1
            continue
        if in_clean_root and kind == "source-index":
            print(f"clean-room schema check failed for {path}: source-index.json is contaminated-only", file=sys.stderr)
            return 1
        schema_path = schema_dir() / SCHEMA_BY_ARTIFACT[kind]
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"clean-room schema load failed for {schema_path}: {exc}", file=sys.stderr)
            return 1
        errors = validate_value(data, schema, schema)
        if errors:
            print(f"clean-room schema check failed for {path}:", file=sys.stderr)
            for error in errors[:MAX_REPORTED_ERRORS]:
                print(f"  {error}", file=sys.stderr)
            if len(errors) > MAX_REPORTED_ERRORS:
                print(f"  ... validation stopped after {MAX_REPORTED_ERRORS} error(s)", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
