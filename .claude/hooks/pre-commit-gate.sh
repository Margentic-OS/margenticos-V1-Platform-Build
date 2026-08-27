#!/usr/bin/env bash
# Commit gate. Runs as a Claude Code PreToolUse hook on Bash, and blocks `git commit`
# when the STAGED diff fails any of three checks.
#
#   1. SECRETS      64/32-char hex, JWTs, sk-/sk-ant-/re_ keys, bearer literals
#   2. .env         any .env file being committed
#   3. VENDOR NAMES a hardcoded tool name outside the integrations handler layer
#
# WHY THIS EXISTS. CLAUDE.md has described checks 2 and 3 as "hooks — three checks always
# active" since the project started, but they were prose, not code: nothing executed them,
# so they ran only when someone remembered. On 2026-08-26 a live webhook secret reached a
# PUBLIC repository inside a schema dump and stayed there until a manual scan found it the
# next day. A rule that depends on remembering is not a control.
#
# THE CHECK IS ON THE STAGED DIFF, not the working tree, because that is exactly what the
# commit will contain. Checking the working tree would both miss staged-then-reverted
# content and fire on unrelated scratch files.
#
# Contract with Claude Code: read the tool call as JSON on stdin, exit 2 with a reason on
# stderr to BLOCK, exit 0 to allow. Anything that is not a git commit is allowed
# immediately and costs nothing.

set -uo pipefail

INPUT=$(cat)

# Only interested in `git commit`. Everything else passes straight through.
CMD=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' 2>/dev/null)

case "$CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# `git commit --amend --no-edit` on an already-checked commit, and commits with nothing
# staged, have no new content to police.
STAGED=$(git diff --cached --name-only 2>/dev/null)
[ -z "$STAGED" ] && exit 0

FAILURES=""
add_failure() { FAILURES="${FAILURES}$1"$'\n'; }

# ── 1. SECRETS ───────────────────────────────────────────────────────────────
#
# Added lines only. A deletion that removes a secret must not be blocked: that is the
# commit that FIXES the problem, and blocking it would be actively harmful.
ADDED=$(git diff --cached -U0 --diff-filter=d 2>/dev/null | grep '^+' | grep -v '^+++' || true)

check_secret() {
  local label="$1" pattern="$2"
  local hits
  hits=$(printf '%s' "$ADDED" | grep -oE "$pattern" | head -3 || true)
  if [ -n "$hits" ]; then
    # Never echo the value. First 6 characters is enough to locate it, useless to a thief.
    local redacted
    redacted=$(printf '%s' "$hits" | cut -c1-6 | sed 's/$/…[redacted]/' | tr '\n' ' ')
    add_failure "  SECRET ($label): $redacted"
  fi
}

check_secret "64-char hex, e.g. openssl rand -hex 32" '\b[0-9a-f]{64}\b'
check_secret "32-char hex"                            '\b[0-9a-f]{32}\b'
check_secret "JWT"                                    '\beyJ[A-Za-z0-9_-]{20,}'
check_secret "Anthropic key"                          '\bsk-ant-[A-Za-z0-9_-]{10,}'
check_secret "generic sk- key"                        '\bsk-[A-Za-z0-9]{20,}'
check_secret "Resend key"                             '\bre_[A-Za-z0-9]{15,}'
check_secret "AWS access key"                         '\bAKIA[0-9A-Z]{16}\b'
check_secret "GitHub token"                           '\bghp_[A-Za-z0-9]{20,}'
check_secret "bearer literal"                         'Bearer[[:space:]]+[A-Za-z0-9_.-]{20,}'

# ── 2. .env ──────────────────────────────────────────────────────────────────
#
# Two halves. A .env file being committed, and .env missing from .gitignore. The second is
# the one CLAUDE.md asks for on every commit and the one that stops the first recurring.
ENV_STAGED=$(printf '%s' "$STAGED" | grep -E '(^|/)\.env' | grep -v '\.example$' || true)
[ -n "$ENV_STAGED" ] && add_failure "  .ENV FILE STAGED: $(printf '%s' "$ENV_STAGED" | tr '\n' ' ')"

if [ -f .gitignore ] && ! grep -qE '^\.env$' .gitignore; then
  add_failure "  .gitignore does not list .env"
fi

# ── 3. VENDOR NAMES ──────────────────────────────────────────────────────────
#
# ADR-001. A tool name belongs inside a handler in the integrations layer and nowhere else.
# Comments are exempt: naming the vendor while EXPLAINING a decision is good practice, and
# a check that forbids it would push people to write worse comments rather than better
# code. This looks at added CODE lines only.
#
# MyEmailVerifier is on this list because its absence is exactly why the literal string
# reached a database column default. Any new vendor goes on this list in the same commit
# that introduces its handler.
VENDORS='Instantly|Taplio|Lemlist|Apollo|GoHighLevel|Calendly|HunterIO|MyEmailVerifier|Bouncer|Apify|Brave'

VENDOR_HITS=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/lib/integrations/*)  continue ;;   # the handler layer, where names belong
    src/lib/sourcing/handlers/*) continue ;;
    *.md|*.sql|*.json|*.sh)  continue ;;   # docs, migrations, config, scripts
    *test*|*__tests__*)      continue ;;   # fixtures name the tool they fake
    src/*.ts|src/*.tsx|src/**/*.ts|src/**/*.tsx) ;;
    *) continue ;;
  esac
  hit=$(git diff --cached -U0 -- "$file" 2>/dev/null \
        | grep '^+' | grep -v '^+++' \
        | sed 's|//.*||' | sed 's|^\+[[:space:]]*\*.*||' \
        | grep -oE "\b($VENDORS)\b" | sort -u | tr '\n' ' ' || true)
  [ -n "$hit" ] && VENDOR_HITS="${VENDOR_HITS}    $file: $hit"$'\n'
done <<< "$STAGED"

if [ -n "$VENDOR_HITS" ]; then
  add_failure "  VENDOR NAME IN CODE OUTSIDE THE INTEGRATIONS LAYER (ADR-001):"$'\n'"$VENDOR_HITS"
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ -n "$FAILURES" ]; then
  {
    echo "COMMIT BLOCKED by .claude/hooks/pre-commit-gate.sh"
    echo ""
    printf '%s' "$FAILURES"
    echo ""
    echo "Fix the staged content, or unstage it. Do not bypass this hook."
    echo "If a match is a false positive, narrow the pattern in the hook rather than"
    echo "removing the check, and say so in the commit message."
  } >&2
  exit 2
fi

exit 0
