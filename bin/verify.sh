#!/bin/sh
# Local PR verification. Mirrors the GitHub Actions CI checks without running npm ci.

set -eu

script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path") ;;
esac

script_dir=$(CDPATH= cd "$(dirname "$script_path")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
cd "$repo_root"

if [ -n "${PYTHON:-}" ]; then
  python_cmd=$PYTHON
elif [ -x "$repo_root/.venv/bin/python3" ]; then
  python_cmd=$repo_root/.venv/bin/python3
else
  python_cmd=python3
fi

echo "Checking JavaScript syntax..."
node --check bin/install.js
node --check lib/doctor.cjs
node --check lib/fs-utils.cjs
node --check lib/hooks.cjs
node --check lib/preflight.cjs
node --check lib/run.cjs
node --check lib/runtime-layout.cjs

echo "Running unit tests..."
npm test

echo "Validating JSON metadata..."
"$python_cmd" -m json.tool package.json >/dev/null
"$python_cmd" -m json.tool plugin.json >/dev/null
"$python_cmd" -m json.tool .codex-plugin/plugin.json >/dev/null
"$python_cmd" -m json.tool .claude-plugin/plugin.json >/dev/null

echo "Compiling Python hooks and scripts..."
"$python_cmd" -m compileall -q hooks skills/clean-room/scripts

echo "Smoke testing source index CLI..."
"$python_cmd" skills/clean-room/scripts/build_source_index.py --help >/dev/null

echo "Validating example schemas..."
for dir in skills/clean-room/examples/minimal-spec-package skills/clean-room/examples/contaminated-side; do
  for f in "$dir"/*.json; do
    printf '{"tool_input":{"file_path":"%s"}}' "$PWD/$f" \
      | CLEAN_ROOM_SCHEMA_DIR="$PWD/skills/clean-room/assets" \
        "$python_cmd" hooks/validate-json-schema.py
  done
done

echo "Running full JSON Schema draft validation..."
"$python_cmd" tests/validate_jsonschema.py

echo "Validating handoff integrity fixture..."
printf '{"tool_input":{"file_path":"%s"}}' "$PWD/skills/clean-room/examples/valid-handoff-package/handoff-package.json" \
  | CLEAN_ROOM_CLEAN_ROOTS="$PWD/skills/clean-room/examples/valid-handoff-package" \
    "$python_cmd" hooks/validate-handoff-package.py

echo "Running example leakage checks..."
for f in skills/clean-room/examples/minimal-spec-package/*.json; do
  printf '{"tool_input":{"file_path":"%s"}}' "$PWD/$f" \
    | CLEAN_ROOM_CLEAN_ROOTS="$PWD/skills/clean-room/examples/minimal-spec-package" \
      "$python_cmd" hooks/check-artifact-leakage.py
done

echo "Testing installer dry run..."
node bin/install.js --dry-run --all --global

echo "Checking package contents..."
npm pack --dry-run

echo "All local compatibility checks passed."
