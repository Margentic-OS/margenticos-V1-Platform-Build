// src/lib/reply-handling/insert-signoff.ts
//
// Deterministic sign-off insertion per ADR-020.
// Appends "\n\n${founderFirstName}" to the body unless:
//   - The last 100 characters already contain a recognisable closer pattern
//     (Cheers, Best, Thanks, Regards, Kind regards, All the best)
//   - The last non-empty line is exactly the founder's first name (operator typed it manually)
// In either case the body is returned as-is to avoid double sign-off.

// Closer patterns that indicate the operator already wrote a sign-off.
// Checked case-insensitively against the last 100 characters of the trimmed body.
const CLOSER_PATTERNS = [
  /\bcheers,/i,
  /\bbest,/i,
  /\bthanks,/i,
  /\bregards,/i,
  /\bkind regards,/i,
  /\ball the best,/i,
]

export function insertSignoff(body: string, founderFirstName: string): string {
  if (!founderFirstName || !founderFirstName.trim()) {
    throw new Error('insertSignoff: founderFirstName is required and must not be empty or whitespace')
  }

  const trimmed = body.trimEnd()

  // Check last 100 characters for existing closer patterns.
  const tail = trimmed.slice(-100)
  for (const pattern of CLOSER_PATTERNS) {
    if (pattern.test(tail)) return trimmed
  }

  // Check if the last non-empty line is exactly the founder's first name.
  // This handles the case where the operator typed just "Doug" at the end.
  const lines = trimmed.split('\n')
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== '')
  if (lastNonEmpty !== undefined && lastNonEmpty.trim() === founderFirstName.trim()) {
    return trimmed
  }

  return `${trimmed}\n\n${founderFirstName}`
}
