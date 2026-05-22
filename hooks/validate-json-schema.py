#!/usr/bin/env python3
"""Lightweight JSON artifact validator for bundled clean-room schemas."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from clean_room_paths import (
    checked_write_paths,
    describe_path,
    env_roots,
    load_payload,
    path_is_under,
    path_under_env,
    redact_text,
    read_artifact_text,
)


SCHEMA_BY_ARTIFACT = {
    "init-config": "init-config.schema.json",
    "preflight-goal": "preflight-goal.schema.json",
    "clean-run-context": "clean-run-context.schema.json",
    "task-manifest": "task-manifest.schema.json",
    "behavior-spec": "behavior-spec.schema.json",
    "skeleton-manifest": "skeleton-manifest.schema.json",
    "implementation-plan": "implementation-plan.schema.json",
    "implementation-report": "implementation-report.schema.json",
    "clean-room-result": "clean-room-result.schema.json",
    "qc-report": "qc-report.schema.json",
    "coverage-ledger": "coverage-ledger.schema.json",
    "evidence-ledger": "evidence-ledger.schema.json",
    "source-index": "source-index.schema.json",
    "handoff-package": "handoff-package.schema.json",
    "contamination-incident": "contamination-incident.schema.json",
    "role-session-brief": "role-session-brief.schema.json",
    "controller-status": "controller-status.schema.json",
}
CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV = "CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST"
FORBIDDEN_CLEAN_CONTEXT_ARTIFACT_NAMES = {
    "source-index.json",
    "coverage-ledger.json",
    "evidence-ledger.json",
    "task-manifest.json",
    "init-config.json",
    "preflight-goal.json",
    "controller-status.json",
}
TASK_MANIFEST_HANDOFF_SEQUENCE = [
    "preflight",
    "source-destination-discovery",
    "agent-0-decomposition",
    "agent-1-analysis",
    "agent-1-5-sanitization",
    "clean-handoff",
    "clean-planning",
    "clean-implementation-qc",
    "agent-0-coverage-verification",
]
MAX_REPORTED_ERRORS = 20
MAX_VALIDATION_ERRORS = MAX_REPORTED_ERRORS + 1
REPAIR_HINT = "Fix or update the JSON artifact to satisfy the reported schema errors, then write it again."


def schema_dir() -> Path:
    configured = os.environ.get("CLEAN_ROOM_SCHEMA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[1] / "skills" / "clean-room" / "assets"


def artifact_kind(path: Path, data: dict) -> str | None:
    # Intentionally conservative: name and field heuristics may reject unusual clean JSON,
    # but ambiguous clean-root artifacts should fail closed unless explicitly allowlisted.
    name = path.name.removesuffix(".json")
    if name in SCHEMA_BY_ARTIFACT:
        return name
    if "spec_id" in data:
        return "behavior-spec"
    if "config_id" in data and "artifact_base_root" in data:
        return "init-config"
    if "goal_id" in data and "end_goal" in data:
        return "preflight-goal"
    if "context_id" in data and "clean_isolation" in data:
        return "clean-run-context"
    if "manifest_id" in data:
        return "skeleton-manifest"
    if "plan_id" in data and "planner_role" in data:
        return "implementation-plan"
    if "report_id" in data and "implementer_role" in data:
        return "implementation-report"
    if "report_id" in data:
        return "qc-report"
    if "package_id" in data:
        return "handoff-package"
    if "incident_id" in data:
        return "contamination-incident"
    if "brief_id" in data and "fresh_context_required" in data:
        return "role-session-brief"
    if "status_id" in data and data.get("updated_by_role") == "contaminated-manager-verifier":
        return "controller-status"
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
    return None


def auxiliary_json_allowed(path: Path) -> tuple[bool, list[str]]:
    errors: list[str] = []
    for item in os.environ.get(CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV, "").split(os.pathsep):
        if not item:
            continue
        try:
            allowed = Path(item).expanduser().resolve()
        except OSError as exc:
            errors.append(f"{CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV} has invalid path: {redact_text(exc)}")
            continue
        if not path_under_env(allowed, "CLEAN_ROOM_CLEAN_ROOTS"):
            errors.append(
                f"{CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV} path is outside CLEAN_ROOM_CLEAN_ROOTS: "
                f"{describe_path(allowed)}"
            )
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


def clean_context_path_values(data: dict[str, Any]) -> list[tuple[tuple[str | int, ...], str]]:
    values: list[tuple[tuple[str | int, ...], str]] = []

    def visit(value: Any, path: tuple[str | int, ...]) -> None:
        if isinstance(value, str):
            values.append((path, value))
        elif isinstance(value, dict):
            for key, item in value.items():
                visit(item, path + (key,))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, path + (index,))

    for field in ("clean_artifacts", "approved_public_reference_roots"):
        if field in data:
            visit(data[field], (field,))
    return values


def path_parts(value: str) -> list[str]:
    parts: list[str] = []
    for candidate in (PurePosixPath(value), PureWindowsPath(value)):
        for part in candidate.parts:
            if part not in {"", ".", "/", "\\"} and part not in parts:
                parts.append(part)
    return parts


def clean_context_path_errors(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    for location, raw_path in clean_context_path_values(data):
        label = path_label(location)
        posix = PurePosixPath(raw_path)
        windows = PureWindowsPath(raw_path)
        parts = path_parts(raw_path)
        lowered_parts = {part.lower() for part in parts}
        if raw_path.startswith("~"):
            add_error(errors, f"{label}: clean-run-context path must not use home expansion")
        if posix.is_absolute() or windows.is_absolute() or windows.drive:
            add_error(errors, f"{label}: clean-run-context path must be relative")
        if ".." in parts:
            add_error(errors, f"{label}: clean-run-context path must not contain '..'")
        forbidden = sorted(lowered_parts & FORBIDDEN_CLEAN_CONTEXT_ARTIFACT_NAMES)
        if forbidden:
            add_error(errors, f"{label}: forbidden clean-run-context artifact path {forbidden[0]!r}")
        if clean_roots and blocked_roots:
            try:
                resolved_paths = [(root / raw_path).resolve() for root in clean_roots]
            except OSError as exc:
                add_error(errors, f"{label}: invalid clean-run-context path {raw_path!r}: {exc}")
                continue
            for resolved in resolved_paths:
                if any(path_is_under(resolved, root) for root in blocked_roots):
                    add_error(errors, f"{label}: clean-run-context path resolves into a source or contaminated root")
                    break
        if error_limit_reached(errors):
            return errors
    return errors


def role_session_brief_path_values(data: dict[str, Any]) -> list[tuple[tuple[str | int, ...], str]]:
    values: list[tuple[tuple[str | int, ...], str]] = []
    artifacts = data.get("allowed_artifacts")
    if not isinstance(artifacts, list):
        return values
    for index, artifact in enumerate(artifacts):
        if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
            values.append((("allowed_artifacts", index, "path"), artifact["path"]))
    return values


def role_session_brief_path_errors(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    blocked_roots = env_roots("CLEAN_ROOM_SOURCE_ROOTS") + env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    for location, raw_path in role_session_brief_path_values(data):
        label = path_label(location)
        posix = PurePosixPath(raw_path)
        windows = PureWindowsPath(raw_path)
        parts = path_parts(raw_path)
        lowered_parts = {part.lower() for part in parts}
        if raw_path.startswith("~"):
            add_error(errors, f"{label}: role-session-brief artifact path must not use home expansion")
        if posix.is_absolute() or windows.is_absolute() or windows.drive:
            add_error(errors, f"{label}: role-session-brief artifact path must be relative")
        if ".." in parts:
            add_error(errors, f"{label}: role-session-brief artifact path must not contain '..'")
        forbidden = sorted(lowered_parts & FORBIDDEN_CLEAN_CONTEXT_ARTIFACT_NAMES)
        if forbidden:
            add_error(errors, f"{label}: forbidden role-session-brief artifact path {forbidden[0]!r}")
        if clean_roots and blocked_roots:
            try:
                resolved_paths = [(root / raw_path).resolve() for root in clean_roots]
            except OSError as exc:
                add_error(errors, f"{label}: invalid role-session-brief artifact path {raw_path!r}: {exc}")
                continue
            for resolved in resolved_paths:
                if any(path_is_under(resolved, root) for root in blocked_roots):
                    add_error(errors, f"{label}: role-session-brief artifact path resolves into a source or contaminated root")
                    break
        if error_limit_reached(errors):
            return errors
    return errors


def task_manifest_handoff_sequence_errors(data: dict[str, Any]) -> list[str]:
    sequence = data.get("handoff_sequence")
    if not isinstance(sequence, list):
        return ["<root>: missing required field 'handoff_sequence'"]
    stages = [item.get("stage") if isinstance(item, dict) else None for item in sequence]
    if stages != TASK_MANIFEST_HANDOFF_SEQUENCE:
        return ["/handoff_sequence: stages must match the required clean-room handoff order"]
    return []


def is_clean_room_task_manifest_schema(schema: dict[str, Any]) -> bool:
    properties = schema.get("properties")
    return isinstance(properties, dict) and "handoff_sequence" in properties and "agent_pipeline" in properties


def print_repair_hint() -> None:
    print(REPAIR_HINT, file=sys.stderr)


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
            if error_limit_reached(errors):
                break
            continue
        sub_errors = validate_value(value, subschema, root_schema, path)
        if not sub_errors:
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
        max_length = schema.get("maxLength")
        if isinstance(max_length, int) and len(value) > max_length:
            add_error(errors, f"{path_label(path)}: longer than maxLength {max_length}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            add_error(errors, f"{path_label(path)}: does not match pattern {pattern!r}")
        if schema.get("format") == "date-time" and not valid_date_time(value):
            add_error(errors, f"{path_label(path)}: invalid date-time")

    return errors


def main() -> int:
    payload, payload_error = load_payload()
    if payload_error:
        print(f"clean-room schema check failed: {redact_text(payload_error)}", file=sys.stderr)
        return 1
    paths, path_errors = checked_write_paths(payload, "clean-room schema check")
    if path_errors:
        for error in path_errors:
            print(f"clean-room schema check failed: {redact_text(error)}", file=sys.stderr)
        return 1
    for path in paths:
        if path.suffix.lower() != ".json" or not path.is_file():
            continue
        in_clean_root = path_under_env(path, "CLEAN_ROOM_CLEAN_ROOTS")
        text, read_error = read_artifact_text(path, "JSON artifact")
        if read_error:
            print(f"clean-room schema check failed: {redact_text(read_error)}", file=sys.stderr)
            return 1
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            print(f"clean-room JSON parse failed for {describe_path(path)}: {redact_text(exc)}", file=sys.stderr)
            print_repair_hint()
            return 1
        if not isinstance(data, dict):
            if in_clean_root:
                print(
                    f"clean-room schema check failed for {describe_path(path)}: clean JSON artifact must be an object",
                    file=sys.stderr,
                )
                print_repair_hint()
                return 1
            continue
        kind = artifact_kind(path, data)
        if not kind:
            allowed, allowlist_errors = auxiliary_json_allowed(path)
            if allowlist_errors:
                for error in allowlist_errors:
                    print(f"clean-room schema check failed: {redact_text(error)}", file=sys.stderr)
                return 1
            if in_clean_root and not allowed:
                print(
                    f"clean-room schema check failed for {describe_path(path)}: unrecognized clean JSON artifact",
                    file=sys.stderr,
                )
                print_repair_hint()
                return 1
            continue
        if in_clean_root and kind in {"source-index", "init-config", "preflight-goal", "controller-status"}:
            print(
                f"clean-room schema check failed for {describe_path(path)}: {kind}.json is not a clean-role artifact",
                file=sys.stderr,
            )
            print_repair_hint()
            return 1
        schema_path = schema_dir() / SCHEMA_BY_ARTIFACT[kind]
        schema_text, schema_read_error = read_artifact_text(schema_path, "schema artifact")
        if schema_read_error:
            print(f"clean-room schema load failed: {redact_text(schema_read_error)}", file=sys.stderr)
            return 1
        try:
            schema = json.loads(schema_text)
        except json.JSONDecodeError as exc:
            print(f"clean-room schema load failed for {describe_path(schema_path)}: {redact_text(exc)}", file=sys.stderr)
            return 1
        errors = validate_value(data, schema, schema)
        if kind == "clean-run-context":
            extend_errors(errors, clean_context_path_errors(data))
        if kind == "role-session-brief" and in_clean_root:
            extend_errors(errors, role_session_brief_path_errors(data))
        if kind == "task-manifest" and is_clean_room_task_manifest_schema(schema):
            extend_errors(errors, task_manifest_handoff_sequence_errors(data))
        if errors:
            print(f"clean-room schema check failed for {describe_path(path)}:", file=sys.stderr)
            for error in errors[:MAX_REPORTED_ERRORS]:
                print(f"  {redact_text(error)}", file=sys.stderr)
            if len(errors) > MAX_REPORTED_ERRORS:
                print(f"  ... validation stopped after {MAX_REPORTED_ERRORS} error(s)", file=sys.stderr)
            print_repair_hint()
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
