#!/usr/bin/env python3
"""Build a bounded contaminated-side source index for clean-room planning."""

from __future__ import annotations

import argparse
import ast
import json
import math
import os
import platform
import re
import sys
import tempfile
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import clean_room_tooling


DEFAULT_IGNORE_DIRS = (
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
    "__pycache__",
)
DEFAULT_MAX_FILES = 2000
DEFAULT_MAX_FILE_BYTES = 1_000_000
DEFAULT_MAX_TOTAL_BYTES = 50_000_000
DEFAULT_MAX_BATCH_TOKENS = 20_000
DEFAULT_LARGE_FILE_WORDS = 5_000
DEFAULT_LARGE_GROUP_WORDS = 15_000
DEFAULT_MAX_FILE_SEGMENTS = 200
MAX_SKIPPED_ENTRIES = 1000
MAX_IMPORTS_PER_FILE = 200
MAX_EXPORTS_PER_FILE = 200
C_LIKE_EXTENSIONS = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"}
CSHARP_EXTENSIONS = {".cs"}
GO_EXTENSIONS = {".go"}
JVM_EXTENSIONS = {".java", ".kt", ".kts"}
JS_TS_EXTENSIONS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
PYTHON_EXTENSIONS = {".py", ".pyi"}
RUST_EXTENSIONS = {".rs"}
SWIFT_EXTENSIONS = {".swift"}
RESOLVE_EXTENSIONS = (
    ".py",
    ".pyi",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".kts",
    ".swift",
    ".cs",
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
)
WORD_RE = re.compile(r"\b\w+\b", re.UNICODE)
JS_STRING_RE = r"['\"]([^'\"]+)['\"]"
IDENTIFIER_RE = r"[A-Za-z_$][\w$]*"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a bounded contaminated-side source-index.json for clean-room controller preflight."
    )
    parser.add_argument("--source-root", action="append", required=True, help="Authorized source root to index.")
    parser.add_argument("--output", required=True, help="Path to write source-index.json.")
    parser.add_argument(
        "--contaminated-artifact-root",
        action="append",
        default=[],
        help="Approved contaminated artifact root. Defaults to CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS.",
    )
    parser.add_argument("--task-id", required=True, help="Clean-room task id associated with this index.")
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--max-total-bytes", type=int, default=DEFAULT_MAX_TOTAL_BYTES)
    parser.add_argument("--max-batch-tokens", type=int, default=DEFAULT_MAX_BATCH_TOKENS)
    parser.add_argument("--large-file-words", type=int, default=DEFAULT_LARGE_FILE_WORDS)
    parser.add_argument("--large-group-words", type=int, default=DEFAULT_LARGE_GROUP_WORDS)
    parser.add_argument("--max-file-segments", type=int, default=DEFAULT_MAX_FILE_SEGMENTS)
    parser.add_argument("--ignore-dir", action="append", default=[], help="Directory basename to skip.")
    parser.add_argument(
        "--skip-tool-detection",
        action="store_true",
        help="Do not record optional AST/indexing tool status in source-index.json.",
    )
    parser.add_argument(
        "--probe-tools",
        action="store_true",
        help="Execute optional helper tools with version commands in dependency_report. Default is stat-only.",
    )
    parser.add_argument(
        "--allow-working-project-tools",
        action="store_true",
        help="Allow dependency detection to consider .local/bin, .bin, node_modules/.bin, and npm prefix/global tools.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def source_roots(values: list[str]) -> list[dict[str, str]]:
    roots: list[dict[str, str]] = []
    seen: set[Path] = set()
    for index, value in enumerate(values, start=1):
        path = Path(value).expanduser().resolve()
        if path in seen:
            continue
        if not path.is_dir():
            raise SystemExit(f"source root is not a directory: {path}")
        seen.add(path)
        roots.append({"root_id": f"root-{index:03d}", "path": str(path)})
    if not roots:
        raise SystemExit("at least one unique --source-root is required")
    return roots


def path_is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def contaminated_artifact_roots(args: argparse.Namespace) -> list[Path]:
    values = list(args.contaminated_artifact_root)
    values.extend(item for item in os.environ.get("CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS", "").split(os.pathsep) if item)
    roots: list[Path] = []
    seen: set[Path] = set()
    for value in values:
        root = Path(value).expanduser().resolve()
        if root in seen:
            continue
        seen.add(root)
        roots.append(root)
    return roots


def checked_output_path(args: argparse.Namespace) -> Path:
    output = Path(args.output).expanduser().resolve()
    roots = contaminated_artifact_roots(args)
    if not roots:
        raise SystemExit(
            "--output must be under CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS or an explicit --contaminated-artifact-root"
        )
    if not any(path_is_under(output, root) for root in roots):
        allowed = ", ".join(root.as_posix() for root in roots)
        raise SystemExit(f"--output must be under a contaminated artifact root ({allowed}): {output}")
    return output


def add_skipped(skipped_entries: list[dict[str, str]], counters: dict[str, int], path: str, reason: str, kind: str) -> None:
    counters["skipped_count"] += 1
    if len(skipped_entries) < MAX_SKIPPED_ENTRIES:
        skipped_entries.append({"path": path, "reason": reason, "kind": kind})


def language_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        return "python"
    if suffix in JS_TS_EXTENSIONS:
        return "typescript" if "ts" in suffix else "javascript"
    if suffix in GO_EXTENSIONS:
        return "go"
    if suffix in RUST_EXTENSIONS:
        return "rust"
    if suffix == ".java":
        return "java"
    if suffix in {".kt", ".kts"}:
        return "kotlin"
    if suffix in SWIFT_EXTENSIONS:
        return "swift"
    if suffix in CSHARP_EXTENSIONS:
        return "csharp"
    if suffix in C_LIKE_EXTENSIONS:
        return "cpp" if suffix in {".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"} else "c"
    return "text"


def line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def metrics_for_text(data: bytes, text: str) -> dict[str, int]:
    characters = len(text)
    return {
        "bytes": len(data),
        "lines": line_count(text),
        "words": len(WORD_RE.findall(text)),
        "characters": characters,
        "estimated_tokens": math.ceil(characters / 4),
    }


def metrics_for_text_fragment(text: str) -> dict[str, int]:
    return metrics_for_text(text.encode("utf-8", errors="replace"), text)


def empty_metrics() -> dict[str, int]:
    return {"bytes": 0, "lines": 0, "words": 0, "characters": 0, "estimated_tokens": 0}


def add_metrics(left: dict[str, int], right: dict[str, int]) -> None:
    for key in ("bytes", "lines", "words", "characters", "estimated_tokens"):
        left[key] += right[key]


def truncate_items(items: list[dict[str, Any]], limit: int) -> tuple[list[dict[str, Any]], bool]:
    return items[:limit], len(items) > limit


def literal_all(node: ast.AST) -> list[str]:
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError):
        return []
    if isinstance(value, (list, tuple)):
        return [item for item in value if isinstance(item, str)]
    return []


def scan_python(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return "python-ast-error", imports, exports

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(
                    {
                        "specifier": alias.name,
                        "kind": "python-import",
                        "is_relative": False,
                        "names": [alias.asname or alias.name.split(".")[0]],
                    }
                )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            specifier = "." * node.level + module
            imports.append(
                {
                    "specifier": specifier,
                    "kind": "python-from-import",
                    "is_relative": node.level > 0,
                    "names": [alias.asname or alias.name for alias in node.names],
                }
            )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            exports.append({"name": node.name, "kind": "top-level-function"})
        elif isinstance(node, ast.ClassDef):
            exports.append({"name": node.name, "kind": "top-level-class"})
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets: list[ast.AST] = []
            if isinstance(node, ast.Assign):
                targets = list(node.targets)
                value = node.value
            else:
                targets = [node.target]
                value = node.value
            for target in targets:
                if isinstance(target, ast.Name) and target.id == "__all__" and value is not None:
                    for name in literal_all(value):
                        exports.append({"name": name, "kind": "explicit-all"})
                elif isinstance(target, ast.Name):
                    exports.append({"name": target.id, "kind": "top-level-assignment"})

    return "python-ast", *truncate_scanned(imports, exports)


def strip_js_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"(?m)//.*$", " ", text)
    return text


def split_export_names(raw: str) -> list[str]:
    names: list[str] = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        match = re.search(r"\bas\s+([A-Za-z_$][\w$]*)$", item)
        if match:
            names.append(match.group(1))
        else:
            names.append(item.split()[0].strip())
    return [name for name in names if re.fullmatch(r"[A-Za-z_$][\w$]*", name)]


def scan_js_ts(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    scanned = strip_js_comments(text)
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for match in re.finditer(rf"(?m)^\s*import(?:\s+type)?(?:[\s\w$*{{}},]+?\s+from\s*)?{JS_STRING_RE}", scanned):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "esm-import",
                "is_relative": match.group(1).startswith("."),
                "names": [],
            }
        )
    for match in re.finditer(rf"(?m)^\s*export(?:\s+type)?\s+[^;]*?\s+from\s+{JS_STRING_RE}", scanned):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "esm-re-export",
                "is_relative": match.group(1).startswith("."),
                "names": [],
            }
        )
    for match in re.finditer(rf"\brequire\(\s*{JS_STRING_RE}\s*\)", scanned):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "commonjs-require",
                "is_relative": match.group(1).startswith("."),
                "names": [],
            }
        )
    for match in re.finditer(rf"\bimport\(\s*{JS_STRING_RE}\s*\)", scanned):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "dynamic-import",
                "is_relative": match.group(1).startswith("."),
                "names": [],
            }
        )

    for match in re.finditer(
        r"(?m)^\s*export\s+(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
        scanned,
    ):
        exports.append({"name": match.group(1), "kind": "esm-declaration"})
    for match in re.finditer(r"(?m)^\s*export\s+default\b", scanned):
        exports.append({"name": "default", "kind": "esm-default"})
    for match in re.finditer(r"(?m)^\s*export\s*{([^}]+)}", scanned):
        for name in split_export_names(match.group(1)):
            exports.append({"name": name, "kind": "esm-named"})
    for match in re.finditer(r"\bmodule\.exports\s*=", scanned):
        exports.append({"name": "module.exports", "kind": "commonjs-module"})
    for match in re.finditer(r"\bexports\.([A-Za-z_$][\w$]*)\s*=", scanned):
        exports.append({"name": match.group(1), "kind": "commonjs-named"})

    return "javascript-typescript-scanner", *truncate_scanned(imports, exports)


def scan_go(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for block in re.finditer(r"(?ms)^\s*import\s*\((.*?)\)", text):
        for match in re.finditer(r'"([^"]+)"', block.group(1)):
            imports.append(
                {
                    "specifier": match.group(1),
                    "kind": "go-import",
                    "is_relative": match.group(1).startswith("."),
                    "names": [],
                }
            )
    for match in re.finditer(r'(?m)^\s*import\s+(?:[._A-Za-z]\w*\s+)?(?:"([^"]+)")', text):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "go-import",
                "is_relative": match.group(1).startswith("."),
                "names": [],
            }
        )
    for match in re.finditer(rf"(?m)^\s*func\s+(?:\([^)]*\)\s*)?({IDENTIFIER_RE})\s*\(", text):
        exports.append({"name": match.group(1), "kind": "go-function"})
    for match in re.finditer(rf"(?m)^\s*type\s+({IDENTIFIER_RE})\b", text):
        exports.append({"name": match.group(1), "kind": "go-type"})
    for match in re.finditer(rf"(?m)^\s*(?:const|var)\s+(?:\(\s*)?({IDENTIFIER_RE})\b", text):
        exports.append({"name": match.group(1), "kind": "go-binding"})

    return "go-scanner", *truncate_scanned(imports, exports)


def scan_rust(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for match in re.finditer(r"(?m)^\s*use\s+([^;]+);", text):
        specifier = re.sub(r"\s+", "", match.group(1))
        imports.append(
            {
                "specifier": specifier,
                "kind": "rust-use",
                "is_relative": specifier.startswith(("self::", "super::", "crate::")),
                "names": [],
            }
        )
    for match in re.finditer(rf"(?m)^\s*(?:pub\s+)?mod\s+({IDENTIFIER_RE})\s*;", text):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "rust-mod",
                "is_relative": True,
                "names": [],
            }
        )
    for match in re.finditer(
        rf"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|const|static)\s+({IDENTIFIER_RE})\b",
        text,
    ):
        exports.append({"name": match.group(1), "kind": "rust-declaration"})

    return "rust-scanner", *truncate_scanned(imports, exports)


def scan_java_kotlin(language: str, text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []
    scanner = "java-scanner" if language == "java" else "kotlin-scanner"

    for match in re.finditer(r"(?m)^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*\*?)\s*;?", text):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": f"{language}-import",
                "is_relative": False,
                "names": [],
            }
        )
    for match in re.finditer(
        rf"(?m)^\s*(?:public|internal|private|protected|sealed|abstract|final|open|data|value|\s)*"
        rf"(?:class|interface|enum|object|record)\s+({IDENTIFIER_RE})\b",
        text,
    ):
        exports.append({"name": match.group(1), "kind": f"{language}-type"})
    if language == "kotlin":
        for match in re.finditer(rf"(?m)^\s*(?:public|internal|private|protected|suspend|\s)*fun\s+({IDENTIFIER_RE})\s*\(", text):
            exports.append({"name": match.group(1), "kind": "kotlin-function"})

    return scanner, *truncate_scanned(imports, exports)


def scan_swift(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for match in re.finditer(r"(?m)^\s*import\s+(?:@\w+\s+)?([A-Za-z_][\w.]*)", text):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "swift-import",
                "is_relative": False,
                "names": [],
            }
        )
    for match in re.finditer(
        rf"(?m)^\s*(?:public|internal|private|fileprivate|open|final|\s)*"
        rf"(?:class|struct|enum|protocol|actor|func|let|var)\s+({IDENTIFIER_RE})\b",
        text,
    ):
        exports.append({"name": match.group(1), "kind": "swift-declaration"})

    return "swift-scanner", *truncate_scanned(imports, exports)


def scan_c_like(language: str, text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for match in re.finditer(r'(?m)^\s*#\s*include\s*([<"])([^>"]+)[>"]', text):
        imports.append(
            {
                "specifier": match.group(2),
                "kind": f"{language}-include",
                "is_relative": match.group(1) == '"',
                "names": [],
            }
        )
    for match in re.finditer(
        rf"(?m)^\s*(?:extern\s+)?(?:[A-Za-z_][\w:<>,\s\*&~]+\s+)+({IDENTIFIER_RE})\s*\([^;]*\)\s*(?:;|{{)",
        text,
    ):
        name = match.group(1)
        if name not in {"if", "for", "while", "switch", "return"}:
            exports.append({"name": name, "kind": f"{language}-function"})
    for match in re.finditer(rf"(?m)^\s*(?:class|struct|enum)\s+({IDENTIFIER_RE})\b", text):
        exports.append({"name": match.group(1), "kind": f"{language}-type"})

    return f"{language}-scanner", *truncate_scanned(imports, exports)


def scan_csharp(text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    imports: list[dict[str, Any]] = []
    exports: list[dict[str, str]] = []

    for match in re.finditer(r"(?m)^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;", text):
        imports.append(
            {
                "specifier": match.group(1),
                "kind": "csharp-using",
                "is_relative": False,
                "names": [],
            }
        )
    for match in re.finditer(
        rf"(?m)^\s*(?:public|internal|private|protected|abstract|sealed|static|partial|\s)*"
        rf"(?:class|interface|struct|enum|record)\s+({IDENTIFIER_RE})\b",
        text,
    ):
        exports.append({"name": match.group(1), "kind": "csharp-type"})
    for match in re.finditer(
        rf"(?m)^\s*(?:public|internal|private|protected|static|async|virtual|override|\s)*"
        rf"(?:[A-Za-z_][\w<>,\[\]?]+\s+)+({IDENTIFIER_RE})\s*\(",
        text,
    ):
        name = match.group(1)
        if name not in {"if", "for", "foreach", "while", "switch", "catch"}:
            exports.append({"name": name, "kind": "csharp-method"})

    return "csharp-scanner", *truncate_scanned(imports, exports)


def truncate_scanned(
    imports: list[dict[str, Any]], exports: list[dict[str, str]]
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    truncated_imports, imports_truncated = truncate_items(imports, MAX_IMPORTS_PER_FILE)
    truncated_exports, exports_truncated = truncate_items(exports, MAX_EXPORTS_PER_FILE)
    if imports_truncated:
        truncated_imports.append(
            {
                "specifier": "__truncated__",
                "kind": "truncation-marker",
                "is_relative": False,
                "names": [],
            }
        )
    if exports_truncated:
        truncated_exports.append({"name": "__truncated__", "kind": "truncation-marker"})
    return truncated_imports, truncated_exports


def scan_file(language: str, text: str) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    if language == "python":
        return scan_python(text)
    if language in {"javascript", "typescript"}:
        return scan_js_ts(text)
    if language == "go":
        return scan_go(text)
    if language == "rust":
        return scan_rust(text)
    if language in {"java", "kotlin"}:
        return scan_java_kotlin(language, text)
    if language == "swift":
        return scan_swift(text)
    if language in {"c", "cpp"}:
        return scan_c_like(language, text)
    if language == "csharp":
        return scan_csharp(text)
    return "text-metrics", [], []


def normalized_relative(path: Path) -> str:
    return path.as_posix()


def add_path_aliases(path_map: dict[str, str], root_id: str, relative_path: Path, file_id: str) -> None:
    rel = normalized_relative(relative_path)
    key = f"{root_id}:{rel}"
    path_map[key] = file_id
    suffix = relative_path.suffix
    if suffix:
        path_map[f"{root_id}:{normalized_relative(relative_path.with_suffix(''))}"] = file_id
    if relative_path.name in {
        "__init__.py",
        "index.js",
        "index.jsx",
        "index.ts",
        "index.tsx",
        "index.mjs",
        "index.cjs",
        "mod.rs",
    }:
        path_map[f"{root_id}:{normalized_relative(relative_path.parent)}"] = file_id


def resolve_candidate(path_map: dict[str, str], root_id: str, candidate: Path) -> str | None:
    candidates = [candidate]
    if not candidate.suffix:
        candidates.extend(candidate.with_suffix(ext) for ext in RESOLVE_EXTENSIONS)
        candidates.extend(candidate / f"index{ext}" for ext in RESOLVE_EXTENSIONS if ext != ".pyi")
        candidates.append(candidate / "__init__.py")
    for item in candidates:
        key = f"{root_id}:{normalized_relative(item)}"
        if key in path_map:
            return path_map[key]
    return None


def resolve_import(
    path_map: dict[str, str],
    file_record: dict[str, Any],
    import_record: dict[str, Any],
) -> str | None:
    root_id = file_record["root_id"]
    path = Path(file_record["path"])
    specifier = import_record["specifier"]
    kind = import_record["kind"]
    if kind == "python-from-import" and specifier.startswith("."):
        dot_count = len(specifier) - len(specifier.lstrip("."))
        module = specifier[dot_count:]
        base = path.parent
        for _ in range(max(dot_count - 1, 0)):
            base = base.parent
        if not module:
            for name in import_record.get("names", []):
                resolved = resolve_candidate(path_map, root_id, base / str(name))
                if resolved:
                    return resolved
        candidate = base / Path(module.replace(".", "/")) if module else base
        return resolve_candidate(path_map, root_id, candidate)
    if kind == "python-import" and not specifier.startswith("."):
        candidate = Path(specifier.replace(".", "/"))
        return resolve_candidate(path_map, root_id, candidate)
    if specifier.startswith("."):
        return resolve_candidate(path_map, root_id, path.parent / specifier)
    if kind == "rust-mod":
        return resolve_candidate(path_map, root_id, path.parent / specifier)
    if kind == "rust-use":
        cleaned = re.sub(r"[{}*]", "", specifier)
        first = cleaned.split("::", 1)[0]
        if first in {"crate", "self"}:
            remainder = cleaned.split("::", 1)[1] if "::" in cleaned else ""
            base = Path("") if first == "crate" else path.parent
            if remainder:
                return resolve_candidate(path_map, root_id, base / Path(remainder.replace("::", "/")))
        if first == "super":
            remainder = cleaned.split("::", 1)[1] if "::" in cleaned else ""
            base = path.parent.parent
            if remainder:
                return resolve_candidate(path_map, root_id, base / Path(remainder.replace("::", "/")))
    if kind.endswith("-include") and import_record.get("is_relative"):
        return resolve_candidate(path_map, root_id, path.parent / specifier)
    if kind in {"java-import", "kotlin-import", "csharp-using"}:
        return resolve_candidate(path_map, root_id, Path(specifier.rstrip(".*").replace(".", "/")))
    if kind in {"go-import", "swift-import"}:
        return resolve_candidate(path_map, root_id, Path(specifier.replace(".", "/")))
    return None


def build_file_segments(
    file_record: dict[str, Any],
    text: str,
    max_batch_tokens: int,
    large_file_words: int,
    max_file_segments: int,
) -> list[dict[str, Any]]:
    metrics = file_record["metrics"]
    if metrics["estimated_tokens"] <= max_batch_tokens and metrics["words"] <= large_file_words:
        return []

    reason = "large-file-word-count" if metrics["words"] > large_file_words else "large-file-token-count"
    lines = text.splitlines(keepends=True)
    if not lines and text:
        lines = [text]

    segments: list[dict[str, Any]] = []
    current_text: list[str] = []
    current_metrics = empty_metrics()
    start_line = 1
    current_line = 1

    def flush(end_line: int) -> None:
        nonlocal current_text, current_metrics, start_line
        if not current_text or len(segments) >= max_file_segments:
            return
        ordinal = len(segments) + 1
        segments.append(
            {
                "segment_id": f"segment-{file_record['file_id']}-{ordinal:04d}",
                "file_id": file_record["file_id"],
                "ordinal": ordinal,
                "start_line": start_line,
                "end_line": max(start_line, end_line),
                "metrics": dict(current_metrics),
                "reason": reason,
            }
        )
        current_text = []
        current_metrics = empty_metrics()
        start_line = end_line + 1

    for line in lines:
        line_metrics = metrics_for_text_fragment(line)
        if current_text and current_metrics["estimated_tokens"] + line_metrics["estimated_tokens"] > max_batch_tokens:
            flush(current_line - 1)
        if not current_text:
            start_line = current_line
        current_text.append(line)
        add_metrics(current_metrics, line_metrics)
        current_line += max(line_metrics["lines"], 1)
        if len(segments) >= max_file_segments:
            break
    if current_text and len(segments) < max_file_segments:
        flush(current_line - 1)

    return segments


def collect_files(
    args: argparse.Namespace, roots: list[dict[str, str]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]], dict[str, int]]:
    ignore_dirs = set(DEFAULT_IGNORE_DIRS) | set(args.ignore_dir)
    files: list[dict[str, Any]] = []
    file_segments: list[dict[str, Any]] = []
    skipped_entries: list[dict[str, str]] = []
    counters = {"skipped_count": 0, "total_bytes": 0}
    next_file_id = 1

    for root in roots:
        root_path = Path(root["path"])
        for current_dir, dirnames, filenames in os.walk(root_path):
            current = Path(current_dir)
            kept_dirs: list[str] = []
            for dirname in sorted(dirnames):
                if dirname in ignore_dirs:
                    rel = normalized_relative((current / dirname).relative_to(root_path))
                    add_skipped(skipped_entries, counters, rel, "ignored-directory", "directory")
                    continue
                kept_dirs.append(dirname)
            dirnames[:] = kept_dirs

            for filename in sorted(filenames):
                source_path = current / filename
                try:
                    resolved = source_path.resolve()
                    if not (resolved == root_path or root_path in resolved.parents):
                        rel = normalized_relative(source_path.relative_to(root_path))
                        add_skipped(skipped_entries, counters, rel, "symlink-outside-root", "file")
                        continue
                    stat = source_path.stat()
                except OSError as exc:
                    rel = normalized_relative(source_path.relative_to(root_path))
                    add_skipped(skipped_entries, counters, rel, f"stat-error:{exc.__class__.__name__}", "file")
                    continue

                rel_path = source_path.relative_to(root_path)
                rel = normalized_relative(rel_path)
                if len(files) >= args.max_files:
                    add_skipped(skipped_entries, counters, rel, "file-count-limit", "file")
                    continue
                if stat.st_size > args.max_file_bytes:
                    add_skipped(skipped_entries, counters, rel, "file-byte-limit", "file")
                    continue
                if counters["total_bytes"] + stat.st_size > args.max_total_bytes:
                    add_skipped(skipped_entries, counters, rel, "total-byte-limit", "file")
                    continue

                try:
                    data = source_path.read_bytes()
                except OSError as exc:
                    add_skipped(skipped_entries, counters, rel, f"read-error:{exc.__class__.__name__}", "file")
                    continue
                if b"\0" in data:
                    add_skipped(skipped_entries, counters, rel, "binary-file", "file")
                    continue

                text = data.decode("utf-8", errors="replace")
                language = language_for_path(source_path)
                scanner, imports, exports = scan_file(language, text)
                metrics = metrics_for_text(data, text)
                file_record = {
                    "file_id": f"file-{next_file_id:06d}",
                    "root_id": root["root_id"],
                    "path": rel,
                    "language": language,
                    "scanner": scanner,
                    "metrics": metrics,
                    "imports": imports,
                    "exports": exports,
                }
                files.append(file_record)
                file_segments.extend(
                    build_file_segments(
                        file_record,
                        text,
                        args.max_batch_tokens,
                        args.large_file_words,
                        args.max_file_segments,
                    )
                )
                next_file_id += 1
                counters["total_bytes"] += len(data)
    return files, file_segments, skipped_entries, counters


def resolve_relationships(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    path_map: dict[str, str] = {}
    for file_record in files:
        add_path_aliases(path_map, file_record["root_id"], Path(file_record["path"]), file_record["file_id"])

    relationships: list[dict[str, Any]] = []
    for file_record in files:
        for import_record in file_record["imports"]:
            resolved = resolve_import(path_map, file_record, import_record)
            import_record["resolved_file_id"] = resolved
            relationships.append(
                {
                    "from_file_id": file_record["file_id"],
                    "to_file_id": resolved,
                    "specifier": import_record["specifier"],
                    "kind": import_record["kind"],
                }
            )
    return relationships


def metric_sum(files: list[dict[str, Any]], file_ids: list[str]) -> dict[str, int]:
    by_id = {file_record["file_id"]: file_record for file_record in files}
    totals = empty_metrics()
    for file_id in file_ids:
        metrics = by_id[file_id]["metrics"]
        add_metrics(totals, metrics)
    return totals


def segment_metric_sum(file_segments: list[dict[str, Any]], segment_ids: list[str]) -> dict[str, int]:
    by_id = {segment["segment_id"]: segment for segment in file_segments}
    totals = empty_metrics()
    for segment_id in segment_ids:
        add_metrics(totals, by_id[segment_id]["metrics"])
    return totals


def language_counts(files: list[dict[str, Any]], file_ids: list[str]) -> dict[str, int]:
    by_id = {file_record["file_id"]: file_record for file_record in files}
    counts: dict[str, int] = defaultdict(int)
    for file_id in file_ids:
        counts[str(by_id[file_id]["language"])] += 1
    return dict(sorted(counts.items()))


def build_groups(files: list[dict[str, Any]], relationships: list[dict[str, Any]]) -> list[dict[str, Any]]:
    file_ids = [file_record["file_id"] for file_record in files]
    adjacency: dict[str, set[str]] = {file_id: set() for file_id in file_ids}
    related: set[str] = set()
    for relationship in relationships:
        to_file_id = relationship.get("to_file_id")
        if isinstance(to_file_id, str) and to_file_id in adjacency:
            from_file_id = relationship["from_file_id"]
            adjacency[from_file_id].add(to_file_id)
            adjacency[to_file_id].add(from_file_id)
            related.add(from_file_id)
            related.add(to_file_id)

    visited: set[str] = set()
    raw_groups: list[tuple[str, list[str], str]] = []
    for file_id in file_ids:
        if file_id in visited or file_id not in related:
            continue
        queue: deque[str] = deque([file_id])
        visited.add(file_id)
        component: list[str] = []
        while queue:
            current = queue.popleft()
            component.append(current)
            for neighbor in sorted(adjacency[current]):
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
        raw_groups.append(("dependency-component", sorted(component), "Files connected by resolved local imports."))

    by_directory: dict[str, list[str]] = defaultdict(list)
    file_by_id = {file_record["file_id"]: file_record for file_record in files}
    for file_id in file_ids:
        if file_id in visited:
            continue
        directory = str(Path(file_by_id[file_id]["path"]).parent)
        by_directory[directory].append(file_id)
    for directory in sorted(by_directory):
        raw_groups.append(
            (
                "directory-cluster",
                sorted(by_directory[directory]),
                f"Files grouped by directory fallback: {directory}.",
            )
        )

    groups: list[dict[str, Any]] = []
    for index, (reason, group_file_ids, note) in enumerate(raw_groups, start=1):
        group_file_id_set = set(group_file_ids)
        groups.append(
            {
                "group_id": f"group-{index:04d}",
                "reason": reason,
                "file_ids": group_file_ids,
                "metrics": metric_sum(files, group_file_ids),
                "language_counts": language_counts(files, group_file_ids),
                "relationship_count": sum(
                    1
                    for relationship in relationships
                    if relationship["from_file_id"] in group_file_id_set
                    and relationship.get("to_file_id") in group_file_id_set
                ),
                "notes": note,
            }
        )
    return groups


def split_files_for_batch(
    files: list[dict[str, Any]], file_ids: list[str], max_batch_tokens: int
) -> list[list[str]]:
    by_id = {file_record["file_id"]: file_record for file_record in files}
    chunks: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0
    for file_id in sorted(file_ids, key=lambda item: (by_id[item]["path"], item)):
        tokens = by_id[file_id]["metrics"]["estimated_tokens"]
        if current and current_tokens + tokens > max_batch_tokens:
            chunks.append(current)
            current = []
            current_tokens = 0
        current.append(file_id)
        current_tokens += tokens
    if current:
        chunks.append(current)
    return chunks


def build_batches(
    files: list[dict[str, Any]],
    file_segments: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    max_batch_tokens: int,
) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    pending_group_ids: list[str] = []
    pending_file_ids: list[str] = []
    pending_tokens = 0
    segments_by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for segment in file_segments:
        segments_by_file[segment["file_id"]].append(segment)

    def flush(note: str) -> None:
        nonlocal pending_group_ids, pending_file_ids, pending_tokens
        if not pending_file_ids:
            return
        batches.append(
            {
                "batch_id": f"batch-{len(batches) + 1:04d}",
                "group_ids": pending_group_ids,
                "file_ids": pending_file_ids,
                "segment_ids": [],
                "metrics": metric_sum(files, pending_file_ids),
                "language_counts": language_counts(files, pending_file_ids),
                "notes": note,
            }
        )
        pending_group_ids = []
        pending_file_ids = []
        pending_tokens = 0

    for group in groups:
        group_tokens = group["metrics"]["estimated_tokens"]
        group_has_segments = any(file_id in segments_by_file for file_id in group["file_ids"])
        if group_tokens > max_batch_tokens or group_has_segments:
            flush(f"Fits max_batch_tokens {max_batch_tokens}.")
            split_note = (
                f"Split large {group['group_id']} to respect max_batch_tokens {max_batch_tokens}."
                if group_tokens > max_batch_tokens
                else f"Split {group['group_id']} to preserve large-file segment boundaries."
            )

            def append_regular_chunk(chunk_file_ids: list[str], note: str) -> None:
                batches.append(
                    {
                        "batch_id": f"batch-{len(batches) + 1:04d}",
                        "group_ids": [group["group_id"]],
                        "file_ids": chunk_file_ids,
                        "segment_ids": [],
                        "metrics": metric_sum(files, chunk_file_ids),
                        "language_counts": language_counts(files, chunk_file_ids),
                        "notes": note,
                    }
                )

            def append_segment_batches(file_id: str) -> None:
                for segment in segments_by_file[file_id]:
                    segment_ids = [segment["segment_id"]]
                    batches.append(
                        {
                            "batch_id": f"batch-{len(batches) + 1:04d}",
                            "group_ids": [group["group_id"]],
                            "file_ids": [file_id],
                            "segment_ids": segment_ids,
                            "metrics": segment_metric_sum(file_segments, segment_ids),
                            "language_counts": language_counts(files, [file_id]),
                            "notes": (
                                f"Split large {file_id} from {group['group_id']} by line spans "
                                f"to respect max_batch_tokens {max_batch_tokens}."
                            ),
                        }
                    )

            for chunk in split_files_for_batch(files, group["file_ids"], max_batch_tokens):
                if any(file_id in segments_by_file for file_id in chunk):
                    regular_chunk: list[str] = []
                    for file_id in chunk:
                        if file_id in segments_by_file:
                            if regular_chunk:
                                append_regular_chunk(regular_chunk, split_note)
                                regular_chunk = []
                            append_segment_batches(file_id)
                        else:
                            regular_chunk.append(file_id)
                    if regular_chunk:
                        append_regular_chunk(regular_chunk, split_note)
                    continue
                append_regular_chunk(chunk, split_note)
            continue
        if pending_file_ids and pending_tokens + group_tokens > max_batch_tokens:
            flush(f"Fits max_batch_tokens {max_batch_tokens}.")
        pending_group_ids.append(group["group_id"])
        pending_file_ids.extend(group["file_ids"])
        pending_tokens += group_tokens
    flush(f"Fits max_batch_tokens {max_batch_tokens}.")
    return batches


def build_large_items(
    files: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    batches: list[dict[str, Any]],
    large_file_words: int,
    large_group_words: int,
    max_batch_tokens: int,
) -> list[dict[str, Any]]:
    large_items: list[dict[str, Any]] = []

    def reason_for(metrics: dict[str, int], word_limit: int) -> str | None:
        if metrics["words"] > word_limit:
            return "word-count-threshold"
        if metrics["estimated_tokens"] > max_batch_tokens:
            return "token-threshold"
        return None

    for file_record in files:
        reason = reason_for(file_record["metrics"], large_file_words)
        if reason:
            large_items.append(
                {
                    "item_id": file_record["file_id"],
                    "kind": "file",
                    "metrics": file_record["metrics"],
                    "reason": reason,
                    "notes": "Large source file should be assigned through file_segments or a narrow unit.",
                }
            )
    for group in groups:
        reason = reason_for(group["metrics"], large_group_words)
        if reason:
            large_items.append(
                {
                    "item_id": group["group_id"],
                    "kind": "group",
                    "metrics": group["metrics"],
                    "reason": reason,
                    "notes": "Large dependency group should be decomposed through recommended_batches.",
                }
            )
    for batch in batches:
        reason = reason_for(batch["metrics"], large_group_words)
        if reason:
            large_items.append(
                {
                    "item_id": batch["batch_id"],
                    "kind": "batch",
                    "metrics": batch["metrics"],
                    "reason": reason,
                    "notes": "Batch is still large; controller should narrow the unit before source analysis.",
                }
            )
    return large_items


def aggregate_metrics(
    files: list[dict[str, Any]],
    file_segments: list[dict[str, Any]],
    relationships: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    batches: list[dict[str, Any]],
    large_items: list[dict[str, Any]],
    skipped_count: int,
    skipped_entries: list[dict[str, str]],
) -> dict[str, int | bool]:
    file_ids = [file_record["file_id"] for file_record in files]
    totals = metric_sum(files, file_ids) if file_ids else empty_metrics()
    totals.update(
        {
            "file_count": len(files),
            "file_segment_count": len(file_segments),
            "skipped_count": skipped_count,
            "skipped_entries_truncated": skipped_count > len(skipped_entries),
            "relationship_count": len(relationships),
            "resolved_relationship_count": sum(1 for item in relationships if item.get("to_file_id")),
            "group_count": len(groups),
            "batch_count": len(batches),
            "large_item_count": len(large_items),
        }
    )
    return totals


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(data, indent=2, sort_keys=False) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        handle.write(encoded)
    try:
        os.replace(tmp_path, path)
    except OSError:
        try:
            tmp_path.unlink()
        finally:
            raise


def main() -> int:
    args = parse_args()
    if args.max_files < 1:
        raise SystemExit("--max-files must be at least 1")
    if args.max_file_bytes < 1:
        raise SystemExit("--max-file-bytes must be at least 1")
    if args.max_total_bytes < 1:
        raise SystemExit("--max-total-bytes must be at least 1")
    if args.max_batch_tokens < 1:
        raise SystemExit("--max-batch-tokens must be at least 1")
    if args.large_file_words < 1:
        raise SystemExit("--large-file-words must be at least 1")
    if args.large_group_words < 1:
        raise SystemExit("--large-group-words must be at least 1")
    if args.max_file_segments < 1:
        raise SystemExit("--max-file-segments must be at least 1")

    output_path = checked_output_path(args)
    roots = source_roots(args.source_root)
    files, file_segments, skipped_entries, counters = collect_files(args, roots)
    relationships = resolve_relationships(files)
    groups = build_groups(files, relationships)
    batches = build_batches(files, file_segments, groups, args.max_batch_tokens)
    large_items = build_large_items(
        files,
        groups,
        batches,
        args.large_file_words,
        args.large_group_words,
        args.max_batch_tokens,
    )
    now = utc_now()
    output = {
        "index_id": f"source-index-{args.task_id}",
        "task_id": args.task_id,
        "created_at": now,
        "created_by_role": "controller-preflight",
        "domain": "contaminated",
        "generator": {
            "name": "build_source_index.py",
            "version": "1",
            "python_version": platform.python_version(),
            "scanner_modes": [
                "python-ast",
                "javascript-typescript-scanner",
                "go-scanner",
                "rust-scanner",
                "java-scanner",
                "kotlin-scanner",
                "swift-scanner",
                "c-scanner",
                "cpp-scanner",
                "csharp-scanner",
                "text-metrics",
            ],
        },
        "limits": {
            "max_files": args.max_files,
            "max_file_bytes": args.max_file_bytes,
            "max_total_bytes": args.max_total_bytes,
            "max_batch_tokens": args.max_batch_tokens,
            "large_file_words": args.large_file_words,
            "large_group_words": args.large_group_words,
            "max_file_segments": args.max_file_segments,
            "ignore_dirs": sorted(set(DEFAULT_IGNORE_DIRS) | set(args.ignore_dir)),
        },
        "dependency_report": (
            None
            if args.skip_tool_detection
            else clean_room_tooling.dependency_report(args.allow_working_project_tools, args.probe_tools)
        ),
        "source_roots": roots,
        "files": files,
        "file_segments": file_segments,
        "relationships": relationships,
        "groups": groups,
        "recommended_batches": batches,
        "large_items": large_items,
        "skipped_entries": skipped_entries,
        "aggregate_metrics": aggregate_metrics(
            files,
            file_segments,
            relationships,
            groups,
            batches,
            large_items,
            counters["skipped_count"],
            skipped_entries,
        ),
    }
    atomic_write_json(output_path, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
