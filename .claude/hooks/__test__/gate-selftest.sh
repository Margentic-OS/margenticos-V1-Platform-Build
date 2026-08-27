#!/usr/bin/env bash
# Self-test for .claude/hooks/pre-commit-gate.sh.
#
#   bash .claude/hooks/__test__/gate-selftest.sh
#
# Each case stages something, runs the gate, and checks it blocks or allows as intended.
# It stages and unstages only its own probe files and restores the index afterwards.
#
# The FOUR-ALLOW cases matter as much as the blocks. A gate that blocks everything is not
# a gate, it is an outage, and the two most important allows are:
#   - a commit that REMOVES a secret (the fix commit must not be blocked)
#   - a vendor name inside a COMMENT (naming the vendor while explaining a decision is
#     good practice; forbidding it produces worse comments, not better code)

set -uo pipefail
cd "$(dirname "$0")/../../.."

GATE=.claude/hooks/pre-commit-gate.sh
PAYLOAD=$(mktemp)
python3 -c '
import json
json.dump({"tool_name":"Bash","tool_input":{"command":"git " + "commit -m x"}}, open("'"$PAYLOAD"'","w"))
'

PASS=0; FAIL=0
cleanup() {
  git reset -q -- src/lib/__gate_probe__ .env.__probe__ 2>/dev/null || true
  rm -rf src/lib/__gate_probe__ .env.__probe__
  rm -f "$PAYLOAD"
}
trap cleanup EXIT

# expect <BLOCK|ALLOW> <label>
expect() {
  local want="$1" label="$2" out code
  out=$(bash "$GATE" < "$PAYLOAD" 2>&1); code=$?
  local got="ALLOW"; [ $code -eq 2 ] && got="BLOCK"
  if [ "$got" = "$want" ]; then
    printf '  PASS  %-52s (%s)\n' "$label" "$got"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-52s wanted %s got %s\n' "$label" "$want" "$got"; FAIL=$((FAIL+1))
    printf '%s\n' "$out" | sed 's/^/        /' | head -6
  fi
}

# ── Fixtures are ASSEMBLED AT RUNTIME, never written as literals ─────────────
#
# This file is a test for a secret scanner, so its fixtures are secret-SHAPED by
# definition. Written as literals they make this very file unstageable: the gate blocked
# its own commit the first time, correctly.
#
# The fix is assembly rather than an exemption. `"sk-" + "ant-..."` produces the right
# string on disk while no secret-shaped substring exists in the source, so the check stays
# UNIVERSAL with no directory carved out of it. An exemption for this folder would have
# been the easy answer and would have created a place where a real secret could hide.
#
# None of these values is real. They are repeated characters and the word NOTAREAL.
write_probe() {
  python3 -c "open('src/lib/__gate_probe__/a.ts','w').write(\"export const S = '\" + $1 + \"'\n\")"
}

mkdir -p src/lib/__gate_probe__

echo "── SECRET PATTERNS (must BLOCK) ────────────────────────────────────────"

# Every value below is FAKE, generated from repeating characters, and is not a
# credential from any system.
python3 -c "open('src/lib/__gate_probe__/a.ts','w').write(\"export const S = '\" + 'de'*32 + \"'\n\")"
git add src/lib/__gate_probe__/a.ts; expect BLOCK "64-char hex"; git reset -q -- src/lib/__gate_probe__/a.ts

python3 -c "open('src/lib/__gate_probe__/a.ts','w').write(\"export const S = '\" + 'ab'*16 + \"'\n\")"
git add src/lib/__gate_probe__/a.ts; expect BLOCK "32-char hex"; git reset -q -- src/lib/__gate_probe__/a.ts

write_probe "\"ey\" + \"J\" + \"hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9fake\""
git add src/lib/__gate_probe__/a.ts; expect BLOCK "JWT"; git reset -q -- src/lib/__gate_probe__/a.ts

write_probe "\"sk-\" + \"ant-api03-NOTAREALKEYNOTAREAL\""
git add src/lib/__gate_probe__/a.ts; expect BLOCK "Anthropic key"; git reset -q -- src/lib/__gate_probe__/a.ts

write_probe "\"re_\" + \"NOTAREALKEYNOTAREALKEY\""
git add src/lib/__gate_probe__/a.ts; expect BLOCK "Resend key"; git reset -q -- src/lib/__gate_probe__/a.ts

write_probe "\"Bearer \" + \"NOTAREALTOKENNOTAREALTOKEN\""
git add src/lib/__gate_probe__/a.ts; expect BLOCK "bearer literal"; git reset -q -- src/lib/__gate_probe__/a.ts

echo ""
echo "── .ENV (must BLOCK) ───────────────────────────────────────────────────"
printf 'X=1\n' > .env.__probe__
git add -f .env.__probe__ 2>/dev/null
expect BLOCK ".env file staged"
git reset -q -- .env.__probe__; rm -f .env.__probe__

echo ""
echo "── VENDOR NAMES (ADR-001) ──────────────────────────────────────────────"
printf "export function s() {\n  const p = 'Instantly'\n  return p\n}\n" > src/lib/__gate_probe__/a.ts
git add src/lib/__gate_probe__/a.ts; expect BLOCK "vendor name in CODE outside integrations"
git reset -q -- src/lib/__gate_probe__/a.ts

printf "// Translated from Instantly numeric status in the handler, never here.\nexport const X = 1\n" > src/lib/__gate_probe__/a.ts
git add src/lib/__gate_probe__/a.ts; expect ALLOW "vendor name in a COMMENT only"
git reset -q -- src/lib/__gate_probe__/a.ts

echo ""
echo "── MUST ALLOW ──────────────────────────────────────────────────────────"
printf "export const X = 1\n" > src/lib/__gate_probe__/a.ts
git add src/lib/__gate_probe__/a.ts; expect ALLOW "ordinary code"
git reset -q -- src/lib/__gate_probe__/a.ts

# THE IMPORTANT ONE. Committing the REMOVAL of a secret must not be blocked, or the fix
# commit becomes impossible and the gate would actively protect the leak.
#
# The gate reads ADDED lines only, so this is what a scrub commit looks like: the secret
# leaves on a '-' line and a placeholder arrives on a '+' line.
#
# NO STASH. An earlier version of this test used `git stash --staged` to set up a tracked
# baseline, which left a stash entry containing the fake secret behind after the run. A
# test that leaves residue in the repository is worse than one that covers slightly less.
printf "export const S = 'REDACTED'\n" > src/lib/__gate_probe__/b.ts
git add -f src/lib/__gate_probe__/b.ts >/dev/null 2>&1
expect ALLOW "scrub commit: placeholder added, no secret in added lines"
git reset -q -- src/lib/__gate_probe__/b.ts

echo ""
printf 'gate self-test: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
