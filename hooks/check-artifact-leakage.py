#!/usr/bin/env python3
"""Scan clean-room artifacts for high-risk leakage markers."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from clean_room_paths import (
    GENERIC_PATH_TOKENS,
    checked_write_paths,
    describe_path,
    env_roots,
    load_payload,
    normalize_path_name,
    private_name_tokens,
    redact_text,
    read_artifact_bytes,
    stat_artifact,
)


MAX_SCAN_BYTES = 1_000_000
MAX_DENYLIST_BYTES = 1_000_000
MAX_DENYLIST_TERMS = 20_000
MAX_DENYLIST_TERM_LENGTH = 512
PRIVATE_IDENTIFIER_DENYLIST_ENV = "CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST"
SANITIZER_ROLE = "contaminated-handoff-sanitizer"
PUBLIC_NAME_KEYS = {"name", "kind", "compatibility_reason", "visibility"}
PUBLIC_NAME_VISIBILITIES = {"public", "destination", "protocol", "user-required"}
NEVER_SCAN_JSON_STRING_KEYS = {
    "$schema",
    "allowed_artifacts",
    "artifact_type",
    "blocked_material_type",
    "category",
    "compatibility_level",
    "confidence",
    "coverage",
    "coverage_status",
    "created_at",
    "created_by_role",
    "domain",
    "evidence_status",
    "final_status",
    "from_domain",
    "kind",
    "leakage_risk",
    "leakage_status",
    "producer_role",
    "reviewed_at",
    "reviewer_role",
    "role",
    "schema_status",
    "schema_validator_version",
    "selection_basis",
    "severity",
    "status",
    "target_profile",
    "to_domain",
    "trust_domain",
    "visibility",
}
DENYLIST_ONLY_JSON_STRING_KEYS = {
    "affected_artifacts",
    "affected_paths",
    "artifact",
    "artifact_hashes",
    "artifact_id",
    "artifact_paths",
    "audit_log_refs",
    "behavior_spec_refs",
    "contaminated_artifact_roots",
    "contaminated_artifacts",
    "contract_id",
    "decision_id",
    "env_ref",
    "evidence_location_ref",
    "evidence_refs",
    "expected_artifacts",
    "implementation_root_ref",
    "implementation_root_refs",
    "include_paths",
    "incident_id",
    "manifest_id",
    "native_artifacts",
    "owner",
    "owned_path_prefixes",
    "package_id",
    "path",
    "plan_id",
    "plan_ref",
    "profile_id",
    "report_id",
    "reviewed_artifacts",
    "root_id",
    "scenario_id",
    "session_brief_ref",
    "spec_slice_ref",
    "sha256",
    "source_hash",
    "source_index_ref",
    "source_index_refs",
    "visual_index_ref",
    "visual_index_refs",
    "source_spec_id",
    "source_unit_refs",
    "spec_id",
    "task_id",
    "target_paths",
    "test_id",
    "test_paths",
    "ticket_id",
    "unit_id",
    "work_item_id",
    "work_item_ids",
    "workspace_id",
    "brief_id",
    "role_session_id",
    "status_id",
}
SCAN_LIGHT_JSON_STRING_KEYS = {
    "action",
    "formatting_rules",
}
JSON_PATH_KEY_ALLOWLIST = NEVER_SCAN_JSON_STRING_KEYS | DENYLIST_ONLY_JSON_STRING_KEYS | SCAN_LIGHT_JSON_STRING_KEYS | {
    "acceptance_criteria",
    "architecture_findings",
    "architecture_summary",
    "claim",
    "constraints",
    "dependency_constraints",
    "description",
    "expected_result",
    "findings",
    "formatting_rules",
    "implementation_forbidden_material",
    "invariants",
    "leakage_review",
    "leakage_scan_summary",
    "local_patterns",
    "name",
    "negative_behaviors",
    "notes",
    "observable_behaviors",
    "observable_surface",
    "open_decisions",
    "open_questions",
    "output_summary",
    "outputs",
    "purpose",
    "reason",
    "requirements",
    "residual_risks",
    "responsibilities",
    "risks",
    "scenario",
    "state_transitions",
    "summary",
    "target_constraints",
    "test_obligations",
    "test_scenarios",
    "timing_or_ordering",
}
IMPLEMENTATION_METADATA_MANIFESTS = {
    "Cargo.toml",
    "go.mod",
    "package.json",
    "pyproject.toml",
}
BLOCKED_PATTERNS = {
    "raw_diff": re.compile(r"(?m)^(diff --git|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)"),
    "source_fence": re.compile(
        r"(?m)^```\s*(?:$|(?:c|cc|cpp|go|java|javascript|js|jsx|kotlin|kt|m|mm|objective-c|py|python|rs|rust|swift|ts|tsx|typescript)\b)",
        re.I,
    ),
    "decompiled_marker": re.compile(r"\b(decompiled|jadx|apktool|asar extraction|source excerpt)\b", re.I),
    "stack_source_line": re.compile(r"\bFile \"[^\"]+\", line \d+|\bat [\w.$<>]+\([^)]*:\d+:\d+\)"),
}
IDENTIFIER_PATTERNS = {
    "package_or_module_identifier": re.compile(r"\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}\b"),
    "source_like_call": re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\("),
    "source_like_scoped_identifier": re.compile(
        r"\b[A-Za-z_][A-Za-z0-9_]{1,}(?:(?:->|::|#)[A-Za-z_][A-Za-z0-9_]{1,}|(?:\.[A-Za-z_][A-Za-z0-9_]{1,}){2,})\b"
    ),
}
URL_PATTERN = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s\"')]+", re.I)
PUBLIC_HOST_TLDS = {
    "ai",
    "app",
    "au",
    "ca",
    "co",
    "com",
    "dev",
    "edu",
    "gov",
    "io",
    "mil",
    "net",
    "org",
    "uk",
    "us",
}


def path_under_any(path: Path, roots: list[Path]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def is_implementation_metadata_manifest(path: Path) -> bool:
    return path.name in IMPLEMENTATION_METADATA_MANIFESTS


def is_scannable_artifact(path: Path) -> bool:
    is_metadata_manifest = is_implementation_metadata_manifest(path)
    if path.suffix.lower() not in {".json", ".md", ".yaml", ".yml", ".txt"} and not is_metadata_manifest:
        return False
    clean_roots = env_roots("CLEAN_ROOM_CLEAN_ROOTS")
    if clean_roots and path_under_any(path, clean_roots):
        return True
    implementation_roots = env_roots("CLEAN_ROOM_IMPLEMENTATION_ROOTS")
    if is_metadata_manifest and implementation_roots and path_under_any(path, implementation_roots):
        return True
    if os.environ.get("CLEAN_ROOM_ROLE") == SANITIZER_ROLE:
        contaminated_roots = env_roots("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS")
        return bool(contaminated_roots) and path_under_any(path, contaminated_roots)
    if clean_roots:
        return False
    return True


def load_private_identifier_terms() -> tuple[list[str], list[str]]:
    configured = os.environ.get(PRIVATE_IDENTIFIER_DENYLIST_ENV, "")
    terms: list[str] = []
    errors: list[str] = []
    for item in configured.split(os.pathsep):
        if not item:
            continue
        path = Path(item).expanduser()
        try:
            data = path.read_bytes()
        except OSError as exc:
            errors.append(
                f"could not read {PRIVATE_IDENTIFIER_DENYLIST_ENV} file {describe_path(path)}: {redact_text(exc)}"
            )
            continue
        if len(data) > MAX_DENYLIST_BYTES:
            errors.append(
                f"{PRIVATE_IDENTIFIER_DENYLIST_ENV} file {describe_path(path)} exceeds {MAX_DENYLIST_BYTES} bytes"
            )
            continue
        raw_terms = data.decode("utf-8", errors="replace").splitlines()
        for raw_term in raw_terms:
            if len(terms) >= MAX_DENYLIST_TERMS:
                errors.append(f"{PRIVATE_IDENTIFIER_DENYLIST_ENV} exceeds {MAX_DENYLIST_TERMS} terms")
                return terms, errors
            term = raw_term.strip()
            if not term or term.startswith("#") or len(term) < 3:
                continue
            if len(term) > MAX_DENYLIST_TERM_LENGTH:
                errors.append(
                    f"{PRIVATE_IDENTIFIER_DENYLIST_ENV} term exceeds {MAX_DENYLIST_TERM_LENGTH} characters"
                )
                return terms, errors
            terms.append(term)
    return terms, errors


def private_identifier_pattern(term: str) -> re.Pattern[str]:
    escaped = re.escape(term)
    if re.fullmatch(r"\w+", term):
        return re.compile(rf"\b{escaped}\b")
    return re.compile(rf"(?<![\w.]){escaped}(?![\w-]|\.[A-Za-z_])")


def compile_private_identifier_terms(private_terms: list[str]) -> list[tuple[str, re.Pattern[str]]]:
    return [(term, private_identifier_pattern(term)) for term in private_terms]


def source_name_pattern(term: str) -> re.Pattern[str]:
    parts = [part for part in term.split("-") if part]
    body = r"[\s_-]+".join(re.escape(part) for part in parts) if len(parts) > 1 else re.escape(term)
    return re.compile(rf"(?<![A-Za-z0-9]){body}(?![A-Za-z0-9])", re.I)


def exact_source_names(value: str) -> set[str]:
    normalized = normalize_path_name(value)
    if not normalized:
        return set()
    parts = [part for part in normalized.split("-") if part]
    if len(parts) < 2 or all(part in GENERIC_PATH_TOKENS for part in parts):
        return set()
    return {normalized}


def compile_source_name_terms() -> list[tuple[str, re.Pattern[str]]]:
    terms: set[str] = set()
    for source_root in env_roots("CLEAN_ROOM_SOURCE_ROOTS"):
        terms.update(exact_source_names(source_root.name))
        terms.update(private_name_tokens(source_root.name))
    return [(term, source_name_pattern(term)) for term in sorted(terms)]


def has_identifier_signal(value: str) -> bool:
    return any(char.isupper() or char.isdigit() for char in value) or "_" in value or "$" in value


def dotted_identifier_is_finding(value: str) -> bool:
    parts = value.split(".")
    if len(parts) < 3:
        return False
    if parts[0] in PUBLIC_HOST_TLDS:
        return True
    if parts[-1] in PUBLIC_HOST_TLDS:
        return False
    if len(parts) >= 4:
        return True
    return any(has_identifier_signal(part) for part in parts)


def source_like_call_is_finding(text: str, match: re.Match[str]) -> bool:
    name = match.group(0).rstrip("(").strip()
    if has_identifier_signal(name):
        return True
    start = match.start()
    return (
        (start > 0 and text[start - 1] in ".#>")
        or (start >= 2 and text[start - 2:start] == "::")
    )


def scoped_identifier_is_finding(value: str) -> bool:
    if any(separator in value for separator in ("->", "::", "#")):
        return True
    if "." in value:
        return dotted_identifier_is_finding(value)
    return has_identifier_signal(value)


def identifier_match_is_finding(name: str, text: str, match: re.Match[str]) -> bool:
    value = match.group(0)
    if name == "package_or_module_identifier":
        return value.split(".")[-1] not in PUBLIC_HOST_TLDS
    if name == "source_like_call":
        return source_like_call_is_finding(text, match)
    if name == "source_like_scoped_identifier":
        return scoped_identifier_is_finding(value)
    return True


def public_names(value: object, path: tuple[str | int, ...] = ()) -> set[str]:
    names: set[str] = set()
    if isinstance(value, dict):
        is_public_record = (
            len(path) >= 2
            and path[-2] in {"public_surface", "public_contracts"}
            and isinstance(path[-1], int)
            and PUBLIC_NAME_KEYS <= set(value)
            and value.get("visibility") in PUBLIC_NAME_VISIBILITIES
            and isinstance(value.get("name"), str)
            and value["name"].strip()
        )
        if is_public_record:
            names.add(value["name"])
        for key, item in value.items():
            if key == "public_contract_refs":
                names.update(public_ref_names(item))
            names.update(public_names(item, path + (key,)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            names.update(public_names(item, path + (index,)))
    return names


def public_ref_names(value: object) -> set[str]:
    names: set[str] = set()
    if isinstance(value, str) and value.strip():
        names.add(value)
        if value.startswith("public_surface:"):
            names.add(value.rsplit(":", 1)[-1])
    elif isinstance(value, list):
        for item in value:
            names.update(public_ref_names(item))
    return names


def strip_allowed_text(text: str, allowed_names: set[str]) -> str:
    stripped = URL_PATTERN.sub(" ", text)
    for name in sorted(allowed_names, key=len, reverse=True):
        if not name:
            continue
        stripped = re.sub(rf"(?<![\w.]){re.escape(name)}(?![\w])", " ", stripped)
    return stripped


def json_path(path: tuple[str | int, ...]) -> str:
    if not path:
        return "$"
    rendered = "$"
    for item in path:
        if isinstance(item, int):
            rendered += f"[{item}]"
        elif item in JSON_PATH_KEY_ALLOWLIST:
            rendered += f".{item}"
        else:
            rendered += ".<field>"
    return rendered


def format_finding_details(details: list[tuple[str, str]]) -> str:
    grouped: dict[str, set[str]] = {}
    for name, location in details:
        grouped.setdefault(name, set()).add(location)
    parts: list[str] = []
    for name in sorted(grouped):
        locations = sorted(grouped[name])
        shown = locations[:3]
        suffix = f" at {', '.join(shown)}"
        if len(locations) > len(shown):
            suffix += f", +{len(locations) - len(shown)} more"
        parts.append(f"{name}{suffix}")
    return ", ".join(parts)


def json_scan_strings(
    value: object,
    allowed_names: set[str],
    path: tuple[str | int, ...] = (),
) -> tuple[list[tuple[str, str]], list[tuple[str, str]], list[tuple[str, str]]]:
    full_scan: list[tuple[str, str]] = []
    light_scan: list[tuple[str, str]] = []
    denylist_scan: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            child_full, child_light, child_denylist = json_scan_strings(item, allowed_names, path + (key,))
            full_scan.extend(child_full)
            light_scan.extend(child_light)
            denylist_scan.extend(child_denylist)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            child_full, child_light, child_denylist = json_scan_strings(item, allowed_names, path + (index,))
            full_scan.extend(child_full)
            light_scan.extend(child_light)
            denylist_scan.extend(child_denylist)
    elif isinstance(value, str):
        leaf_key = next((item for item in reversed(path) if isinstance(item, str)), None)
        if leaf_key in NEVER_SCAN_JSON_STRING_KEYS:
            return full_scan, light_scan, denylist_scan
        stripped = strip_allowed_text(value, allowed_names)
        location = json_path(path)
        if leaf_key in DENYLIST_ONLY_JSON_STRING_KEYS:
            denylist_scan.append((location, stripped))
        elif leaf_key in SCAN_LIGHT_JSON_STRING_KEYS:
            light_scan.append((location, stripped))
        else:
            full_scan.append((location, stripped))
    return full_scan, light_scan, denylist_scan


def scan_private_identifier_denylist(
    texts: list[tuple[str, str]],
    private_patterns: list[tuple[str, re.Pattern[str]]],
) -> list[tuple[str, str]]:
    findings: set[tuple[str, str]] = set()
    for location, text in texts:
        for _term, pattern in private_patterns:
            if pattern.search(text):
                findings.add(("private_identifier_denylist", location))
                break
    return sorted(findings)


def scan_source_derived_names(
    texts: list[tuple[str, str]],
    source_patterns: list[tuple[str, re.Pattern[str]]],
) -> list[tuple[str, str]]:
    findings: set[tuple[str, str]] = set()
    for location, text in texts:
        for _term, pattern in source_patterns:
            if pattern.search(text):
                findings.add(("source_derived_name", location))
                break
    return sorted(findings)


def scan_identifier_patterns(
    texts: list[tuple[str, str]],
    private_patterns: list[tuple[str, re.Pattern[str]]],
    skipped_patterns: set[str] | None = None,
) -> list[tuple[str, str]]:
    findings: set[tuple[str, str]] = set()
    skipped_patterns = skipped_patterns or set()
    for location, text in texts:
        for _term, pattern in private_patterns:
            if pattern.search(text):
                findings.add(("private_identifier_denylist", location))
                break
        for name, pattern in IDENTIFIER_PATTERNS.items():
            if name in skipped_patterns:
                continue
            if any(identifier_match_is_finding(name, text, match) for match in pattern.finditer(text)):
                findings.add((name, location))
    return sorted(findings)


def identifier_scan_texts(path: Path, text: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]], list[tuple[str, str]]]:
    if path.suffix.lower() != ".json":
        return [("$", strip_allowed_text(text, set()))], [], []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return [("$", strip_allowed_text(text, set()))], [], []
    allowed_names = public_names(data)
    return json_scan_strings(data, allowed_names)


def main() -> int:
    payload, payload_error = load_payload()
    if payload_error:
        print(f"clean-room leakage scan failed: {redact_text(payload_error)}", file=sys.stderr)
        return 1
    paths, path_errors = checked_write_paths(payload, "clean-room leakage scan")
    if path_errors:
        for error in path_errors:
            print(f"clean-room leakage scan failed: {redact_text(error)}", file=sys.stderr)
        return 1
    private_terms, load_errors = load_private_identifier_terms()
    if load_errors:
        for error in load_errors:
            print(f"clean-room leakage scan failed: {redact_text(error)}", file=sys.stderr)
        return 1
    private_patterns = compile_private_identifier_terms(private_terms)
    source_patterns = compile_source_name_terms()
    for path in paths:
        if not is_scannable_artifact(path):
            continue
        stat, stat_error = stat_artifact(path, "artifact")
        if stat_error:
            print(f"clean-room leakage scan failed: {redact_text(stat_error)}", file=sys.stderr)
            return 1
        if stat.st_size > MAX_SCAN_BYTES:
            print(
                f"clean-room leakage scan failed for {describe_path(path)}: "
                f"artifact exceeds scan cap of {MAX_SCAN_BYTES} bytes",
                file=sys.stderr,
            )
            return 1
        data, read_error = read_artifact_bytes(path, "artifact")
        if read_error:
            print(f"clean-room leakage scan failed: {redact_text(read_error)}", file=sys.stderr)
            return 1
        text = data.decode("utf-8", errors="replace")
        findings = [(name, "$") for name, pattern in BLOCKED_PATTERNS.items() if pattern.search(text)]
        full_scan_texts, light_scan_texts, denylist_scan_texts = identifier_scan_texts(path, text)
        findings.extend(scan_identifier_patterns(full_scan_texts, private_patterns))
        findings.extend(
            scan_identifier_patterns(
                light_scan_texts,
                private_patterns,
                skipped_patterns={"source_like_call"},
            )
        )
        findings.extend(scan_private_identifier_denylist(denylist_scan_texts, private_patterns))
        findings.extend(
            scan_source_derived_names(
                full_scan_texts + light_scan_texts + denylist_scan_texts,
                source_patterns,
            )
        )
        if findings:
            print(
                f"clean-room leakage scan failed for {describe_path(path)}: "
                f"{format_finding_details(sorted(set(findings)))}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
