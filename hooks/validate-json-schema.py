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
    "polish-report": "polish-report.schema.json",
    "clean-room-result": "clean-room-result.schema.json",
    "qc-report": "qc-report.schema.json",
    "coverage-ledger": "coverage-ledger.schema.json",
    "evidence-ledger": "evidence-ledger.schema.json",
    "source-index": "source-index.schema.json",
    "visual-index": "visual-index.schema.json",
    "handoff-package": "handoff-package.schema.json",
    "contamination-incident": "contamination-incident.schema.json",
    "role-session-brief": "role-session-brief.schema.json",
    "controller-status": "controller-status.schema.json",
}
CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST_ENV = "CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST"
FORBIDDEN_CLEAN_CONTEXT_ARTIFACT_NAMES = {
    "source-index.json",
    "visual-index.json",
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
TASK_MANIFEST_HANDOFF_SEQUENCE_WITH_POLISH = [
    *TASK_MANIFEST_HANDOFF_SEQUENCE[:-1],
    "clean-polish-review",
    TASK_MANIFEST_HANDOFF_SEQUENCE[-1],
]
PUBLIC_SURFACE_COMPLETION_LEVELS = {"exact-public-contract", "behavior-compatible"}
MAX_COMPLETION_ARTIFACT_SCAN = 500
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
    if "report_id" in data and data.get("reviewer_role") == "clean-polish-reviewer":
        return "polish-report"
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
        if "images" in data:
            return "visual-index"
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
    stage_tuple = tuple(stages)
    if stage_tuple not in {tuple(TASK_MANIFEST_HANDOFF_SEQUENCE), tuple(TASK_MANIFEST_HANDOFF_SEQUENCE_WITH_POLISH)}:
        return ["/handoff_sequence: stages must match the required clean-room handoff order"]
    return []


def completion_guard_enabled(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    tool = payload.get("tool_name") or payload.get("tool")
    if not isinstance(tool, str):
        return False
    return tool.lower() in {"write", "edit", "multiedit", "notebookedit", "apply_patch"}


def read_json_artifact(path: Path, label: str) -> tuple[dict[str, Any] | None, str | None]:
    text, read_error = read_artifact_text(path, label)
    if read_error:
        return None, read_error
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, f"{label} JSON parse failed for {describe_path(path)}: {redact_text(exc)}"
    if not isinstance(data, dict):
        return None, f"{label} must be a JSON object: {describe_path(path)}"
    return data, None


def relative_ref_candidates(ref: str) -> list[str]:
    refs = [ref]
    for prefix in ("clean/", "contaminated/"):
        if ref.startswith(prefix):
            refs.append(ref.removeprefix(prefix))
    return refs


def find_json_by_ref(ref: Any, roots: list[Path], label: str) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(ref, str) or not ref:
        return None, f"{label} ref is missing"
    try:
        raw = Path(ref).expanduser()
    except OSError as exc:
        return None, f"{label} ref is invalid: {redact_text(exc)}"
    candidates: list[Path] = []
    if raw.is_absolute():
        try:
            candidates.append(raw.resolve())
        except OSError as exc:
            return None, f"{label} ref is invalid: {redact_text(exc)}"
    else:
        for root in roots:
            for candidate_ref in relative_ref_candidates(ref):
                try:
                    candidates.append((root / candidate_ref).resolve())
                except OSError as exc:
                    return None, f"{label} ref is invalid: {redact_text(exc)}"
    for candidate in candidates:
        try:
            if candidate.is_file():
                return read_json_artifact(candidate, label)
        except OSError as exc:
            return None, f"{label} could not stat {describe_path(candidate)}: {redact_text(exc)}"
    return None, f"{label} does not exist: {ref}"


def scan_json_artifacts(roots: list[Path], wanted_kind: str) -> list[tuple[Path, dict[str, Any]]]:
    matches: list[tuple[Path, dict[str, Any]]] = []
    scanned = 0
    for root in roots:
        try:
            for candidate in root.rglob("*.json"):
                scanned += 1
                if scanned > MAX_COMPLETION_ARTIFACT_SCAN:
                    return matches
                try:
                    if not candidate.is_file():
                        continue
                except OSError:
                    continue
                data, error = read_json_artifact(candidate, f"{wanted_kind} artifact")
                if error or not data:
                    continue
                if artifact_kind(candidate, data) == wanted_kind:
                    matches.append((candidate, data))
        except OSError:
            continue
    return matches


def first_json_artifact(roots: list[Path], name: str, label: str) -> tuple[dict[str, Any] | None, str | None]:
    for root in roots:
        candidate = root / name
        try:
            if candidate.is_file():
                return read_json_artifact(candidate, label)
        except OSError as exc:
            return None, f"{label} could not stat {describe_path(candidate)}: {redact_text(exc)}"
    return None, None


def unit_ref_values(unit_id: str) -> set[str]:
    return {unit_id, f"unit:{unit_id}", f"task-manifest:{unit_id}", f"behavior-spec:{unit_id}"}


def evidence_id_from_ref(ref: Any) -> str | None:
    prefix = "evidence-ledger:"
    if isinstance(ref, str) and ref.startswith(prefix):
        return ref.removeprefix(prefix)
    return None


def evidence_entry_map(evidence_ledger: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    if not isinstance(evidence_ledger, dict):
        return entries
    for entry in evidence_ledger.get("entries") or []:
        if isinstance(entry, dict) and isinstance(entry.get("evidence_id"), str):
            entries[entry["evidence_id"]] = entry
    return entries


def public_surface_ref(spec: dict[str, Any], item: dict[str, Any]) -> str:
    return f"public_surface:{spec.get('spec_id')}:{item.get('kind')}:{item.get('name')}"


def required_public_surface_obligations(spec: dict[str, Any]) -> list[str]:
    if spec.get("compatibility_level") not in PUBLIC_SURFACE_COMPLETION_LEVELS:
        return []
    obligations: list[str] = []
    for item in spec.get("public_surface") or []:
        if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("kind"), str):
            obligations.append(public_surface_ref(spec, item))
    return obligations


def behavior_spec_test_coverage_refs(spec: dict[str, Any]) -> set[str]:
    refs: set[str] = set()
    for scenario in spec.get("test_scenarios") or []:
        if not isinstance(scenario, dict):
            continue
        for ref in scenario.get("coverage") or []:
            if isinstance(ref, str):
                refs.add(ref)
    return refs


def matching_behavior_specs(
    specs: list[tuple[Path, dict[str, Any]]],
    unit_id: str,
    spec_slice_ref: str | None = None,
) -> list[tuple[Path, dict[str, Any]]]:
    matches: list[tuple[Path, dict[str, Any]]] = []
    accepted_refs = unit_ref_values(unit_id)
    if spec_slice_ref:
        accepted_refs.add(spec_slice_ref)
    for spec_path, spec in specs:
        source_refs = spec.get("source_unit_refs") if isinstance(spec.get("source_unit_refs"), list) else []
        spec_refs = {
            ref
            for ref in [spec.get("spec_id"), spec.get("unit_id"), *source_refs]
            if isinstance(ref, str)
        }
        if spec_refs & accepted_refs or spec.get("unit_id") == unit_id or unit_id in source_refs:
            matches.append((spec_path, spec))
    return matches


def unit_id_from_spec_slice_ref(spec_slice_ref: Any, specs: list[tuple[Path, dict[str, Any]]]) -> str | None:
    if not isinstance(spec_slice_ref, str) or not spec_slice_ref:
        return None
    for spec_ref, unit_id_prefix in (("unit:", "unit:"), ("task-manifest:", "task-manifest:"), ("behavior-spec:", "behavior-spec:")):
        if spec_slice_ref.startswith(spec_ref):
            return spec_slice_ref.removeprefix(unit_id_prefix)
    if spec_slice_ref.startswith("unit-"):
        return spec_slice_ref
    for _spec_path, spec in specs:
        if spec.get("spec_id") == spec_slice_ref:
            return spec.get("unit_id") if isinstance(spec.get("unit_id"), str) else None
    return None


def plan_work_items_by_public_ref(plans: list[tuple[Path, dict[str, Any]]]) -> dict[str, list[str]]:
    refs: dict[str, list[str]] = {}
    for _plan_path, plan in plans:
        for work_item in plan.get("work_items") or []:
            if not isinstance(work_item, dict) or not isinstance(work_item.get("work_item_id"), str):
                continue
            for ref in work_item.get("public_contract_refs") or []:
                if isinstance(ref, str):
                    refs.setdefault(ref, []).append(work_item["work_item_id"])
    return refs


def plan_work_items_for_specs(plans: list[tuple[Path, dict[str, Any]]], specs: list[dict[str, Any]]) -> set[str]:
    spec_ids = {spec.get("spec_id") for spec in specs if isinstance(spec.get("spec_id"), str)}
    work_items: set[str] = set()
    for _plan_path, plan in plans:
        for work_item in plan.get("work_items") or []:
            if not isinstance(work_item, dict) or not isinstance(work_item.get("work_item_id"), str):
                continue
            refs = {ref for ref in work_item.get("spec_ids") or [] if isinstance(ref, str)}
            if refs & spec_ids:
                work_items.add(work_item["work_item_id"])
    return work_items


def completed_work_items(reports: list[tuple[Path, dict[str, Any]]]) -> set[str]:
    completed: set[str] = set()
    for _report_path, report in reports:
        for work_item_id in report.get("completed_work_items") or []:
            if isinstance(work_item_id, str):
                completed.add(work_item_id)
    return completed


def terminal_implementation_reports(reports: list[tuple[Path, dict[str, Any]]]) -> list[tuple[Path, dict[str, Any]]]:
    terminal: list[tuple[Path, dict[str, Any]]] = []
    for report_path, report in reports:
        if (
            report.get("implementation_status") == "complete"
            and report.get("final_status") == "complete"
            and isinstance(report.get("agent0_reporting"), dict)
            and report["agent0_reporting"].get("report_state") == "terminal-report"
        ):
            terminal.append((report_path, report))
    return terminal


def passed_qc_reports(qc_reports: list[tuple[Path, dict[str, Any]]]) -> list[tuple[Path, dict[str, Any]]]:
    passed: list[tuple[Path, dict[str, Any]]] = []
    for report_path, report in qc_reports:
        if (
            report.get("final_status") in {"passed", "passed-with-gaps"}
            and report.get("coverage_status") == "complete"
            and report.get("schema_status") == "passed"
            and report.get("leakage_status") == "passed"
            and report.get("required_rerun") is False
        ):
            passed.append((report_path, report))
    return passed


def source_unit_for_unit(coverage_ledger: dict[str, Any] | None, unit_id: str) -> dict[str, Any] | None:
    if not isinstance(coverage_ledger, dict):
        return None
    for source_unit in coverage_ledger.get("source_units") or []:
        if isinstance(source_unit, dict) and source_unit.get("unit_id") == unit_id:
            return source_unit
    return None


def validate_evidence_refs(
    errors: list[str],
    unit_id: str,
    refs: Any,
    evidence_ledger: dict[str, Any] | None,
    label: str,
) -> None:
    if not isinstance(refs, list) or not refs:
        add_error(errors, f"{label} has no evidence_refs: {unit_id}")
        return
    entries = evidence_entry_map(evidence_ledger)
    if not entries:
        add_error(errors, f"{label} references evidence but evidence-ledger.json is missing or empty: {unit_id}")
        return
    for ref in refs:
        evidence_id = evidence_id_from_ref(ref)
        if not evidence_id:
            continue
        entry = entries.get(evidence_id)
        if not entry:
            add_error(errors, f"{label} references missing evidence-ledger item: {ref}")
            continue
        source_ref = entry.get("source_unit_ref")
        if isinstance(source_ref, str) and source_ref not in unit_ref_values(unit_id):
            add_error(errors, f"{label} evidence ref points at a different source unit: {ref}")


def manifest_behavior_unit_ids(manifest: dict[str, Any] | None) -> set[str]:
    ids: set[str] = set()
    if not isinstance(manifest, dict):
        return ids
    for unit in manifest.get("units") or []:
        if isinstance(unit, dict) and unit.get("unit_kind") == "behavior" and isinstance(unit.get("unit_id"), str):
            ids.add(unit["unit_id"])
    return ids


def manifest_completion_behavior_unit_ids(manifest: dict[str, Any] | None) -> set[str]:
    ids: set[str] = set()
    if not isinstance(manifest, dict):
        return ids
    for unit in manifest.get("units") or []:
        if (
            isinstance(unit, dict)
            and unit.get("unit_kind") == "behavior"
            and unit.get("status") != "out-of-scope"
            and isinstance(unit.get("unit_id"), str)
        ):
            ids.add(unit["unit_id"])
    return ids


def behavior_unit_is_in_scope(unit_id: str, manifest: dict[str, Any] | None, specs: list[tuple[Path, dict[str, Any]]]) -> bool:
    behavior_ids = manifest_behavior_unit_ids(manifest)
    if behavior_ids:
        return unit_id in behavior_ids
    if matching_behavior_specs(specs, unit_id):
        return True
    return unit_id != "unit-foundation"


def completion_context(path: Path, kind: str, data: dict[str, Any]) -> dict[str, Any]:
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    contaminated_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
    manifest = data if kind == "task-manifest" else first_json_artifact(contaminated_roots, "task-manifest.json", "task-manifest")[0]
    coverage = data if kind == "coverage-ledger" else first_json_artifact(contaminated_roots, "coverage-ledger.json", "coverage-ledger")[0]
    evidence = first_json_artifact(contaminated_roots, "evidence-ledger.json", "evidence-ledger")[0]
    specs = scan_json_artifacts(clean_roots, "behavior-spec")
    plans = scan_json_artifacts(clean_roots, "implementation-plan")
    reports = scan_json_artifacts(clean_roots, "implementation-report")
    qcs = scan_json_artifacts(clean_roots, "qc-report")
    if kind == "clean-room-result" and data.get("result") == "spec-slice-complete":
        report, report_error = find_json_by_ref(data.get("terminal_report_ref"), clean_roots, "clean-room-result terminal_report_ref")
        qc, qc_error = find_json_by_ref(data.get("qc_report_ref"), clean_roots, "clean-room-result qc_report_ref")
        if report:
            reports = [(path, report)]
        if qc:
            qcs = [(path, qc)]
        return {
            "clean_roots": clean_roots,
            "contaminated_roots": contaminated_roots,
            "manifest": manifest,
            "coverage": coverage,
            "evidence": evidence,
            "specs": specs,
            "plans": plans,
            "reports": reports,
            "qcs": qcs,
            "report_error": report_error if not report else None,
            "qc_error": qc_error if not qc else None,
        }
    return {
        "clean_roots": clean_roots,
        "contaminated_roots": contaminated_roots,
        "manifest": manifest,
        "coverage": coverage,
        "evidence": evidence,
        "specs": specs,
        "plans": plans,
        "reports": reports,
        "qcs": qcs,
        "report_error": None,
        "qc_error": None,
    }


def validate_behavior_unit_completion(
    errors: list[str],
    unit_id: str,
    context: dict[str, Any],
    spec_slice_ref: str | None = None,
) -> None:
    specs = matching_behavior_specs(context["specs"], unit_id, spec_slice_ref)
    if not specs:
        add_error(errors, f"completion claim has no clean behavior spec: {unit_id}")
        return
    spec_data = [spec for _spec_path, spec in specs]
    terminal_reports = terminal_implementation_reports(context["reports"])
    if not terminal_reports:
        add_error(errors, f"completion claim has no terminal implementation report: {unit_id}")
    passed_qcs = passed_qc_reports(context["qcs"])
    if not passed_qcs:
        add_error(errors, f"completion claim has no passed QC report: {unit_id}")
    work_item_ids = plan_work_items_for_specs(context["plans"], spec_data)
    if not work_item_ids:
        add_error(errors, f"completion claim has no implementation-plan work item for clean behavior spec: {unit_id}")
    elif not (work_item_ids & completed_work_items(terminal_reports)):
        add_error(errors, f"completion claim has no completed implementation work item for clean behavior spec: {unit_id}")

    source_unit = source_unit_for_unit(context["coverage"], unit_id)
    if not source_unit or source_unit.get("coverage_state") != "covered":
        add_error(errors, f"completion claim has no covered coverage-ledger source unit: {unit_id}")
    else:
        validate_evidence_refs(errors, unit_id, source_unit.get("evidence_refs"), context["evidence"], "coverage-ledger source unit")

    public_coverage_by_ref = {
        item.get("ref"): item
        for item in (source_unit or {}).get("public_surface_coverage") or []
        if isinstance(item, dict) and isinstance(item.get("ref"), str)
    }
    plan_refs = plan_work_items_by_public_ref(context["plans"])
    completed = completed_work_items(terminal_reports)
    for spec_path, spec in specs:
        coverage_refs = behavior_spec_test_coverage_refs(spec)
        for obligation in required_public_surface_obligations(spec):
            if obligation not in coverage_refs:
                add_error(errors, f"public_surface obligation missing from behavior spec test coverage: {obligation} ({describe_path(spec_path)})")
            coverage = public_coverage_by_ref.get(obligation)
            if not coverage:
                add_error(errors, f"coverage-ledger missing public_surface_coverage for: {obligation}")
                continue
            if coverage.get("status") != "covered":
                add_error(errors, f"coverage-ledger public_surface_coverage is not covered: {obligation}")
            validate_evidence_refs(errors, unit_id, coverage.get("evidence_refs"), context["evidence"], "coverage-ledger public_surface_coverage")
            mapped_items = set(plan_refs.get(obligation) or [])
            if not mapped_items:
                add_error(errors, f"public_surface obligation missing from implementation plan: {obligation}")
            elif not (mapped_items & completed):
                add_error(errors, f"public_surface obligation work item is not complete: {obligation}")
            if error_limit_reached(errors):
                return


def completion_guard_errors(path: Path, kind: str, data: dict[str, Any]) -> list[str]:
    if kind not in {"task-manifest", "coverage-ledger", "clean-room-result"}:
        return []
    if not env_roots("CLEAN_ROOM_CLEAN_ROOTS") or not env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS"):
        return []
    errors: list[str] = []
    context = completion_context(path, kind, data)
    if context.get("report_error"):
        add_error(errors, context["report_error"])
    if context.get("qc_error"):
        add_error(errors, context["qc_error"])

    if kind == "task-manifest":
        manifest_complete = isinstance(data.get("implementation_status"), dict) and data["implementation_status"].get("state") == "complete"
        completed_behavior_ids: set[str] = set()
        for unit in data.get("units") or []:
            if not isinstance(unit, dict):
                continue
            if unit.get("unit_kind") != "behavior" or not isinstance(unit.get("unit_id"), str):
                continue
            unit_id = unit["unit_id"]
            if unit.get("status") == "complete":
                completed_behavior_ids.add(unit_id)
                validate_behavior_unit_completion(errors, unit_id, context)
            elif manifest_complete and unit.get("status") != "out-of-scope":
                add_error(errors, f"task-manifest implementation_status complete but behavior unit is not complete: {unit_id}")
                if error_limit_reached(errors):
                    break
        if manifest_complete and not completed_behavior_ids:
            add_error(errors, "task-manifest implementation_status complete has no completed behavior units")
    elif kind == "coverage-ledger":
        if data.get("coverage_status") != "complete":
            return errors
        if not isinstance(context["manifest"], dict):
            add_error(errors, "coverage-ledger completion has no task-manifest.json")
        if not data.get("behavior_spec_refs"):
            add_error(errors, "coverage-ledger completion has no behavior_spec_refs")
        required_behavior_ids = manifest_completion_behavior_unit_ids(context["manifest"])
        if isinstance(context["manifest"], dict) and not required_behavior_ids:
            add_error(errors, "coverage-ledger completion has no behavior units to complete")
        covered_behavior_ids: set[str] = set()
        behavior_spec_refs = {ref for ref in data.get("behavior_spec_refs") or [] if isinstance(ref, str)}
        for source_unit in data.get("source_units") or []:
            if not isinstance(source_unit, dict):
                continue
            unit_id = source_unit.get("unit_id")
            if not isinstance(unit_id, str):
                continue
            if unit_id in required_behavior_ids and source_unit.get("coverage_state") != "covered":
                add_error(errors, f"coverage-ledger completion does not cover behavior unit: {unit_id}")
            if source_unit.get("coverage_state") != "covered":
                continue
            validate_evidence_refs(errors, unit_id, source_unit.get("evidence_refs"), context["evidence"], "coverage-ledger source unit")
            is_behavior_completion = (
                unit_id in required_behavior_ids
                if required_behavior_ids
                else behavior_unit_is_in_scope(unit_id, context["manifest"], context["specs"])
            )
            if is_behavior_completion:
                covered_behavior_ids.add(unit_id)
                validate_behavior_unit_completion(errors, unit_id, context)
                for _spec_path, spec in matching_behavior_specs(context["specs"], unit_id):
                    spec_id = spec.get("spec_id")
                    if isinstance(spec_id, str) and spec_id not in behavior_spec_refs:
                        add_error(errors, f"coverage-ledger completion missing behavior_spec_refs entry: {spec_id}")
            if error_limit_reached(errors):
                break
        for unit_id in sorted(required_behavior_ids - covered_behavior_ids):
            add_error(errors, f"coverage-ledger completion does not cover behavior unit: {unit_id}")
            if error_limit_reached(errors):
                break
    elif kind == "clean-room-result" and data.get("result") == "spec-slice-complete":
        if not isinstance(context["manifest"], dict):
            add_error(errors, "clean-room-result completion has no task-manifest.json")
        if not isinstance(context["coverage"], dict):
            add_error(errors, "clean-room-result completion has no coverage-ledger.json")
        if data.get("coverage_state") != "complete":
            add_error(errors, "clean-room-result spec-slice-complete must have coverage_state complete")
        unit_id = unit_id_from_spec_slice_ref(data.get("spec_slice_ref"), context["specs"])
        if not unit_id:
            add_error(errors, "clean-room-result spec_slice_ref does not resolve to a behavior unit")
        elif behavior_unit_is_in_scope(unit_id, context["manifest"], context["specs"]):
            validate_behavior_unit_completion(errors, unit_id, context, data.get("spec_slice_ref"))
    return errors


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
        contains_schema = schema.get("contains")
        if isinstance(contains_schema, dict):
            match_count = 0
            for index, item in enumerate(value):
                if not validate_value(item, contains_schema, root_schema, path + (index,)):
                    match_count += 1
            min_contains = schema.get("minContains", 1)
            max_contains = schema.get("maxContains")
            if isinstance(min_contains, int) and match_count < min_contains:
                add_error(errors, f"{path_label(path)}: fewer than minContains {min_contains} matching contains schema")
            if isinstance(max_contains, int) and match_count > max_contains:
                add_error(errors, f"{path_label(path)}: more than maxContains {max_contains} matching contains schema")
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
    run_completion_guard = completion_guard_enabled(payload)
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
        if in_clean_root and kind in {"source-index", "visual-index", "init-config", "preflight-goal", "controller-status"}:
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
        if run_completion_guard:
            extend_errors(errors, completion_guard_errors(path, kind, data))
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
