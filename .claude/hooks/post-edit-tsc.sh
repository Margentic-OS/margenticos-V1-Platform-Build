#!/usr/bin/env bash
# Post-edit TypeScript check. Runs as a Claude Code PostToolUse hook on Edit/Write/
# MultiEdit and type-checks the project after any .ts or .tsx file changes.
#
# CLAUDE.md: "After editing any TypeScript file, run: npx tsc --noEmit. Do not commit
# TypeScript files with type errors." That was prose. This runs it.
#
# ADVISORY, NOT BLOCKING, and that is deliberate. tsc is whole-project, so a legitimate
# mid-refactor state (a type added here, its consumer not updated yet) reports errors that
# are not defects. Blocking there would force work to be done in an unnatural order or the
# hook to be disabled, and a disabled hook checks nothing. The commit gate is where the
# hard stop belongs; this is the fast feedback that stops an error travelling far.
#
# Contract: exit 0 always. Output on stderr surfaces to the assistant as context.

set -uo pipefail

INPUT=$(cat)

FILE=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    ti = d.get("tool_input", {})
    print(ti.get("file_path") or ti.get("filePath") or "")
except Exception:
    print("")
' 2>/dev/null)

case "$FILE" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

OUT=$(npx tsc --noEmit 2>&1)
CODE=$?

if [ $CODE -ne 0 ]; then
  {
    echo "tsc --noEmit reported errors after editing $FILE:"
    printf '%s\n' "$OUT" | head -20
    echo ""
    echo "(advisory — mid-refactor states legitimately fail. The commit gate is the hard stop.)"
  } >&2
fi

exit 0
