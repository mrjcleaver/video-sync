#!/usr/bin/env bash
#
# validate-catalog.sh — fast shape check on the production catalog.json.
#
# Pulls gs://video-sync-data-agentics-487016/catalog.json and asserts:
#   - top-level is a JSON object with exactly {records, lastModified} keys
#   - records is an object (map: id → wasm-json-string)
#   - lastModified is an object (map: id → ISO-string)
#   - 5 sampled records parse as JSON and have minimum VideoRecordJSON fields
#
# Exits 0 on healthy, non-zero with a clear message otherwise.
#
# Background: 2026-06-07 incident — a Python migration clobbered
# `lastModified` from object to a single ISO string, and every
# subsequent POST /api/catalog threw TypeError. The route now self-
# heals on read (P1 — catalog/route.ts:readCatalog), but a validator
# in CI/post-deploy catches the corruption seconds after it happens
# rather than waiting for downstream symptoms.
#
# Usage:
#   bash scripts/validate-catalog.sh                 # validates GCS catalog
#   bash scripts/validate-catalog.sh path/to/file    # validates a local file

set -euo pipefail

BUCKET="${VIDEO_SYNC_BUCKET:-video-sync-data-agentics-487016}"
SOURCE="${1:-}"

if [ -z "$SOURCE" ]; then
  TMP=$(mktemp -t validate-catalog.XXXXXX.json)
  trap 'rm -f "$TMP"' EXIT
  echo "==> Pulling gs://${BUCKET}/catalog.json"
  gsutil cp "gs://${BUCKET}/catalog.json" "$TMP" >/dev/null
  SOURCE="$TMP"
fi

if [ ! -f "$SOURCE" ]; then
  echo "ERR: $SOURCE not readable" >&2
  exit 2
fi

python3 - "$SOURCE" <<'PY'
import json
import sys

REQUIRED_RECORD_FIELDS = ("id", "source_id", "source_platform", "status")

path = sys.argv[1]
errors = []
warnings = []

try:
    with open(path) as f:
        cat = json.load(f)
except Exception as e:
    print(f"FAIL: cannot parse {path}: {e}")
    sys.exit(2)

if not isinstance(cat, dict):
    print(f"FAIL: top-level is {type(cat).__name__}, expected dict")
    sys.exit(2)

# Top-level shape
top_keys = set(cat.keys())
expected = {"records", "lastModified"}
missing = expected - top_keys
extra = top_keys - expected
for k in missing:
    errors.append(f"missing top-level key: {k}")
for k in extra:
    warnings.append(f"unexpected top-level key: {k} (will be ignored by readCatalog)")

records = cat.get("records")
lastmod = cat.get("lastModified")

# `records` shape
if not isinstance(records, dict):
    errors.append(f"records is {type(records).__name__}, expected dict")
    records = {}

# `lastModified` shape — the bug from 2026-06-07
if not isinstance(lastmod, dict):
    errors.append(f"lastModified is {type(lastmod).__name__}, expected dict — "
                  f"corrupt (P1 read-side coercion will repair on next POST, but fix the writer)")

# Sample 5 records (or all, if fewer) and verify shape
sample_ids = list(records.keys())[:5]
for rid in sample_ids:
    raw = records[rid]
    if not isinstance(raw, str):
        errors.append(f"record {rid}: value is {type(raw).__name__}, expected str (wasm-json-string)")
        continue
    try:
        parsed = json.loads(raw)
    except Exception as e:
        errors.append(f"record {rid}: value doesn't parse as JSON ({e})")
        continue
    if parsed.get("id") != rid:
        errors.append(f"record {rid}: inner .id is {parsed.get('id')!r}, expected matching key")
    for field in REQUIRED_RECORD_FIELDS:
        if field not in parsed:
            errors.append(f"record {rid}: missing required field {field!r}")

# Report
if warnings:
    for w in warnings:
        print(f"WARN: {w}")
if errors:
    print(f"FAIL: {len(errors)} error(s):")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print(f"OK — {len(records)} record(s), "
      f"lastModified is dict with {len(lastmod)} entry(ies)"
      + (f", {len(warnings)} warning(s)" if warnings else ""))
PY
