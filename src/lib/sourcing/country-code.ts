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
// organisation: 3 German prospects, and the only one ever excluded is craid.de, which was
// caught by the .de DOMAIN SUFFIX fallback and not by the country field at all. The other
// two, broeskamp.com and knot-consulting.com (both GmbH, Frankfurt and Waren), are
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
