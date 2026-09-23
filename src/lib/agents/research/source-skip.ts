// The error a reuse run puts on all four source stubs in place of fetching them.
//
// EXTRACTED from prospect-research-agent-v2.ts on 2026-09-23, unchanged. It moved because
// source-integrity.ts needs it and the agent imports source-integrity: leaving it where it
// was would have made those two files import each other. A circular import passes
// `tsc --noEmit` and the whole vitest suite and fails only `npm run build`, which is why
// this is a separate file rather than a cross-import.
//
// Shared by the code that WRITES the stubs and the code that READS them, because the two
// have to agree on the exact string and stating it twice is how they stop agreeing.
export const SOURCE_SKIPPED_REUSE = 'skipped: stored findings reused'
