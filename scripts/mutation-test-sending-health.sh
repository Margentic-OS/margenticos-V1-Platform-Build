#!/usr/bin/env bash
# Mutation test for MON-023.
#
# Breaks each threshold and each of the four states in turn, runs the suite, and reports
# how many tests fail. A mutation that produces ZERO failures means that behaviour is not
# covered and the work is not done.
#
# Every mutation is a LITERAL string replacement (perl \Q...\E), so a mutation that no
# longer matches its target reports "PATTERN DID NOT MATCH" rather than silently applying
# nothing and looking like a covered behaviour. That distinction matters: a no-op mutation
# and a fully covered one are indistinguishable by failure count alone.
#
# Restores every file it touches, including on interrupt, via the EXIT trap.
#
#   bash scripts/mutation-test-sending-health.sh

set -uo pipefail
cd "$(dirname "$0")/.."

MIGRATION=supabase/migrations/20260827120000_sending_domain_health.sql
TARGETS=(
  src/lib/sending-health/thresholds.ts
  src/lib/sending-health/evaluate.ts
  src/lib/sending-health/monitor-state.ts
  src/app/api/cron/monitor-sweep/monitors.ts
  "$MIGRATION"
)
BACKUP=$(mktemp -d)

restore() {
  for f in "${TARGETS[@]}"; do
    cp "$BACKUP/$(echo "$f" | tr '/' '_')" "$f" 2>/dev/null || true
  done
}
trap 'restore; rm -rf "$BACKUP"' EXIT INT TERM

for f in "${TARGETS[@]}"; do
  cp "$f" "$BACKUP/$(echo "$f" | tr '/' '_')"
done

SUITE="src/lib/sending-health src/app/api/cron/monitor-sweep"

# mutate <file> <literal-find> <literal-replace>
mutate() {
  FIND="$2" REPL="$3" perl -0pi -e '
    my $f = $ENV{FIND}; my $r = $ENV{REPL};
    my $n = (s/\Q$f\E/$r/s);
    exit(9) unless $n;
  ' "$1"
}

run_mutation() {
  local label="$1" file="$2" find="$3" repl="$4"
  restore
  if ! mutate "$file" "$find" "$repl"; then
    printf '%-56s  PATTERN DID NOT MATCH (mutation invalid)\n' "$label"
    return
  fi
  local out failed
  out=$(npx vitest run $SUITE 2>&1)
  failed=$(echo "$out" | grep -oE "Tests +[0-9]+ failed" | grep -oE "[0-9]+" | head -1)
  [ -z "$failed" ] && failed=0
  printf '%-56s  %3s failing test(s)\n' "$label" "$failed"
  if [ "$failed" -eq 0 ]; then
    printf '    ^^^ NOT COVERED: nothing notices this behaviour changing.\n'
  fi
}

echo "Baseline (unmutated) must be 0:"
restore
base=$(npx vitest run $SUITE 2>&1 | grep -oE "Tests +[0-9]+ failed" | grep -oE "[0-9]+" | head -1)
printf '%-56s  %3s failing test(s)\n\n' "baseline, nothing mutated" "${base:-0}"

echo "── THRESHOLDS ─────────────────────────────────────────────────────────────"
T=src/lib/sending-health/thresholds.ts
E=src/lib/sending-health/evaluate.ts
M=src/lib/sending-health/monitor-state.ts

run_mutation "T1 absolute trigger 3 -> 4          [failing]" "$T" \
  'ABSOLUTE_BOUNCE_TRIGGER = 3' 'ABSOLUTE_BOUNCE_TRIGGER = 4'
run_mutation "T1 absolute trigger 3 -> 2          [failing]" "$T" \
  'ABSOLUTE_BOUNCE_TRIGGER = 3' 'ABSOLUTE_BOUNCE_TRIGGER = 2'
run_mutation "T2 rate trigger 2% -> 5%            [failing]" "$T" \
  'RATE_BOUNCE_TRIGGER = 0.02' 'RATE_BOUNCE_TRIGGER = 0.05'
run_mutation "T2 rate boundary > becomes >=       [failing]" "$E" \
  'bounceRate > RATE_BOUNCE_TRIGGER' 'bounceRate >= RATE_BOUNCE_TRIGGER'
run_mutation "T2 floor 50 -> 10                   [insufficient]" "$T" \
  'RATE_MINIMUM_SENDS = 50' 'RATE_MINIMUM_SENDS = 10'
run_mutation "T2 floor 50 -> 200                  [insufficient]" "$T" \
  'RATE_MINIMUM_SENDS = 50' 'RATE_MINIMUM_SENDS = 200'
run_mutation "T3 window 7 -> 30 days              [all]" "$T" \
  'SENDING_HEALTH_WINDOW_DAYS = 7' 'SENDING_HEALTH_WINDOW_DAYS = 30'
run_mutation "T4 fetch lookback 3 -> 1 day        [freshness]" "$T" \
  'FETCH_LOOKBACK_DAYS = 3' 'FETCH_LOOKBACK_DAYS = 1'

echo ""
echo "── THE FOUR STATES ────────────────────────────────────────────────────────"

run_mutation "S1 healthy returned whenever nothing breached" "$E" \
  "if (domains.every(d => d.rateState === 'insufficient_sends')) return 'insufficient_sends'" \
  "/* MUTATED: state collapsed into healthy */"
run_mutation "S2 below-floor treated as within threshold" "$E" \
  "    rateState = 'insufficient_sends'" "    rateState = 'within_threshold'"
run_mutation "S2 below-floor domainState reads healthy" "$E" \
  "  } else if (rateState === 'insufficient_sends') {
    domainState = 'insufficient_sends'" \
  "  } else if (false) {
    domainState = 'insufficient_sends'"
run_mutation "S3 freshness limit 60 -> 100000 min" "$T" \
  'VERDICT_MAX_AGE_MINUTES = 60' 'VERDICT_MAX_AGE_MINUTES = 100000'
run_mutation "S3 stale reports OK instead of PROBLEM" "$M" \
  "      state: 'PROBLEM',
      healthState: 'stale'," \
  "      state: 'OK',
      healthState: 'stale',"
run_mutation "S3 freshness checked AFTER the verdict" "$M" \
  'if (ageMinutes > VERDICT_MAX_AGE_MINUTES) {' 'if (false) {'
run_mutation "S4 failing maps to OK not PROBLEM" "$M" \
  "return { state: 'PROBLEM', healthState: 'failing', detail }" \
  "return { state: 'OK', healthState: 'failing', detail }"
run_mutation "S4 absolute breach stops setting domainState" "$E" \
  "if (absoluteBreach || rateState === 'breach') {" "if (rateState === 'breach') {"
run_mutation "S4 overall never reports failing" "$E" \
  "if (domains.some(d => d.domainState === 'breach')) return 'failing'" \
  "/* MUTATED: failing unreachable */"

echo ""
echo "── SQL / TS PARITY (the duplication that cannot be removed) ───────────────"

run_mutation "P1 migration interval 60 -> 90 minutes" "$MIGRATION" \
  "interval '60 minutes'" "interval '90 minutes'"
run_mutation "P2 migration maps failing to OK" "$MIGRATION" \
  "= 'failing' THEN 'PROBLEM'" "= 'failing' THEN 'OK'"
run_mutation "P3 migration lets a writer stamp 'stale'" "$MIGRATION" \
  "overall_state IN ('no_data', 'insufficient_sends', 'healthy', 'failing')" \
  "overall_state IN ('no_data', 'insufficient_sends', 'healthy', 'failing', 'stale')"
run_mutation "P4 migration drops the idempotency constraint" "$MIGRATION" \
  "UNIQUE (stat_date, mailbox)" "UNIQUE (stat_date, mailbox, sends)"
run_mutation "P5 migration stops revoking anon on the view" "$MIGRATION" \
  "REVOKE ALL ON        public.mon_023                    FROM anon, authenticated;" \
  "-- MUTATED: revoke removed"
run_mutation "P6 MON-023 removed from the sweep registry" \
  src/app/api/cron/monitor-sweep/monitors.ts \
  "  ['MON-023', 'mon_023']," "  // MUTATED: registry entry removed"

echo ""
restore
final=$(npx vitest run $SUITE 2>&1 | grep -oE "Tests +[0-9]+ failed" | grep -oE "[0-9]+" | head -1)
printf 'after restore: %s failing test(s) (must be 0)\n' "${final:-0}"
