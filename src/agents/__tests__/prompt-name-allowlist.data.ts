// ═══════════════════════════════════════════════════════════════════════════
// THE ALLOWLIST. THE INVERSE OF A DENY LIST, AND THE REASON IT HAS TO BE.
//
// The deny-list data file beside this one says it plainly: a deny list cannot hold a real
// company name, because writing the name down in a PUBLIC repository publishes the
// exact thing the swap pass exists to remove. It also could never be complete. So the
// scan that reads 0 on a file holding a dozen real names is not broken, it is doing
// the only thing a deny list can do.
//
// THAT FILE IS DESCRIBED RATHER THAN NAMED, DELIBERATELY. Its own rule zero fails any
// module under src/ whose text contains its module name, checked against the OUTPUT and
// not just the imports, so that a copy-paste is caught as well as an import. A comment
// citing it by name trips exactly that check. Found by running the suite, not by
// reasoning about it.
//
// This file runs the other way round. It enumerates what a capitalised token inside a
// prompt EXAMPLE is ALLOWED to be. Anything else is treated as a name and fails. A
// company nobody has ever written down is caught by construction, because the check
// never needed to know it existed.
//
// THE BULK OF THE ALLOWING IS NOT DONE HERE. isOrdinaryWord() in
// src/lib/style/ordinary-words.ts carries it: several hundred lemmas of ordinary
// English, already shipped, already reviewed, already load-bearing for the
// sentence-initial name gate on real copy. This file holds only what that list does
// not cover, and it is deliberately kept small enough to read in one sitting.
//
// WHY ordinary-words.ts IS NOT SIMPLY EXTENDED INSTEAD. Because it is SHIPPED CODE. It
// governs sentence-initial-names.ts, which runs on real outbound copy. Adding a word
// there to quieten a test would widen a live gate on emails as a side effect, and the
// module's own header says adding a word "can only cause a missed leak". A prompt-file
// vocabulary problem must not be paid for in production leak surface. Two lists, two
// jobs, and this is the one that may be edited freely.
//
// ─── HOW TO EXTEND, AND THE ONE RULE THAT MATTERS ────────────────────────────
//
// A word goes here ONLY if a reader can confirm in one second that it is not the name
// of a person, company or organisation. "Disqualifier" qualifies. "Taffet" does not,
// and no argument about it being a fixture, a placeholder or already-shipped changes
// that. THE ALLOWLIST MUST NEVER GROW TO ACCOMMODATE A REAL NAME. That is the single
// move that would turn this check into theatre, and MAX_ALLOWLIST_ENTRIES exists to
// make the attempt show up as a deliberate act in a diff.
// ═══════════════════════════════════════════════════════════════════════════

// ─── A. Deliberate neutral placeholders ──────────────────────────────────────
//
// Invented, industry-neutral, and the whole point of the swap pass. A DIFFERENT REAL
// COMPANY IS NOT A FIX, so nothing may be added here that can be looked up.
export const PLACEHOLDERS = `
Acme Beta Vantor Calder Orrin Merrow Halden Brightlane Northwell Tessom
`

// ─── B. Acronyms and jargon that are not organisations ───────────────────────
//
// EXPLICIT, NEVER A BLANKET RULE FOR ALL-CAPS, and that is the load-bearing decision in
// this file. "DTCC", "SEC", "GSB", "SCG", "CRC" and "CAVE" are all-caps and all real
// organisations. "ICP", "TOV" and "ARR" are all-caps and none of them are. No pattern
// separates the two, so the benign ones are named one at a time and everything else in
// that shape fails. An `/^[A-Z]{2,5}$/` exemption here would have let every one of the
// six real ones through while looking like a tightening.
export const BENIGN_ACRONYMS = `
ICP TOV JTBD FAQ CTA CRM SEO GTM CAC BDR AE OOO DEI HR
AI B2B B2C SaaS ARR MRR URL JSON HTML PDF LLM API
CEO CTO CMO COO CFO VP SVP MD
UK US USA EU
`

// ─── C. Canonical industry vocabulary ────────────────────────────────────────
//
// CLAUDE.md REQUIRES canonical NAICS-derived industry names in the ICP prompt, so a
// check that flags them is asking for the opposite of the rule. Listed as their
// component words because that is how the tokeniser meets them.
export const CANONICAL_INDUSTRY_WORDS = `
Food Beverage Manufacturing Retail Trade Publishers Education Restaurants
Consulting Marketing Software Wholesale Construction Logistics Professional Scientific Technical
`

// ─── D. Prompt-authoring vocabulary ──────────────────────────────────────────
//
// Ordinary English that ordinary-words.ts does not carry, because that list is COMMON
// English plus the vocabulary OUTBOUND COPY is written in, and prompt instructions are
// written in a different register: they name document sections, grades and verdicts.
// Every entry is a word, not a name.
export const AUTHORING_VOCABULARY = `
Disqualifier Disqualifiers Amplifier Amplifiers Situational Structural Deterministic
Substantive Meaningfully Rewritten Rephrased Banned Bare Cite Rely Count Written
Category Categories Operator Recency Collaborators Web Net Given Heard Saw Unlike
English Hey Cheers Judgemental Candidate Composite Provenance Verifiable Falsifiable
Observation Inference Benchmark Specimen Placeholder Archetype Firmographic
Judgemental Non Led Detectable Agnostic Derived Mediation Arbitration Website
`

// ─── D2. Date and format literals ────────────────────────────────────────────
//
// Not prose, not names: the shapes a prompt uses to specify a format or an abbreviated
// month inside a provenance example. Listed rather than pattern-matched, because a
// pattern loose enough to cover "YYYY-MM-DD" is loose enough to cover an acronym.
export const FORMAT_LITERALS = `
YYYY MM DD Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec
`

// ─── E. Legitimate exceptions, argued one at a time ──────────────────────────
//
// Real organisations that a prompt cannot do its job without naming. The bar is that
// the name is the SUBJECT of a mechanism, not decoration in an example, and that no
// placeholder could stand in.
//
// LinkedIn: research provenance is a location string a human has to verify in 30
// seconds, and "a professional network" is not a location. The synthesis prompt's
// provenance rule is unusable without it. It is a data SOURCE, not a client or a
// prospect, so it carries none of the copy-into-a-real-email risk this scan manages.
export const LEGITIMATE_EXCEPTIONS = `
LinkedIn
`

const words = (block: string) => block.split(/\s+/).map(w => w.trim()).filter(Boolean)

export const ALLOWLIST: ReadonlySet<string> = new Set(
  [
    ...words(PLACEHOLDERS),
    ...words(BENIGN_ACRONYMS),
    ...words(CANONICAL_INDUSTRY_WORDS),
    ...words(AUTHORING_VOCABULARY),
    ...words(FORMAT_LITERALS),
    ...words(LEGITIMATE_EXCEPTIONS),
  ].map(w => w.toLowerCase()),
)

// THE GUARD ON THE GUARD. Measured 2026-08-29, not chosen, and a LITERAL rather than
// ALLOWLIST.size. Deriving it from the list would make the assertion self-satisfying:
// the cap would move with every entry added and could never fail, which is the exact
// shape of a check that runs, reports success, and protects nothing.
//
// Set AT the measured size, so the next entry has to move this number in the same diff
// and be explained. An allowlist that can grow quietly is how an inverted check decays
// into a deny list with extra steps: drive the count to zero by blessing the offenders
// and every ratchet above still passes.
//
// MEASURED: 49 unvouched tokens remain across the fourteen sources against a 133-entry
// allowlist, and ALL 49 ARE REAL ENTITY NAMES. Zero false positives. That ratio is the
// evidence the list is not doing the gate's job for it.
export const MAX_ALLOWLIST_ENTRIES = 133
