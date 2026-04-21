#!/usr/bin/env bash
#
# Regenerate docs/adr/README.md from the ADR files in docs/adr/.
#
# Extracts the title from the first H1 (`# ADR-NNN: Title`) and the
# status from the first `Status:` marker it finds (handles three
# variants: bold-list, table-row, or bold-colon).
#
# Run from repo root:
#   bash scripts/gen-adr-index.sh
#
# Idempotent; diff-friendly output. Commit the result.

set -euo pipefail

cd "$(dirname "$0")/.."

ADR_DIR="docs/adr"
OUT="${ADR_DIR}/README.md"

if [[ ! -d "$ADR_DIR" ]]; then
  echo "Error: $ADR_DIR not found" >&2
  exit 1
fi

# Generate table rows, one per ADR file, numerically sorted
rows=""
while IFS= read -r f; do
  base=$(basename "$f")
  num=$(echo "$base" | sed -n 's/^ADR-\([0-9]\{3\}\)-.*/\1/p')
  [[ -z "$num" ]] && continue

  # Title: first H1 line. Strip leading "# ADR-NNN: " and anything in brackets.
  title=$(awk '/^# /{print; exit}' "$f" | sed -E 's/^# *ADR-[0-9]{3}:? *//')

  # Status: look for patterns in order of precedence
  # 1) "| **Status** | VALUE |"  (table row)
  # 2) "**Status**: VALUE"        (bold-list)
  # 3) "**Status:** VALUE"        (bold-colon)
  # 4) "Status: VALUE"            (plain)
  status=$(sed -n -E \
    -e 's/^\| *\*\*Status\*\* *\| *([^|]+[^ |]) *\|.*$/\1/p' \
    -e 's/^\*\*Status\*\*: *(.*)$/\1/p' \
    -e 's/^\*\*Status:\*\* *(.*)$/\1/p' \
    -e 's/^Status: *(.*)$/\1/p' \
    "$f" | head -1)
  # Trim trailing whitespace
  status="${status%"${status##*[![:space:]]}"}"
  [[ -z "$status" ]] && status="—"

  rows+="| [ADR-${num}](${base}) | ${title} | ${status} |"$'\n'
done < <(ls "$ADR_DIR"/ADR-*.md 2>/dev/null | sort -V)

cat > "$OUT" <<EOF
# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records for **video-sync** (a.k.a. the **Unified Video Indexing & Publishing Bridge**, VID-BRIDGE-01).

## Index

| ADR | Title | Status |
|-----|-------|--------|
$(printf '%s' "$rows")

## ADR Format

Each ADR follows the standard format:
- **Status**: Proposed / Accepted / Deprecated / Superseded (some records are marked *Proposed (exploration)* for design ADRs that don't commit to an implementation)
- **Context**: The forces at play
- **Decision**: What we decided
- **Consequences**: The resulting context

Addenda may be appended to an ADR when the decision evolves in a way that doesn't invalidate the original — see ADR-012, ADR-016, ADR-017, ADR-018 for examples.

## Regenerating this index

This file is generated from the ADR headers. To refresh after adding or editing ADRs:

\`\`\`bash
bash scripts/gen-adr-index.sh
\`\`\`

Commit the result alongside the ADR change.
EOF

echo "Wrote $OUT"
