#!/usr/bin/env bash
set -euo pipefail

# Regenerates Supabase TypeScript types and strips a known plugin artifact
# (a <claude-code-hint> XML tag) that gets appended to the file.
# See docs/BACKLOG.md [monitor] entry for context.

PROJECT_REF="hjpvnvjryxdjcfdsfhzy"
OUTPUT_FILE="src/types/database.ts"

echo "Regenerating types from project $PROJECT_REF..."
npx supabase gen types typescript --project-id "$PROJECT_REF" --schema public > "$OUTPUT_FILE.tmp"

# Strip any line containing a <claude-code-hint> tag.
# The tag is self-closing so a range delete looking for </claude-code-hint> never fires.
# A single-line pattern delete is simpler and more reliable.
sed '/[[:space:]]*<claude-code-hint/d' "$OUTPUT_FILE.tmp" > "$OUTPUT_FILE"
rm "$OUTPUT_FILE.tmp"

# Verify the project compiles cleanly. Uses tsconfig.json (skipLibCheck: true) so
# pre-existing node_modules type conflicts don't surface as false positives.
echo "Verifying TypeScript compilation..."
npx tsc --noEmit || {
  echo "ERROR: project has TypeScript errors after types regen. Investigate $OUTPUT_FILE."
  exit 1
}

echo "Types regenerated cleanly: $OUTPUT_FILE"
