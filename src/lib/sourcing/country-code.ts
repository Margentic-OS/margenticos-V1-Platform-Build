// Canonical country representation for prospects.country.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: THE DE EXCLUSION HAS ALREADY FAILED IN PRODUCTION
//
// Found 2026-08-25 while preparing the catch-all second pass. The country exclusion is
// not merely unpopulated, as the handover recorded. It is a FORMAT MISMATCH, and it has
// already let two prospects through.
//
//   adapter-apollo-enrichment.ts writes Apollo's country string verbatim: "Germany".
//   send-eligibility-rules.ts compares against EXCLUDED_COUNTRIES = new Set(['DE']).
//
// "Germany" is not "DE", so the check returns eligible. Measured on the live client-zero
// organisation: 3 German prospects, and the only one ever excluded is example.de, which was
// caught by the .de DOMAIN SUFFIX fallback and not by the country field at all. The other
// two, halden.example.com and merrow.example.com (both GmbH, Germany), are
// email_send_eligible = true and outbound_upload_status = 'uploaded'. They were mailed.
//
// The handover's claim that "new prospects are unaffected because the adapter writes
// country on every new enrichment" is therefore wrong in the direction that matters. The
// adapter writes a value the rule cannot match, so every future German prospect on a
// non-.de domain would have gone the same way.
//
// Both sides were individually correct and fully tested. send-eligibility-rules.test.ts
// asserts 'DE' and 'US' and passes. Nothing tested the seam between the producer and the
// consumer, which is where the whole defect lived.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE CANONICAL FORM IS ISO 3166-1 ALPHA-2
//
// This follows CLAUDE.md's industry-naming rule applied to jurisdiction: storage and
// filter specifications use one canonical vocabulary, and each handler owns the
// translation from its vendor's vocabulary into it. Apollo says "Germany"; the Apollo
// handler translates; nothing downstream of the handler sees a vendor's spelling.
//
// ISO-2 was chosen over full names because it is what the exclusion rule and its tests
// already assume, because it is stable (a country's English name is not), and because the
// adapter's own comment says the column has to be filterable in a WHERE clause, which a
// mixed-format column is not.

import { logger } from '@/lib/logger'

/**
 * Country name and code aliases mapped to ISO 3166-1 alpha-2.
 *
 * DELIBERATELY NOT THE FULL 249-ENTRY ISO TABLE. This covers every country that appears
 * in live data plus the anglosphere and EU markets the ICP filter specifications target.
 * Anything outside it is preserved verbatim rather than discarded (see below), so an
 * unmapped country costs a log line and a one-line addition here, never silent data loss.
 *
 * Keys are compared after uppercasing and collapsing whitespace, so "united states" and
 * "United States" both hit "UNITED STATES".
 */
const COUNTRY_ALIASES: Record<string, string> = {
  // Live in the client-zero organisation as at 2026-08-25
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  USA: 'US',
  'GERMANY': 'DE',
  DEUTSCHLAND: 'DE',
  CANADA: 'CA',
  AUSTRALIA: 'AU',

  // Anglosphere and the EU/EEA markets the ICP specs target
  'UNITED KINGDOM': 'GB',
  'GREAT BRITAIN': 'GB',
  ENGLAND: 'GB',
  SCOTLAND: 'GB',
  WALES: 'GB',
  'NORTHERN IRELAND': 'GB',
  UK: 'GB',
  IRELAND: 'IE',
  'REPUBLIC OF IRELAND': 'IE',
  'NEW ZEALAND': 'NZ',
  'SOUTH AFRICA': 'ZA',
  INDIA: 'IN',
  SINGAPORE: 'SG',
  'HONG KONG': 'HK',
  'UNITED ARAB EMIRATES': 'AE',
  UAE: 'AE',
  ISRAEL: 'IL',
  JAPAN: 'JP',
  'SOUTH KOREA': 'KR',
  'KOREA, REPUBLIC OF': 'KR',
  CHINA: 'CN',
  BRAZIL: 'BR',
  MEXICO: 'MX',
  ARGENTINA: 'AR',
  CHILE: 'CL',

  AUSTRIA: 'AT',
  BELGIUM: 'BE',
  BULGARIA: 'BG',
  CROATIA: 'HR',
  CYPRUS: 'CY',
  'CZECH REPUBLIC': 'CZ',
  CZECHIA: 'CZ',
  DENMARK: 'DK',
  ESTONIA: 'EE',
  FINLAND: 'FI',
  FRANCE: 'FR',
  GREECE: 'GR',
  HUNGARY: 'HU',
  ICELAND: 'IS',
  ITALY: 'IT',
  LATVIA: 'LV',
  LIECHTENSTEIN: 'LI',
  LITHUANIA: 'LT',
  LUXEMBOURG: 'LU',
  MALTA: 'MT',
  NETHERLANDS: 'NL',
  'THE NETHERLANDS': 'NL',
  NORWAY: 'NO',
  POLAND: 'PL',
  PORTUGAL: 'PT',
  ROMANIA: 'RO',
  SLOVAKIA: 'SK',
  SLOVENIA: 'SI',
  SPAIN: 'ES',
  SWEDEN: 'SE',
  SWITZERLAND: 'CH',

  // ISO 3166-1 alpha-3 for the excluded jurisdiction, because a vendor that emits alpha-3
  // must not be able to defeat a compliance rule on a spelling.
  DEU: 'DE',
}

/** Uppercase, trim, and collapse internal whitespace so lookups are spelling-tolerant. */
function normaliseKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ')
}

/**
 * Translate a vendor's country string into canonical ISO 3166-1 alpha-2.
 *
 * UNMAPPED INPUT IS RETURNED VERBATIM, NOT NULLED. Returning null on an unrecognised
 * country would silently erase the only jurisdiction signal on the record, which is the
 * failure mode this whole module exists to close. Returning the raw string keeps the
 * information, and checkSendEligibility normalises independently, so an unmapped excluded
 * country is still caught. The warning is how the alias table grows.
 */
export function toIso2CountryCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed === '') return null

  const key = normaliseKey(trimmed)

  // Already canonical: a bare two-letter code is taken as ISO-2 as-is.
  if (/^[A-Z]{2}$/.test(key)) return key

  const mapped = COUNTRY_ALIASES[key]
  if (mapped) return mapped

  logger.warn('country-code: unmapped country name, stored verbatim', {
    raw: trimmed,
    consequence:
      'prospects.country holds a non-canonical value for this row. Add it to ' +
      'COUNTRY_ALIASES in src/lib/sourcing/country-code.ts.',
  })
  return trimmed
}

/**
 * Every ISO-2 code this module can produce, derived from the alias table.
 *
 * Exists so that callers who need to reason about the GAP between what the platform
 * recognises and what a given sourcing handler can reach do not have to read the table's
 * internals or restate any part of it. That gap is real: a handler's translation table is
 * smaller than this, and a country in the difference is one an ICP can legitimately name
 * and no query can express.
 */
export function knownIso2CountryCodes(): Set<string> {
  return new Set(Object.values(COUNTRY_ALIASES))
}

/**
 * Every spelling that means "this ISO-2 code", for callers that must compare a possibly
 * un-normalised stored value against a code. Used by the send-eligibility rule so a
 * compliance exclusion cannot be defeated by a format that predates this module.
 */
export function aliasesForIso2(code: string): Set<string> {
  const target = code.trim().toUpperCase()
  const out = new Set<string>([target])
  for (const [alias, mapped] of Object.entries(COUNTRY_ALIASES)) {
    if (mapped === target) out.add(alias)
  }
  return out
}

// ─── The selectable list ─────────────────────────────────────────────────────

export interface CountryOption {
  /** ISO 3166-1 alpha-2. The identity an option is deduplicated by, never the stored value. */
  code: string
  /** What a client sees AND what gets stored. Resolves to `code` by construction. */
  name: string
}

/**
 * True for an alias that is an abbreviation rather than a country's name.
 *
 * One word, three letters or fewer. That covers the alpha-3 and the informal short forms in
 * the table above and excludes every name in it, the shortest of which is longer than three
 * letters. A bare two-letter code never reaches here anyway: toIso2CountryCode treats it as
 * canonical before consulting the table at all.
 */
function isAbbreviation(alias: string): boolean {
  return !alias.includes(' ') && alias.length <= 3
}

/** 'CZECH REPUBLIC' to 'Czech Republic'. The table is keyed in upper case for lookup only. */
function titleCase(alias: string): string {
  return alias
    .split(' ')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * One selectable option per ISO-2 code this platform recognises, sorted by name.
 *
 * ─── WHY THIS IS DERIVED AND NOT A SECOND LIST ───────────────────────────────
 *
 * A hand-written list of selectable countries beside COUNTRY_ALIASES would be two lists that
 * must agree, walked separately, which is the parallel-array defect this project has already
 * paid for three times. Worse, the two failure directions are both silent: a country offered
 * here and absent from the table is one a client can choose and `toCanonicalCode` in the
 * geography agent then REFUSES, stopping a filter-spec derivation days later; a country in the
 * table and missing here is simply unreachable. Deriving means neither can be expressed.
 *
 * ─── WHICH ALIAS BECOMES THE NAME ────────────────────────────────────────────
 *
 * The FIRST non-abbreviation alias listed for each code. The table is written primary name
 * first within each country's group, so this reads the intent already in it rather than adding
 * a ranking of its own. That is a real dependency on key order and it is stated here because
 * it is otherwise invisible: inserting an alias ABOVE a country's primary name changes what
 * this offers. It cannot make the option wrong, only differently worded, because every value
 * still round-trips through toIso2CountryCode and a test proves it for all of them.
 *
 * ONE OPTION PER CODE, which is the half that matters most. Several aliases here are not
 * countries in their own right and must never be separately selectable; collapsing on the code
 * makes offering one a thing the derivation cannot do.
 */
/**
 * The option a string names, or null when it names no country this platform recognises.
 *
 * WHY THIS AND NOT toIso2CountryCode. That function is built for the enrichment path, where an
 * unrecognised country must never be discarded: it returns the input verbatim and LOGS, and
 * its log line names prospects.country as the consequence. A caller validating a client's
 * answer on a form wants the opposite of both halves. It wants a plain "no", and an answer
 * that is not a country is not a data-quality incident on a table this code has never touched.
 *
 * The resolution rules are otherwise identical, and they are identical because they are the
 * same table read the same way: a bare two-letter code, then the alias lookup.
 */
export function findCountryOption(raw: string): CountryOption | null {
  const key = normaliseKey(raw)
  if (!key) return null
  const code = /^[A-Z]{2}$/.test(key) ? key : COUNTRY_ALIASES[key]
  if (!code) return null
  return selectableCountries().find(option => option.code === code) ?? null
}

export function selectableCountries(): readonly CountryOption[] {
  const nameByCode = new Map<string, string>()
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (nameByCode.has(code)) continue
    if (isAbbreviation(alias)) continue
    nameByCode.set(code, titleCase(alias))
  }
  return [...nameByCode]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
