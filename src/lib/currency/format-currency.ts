// One place that turns an organisation's currency and an amount into what a client sees.
//
// WHY THIS EXISTS. Both pipeline cards formatted money with a hardcoded pound sign and
// neither read organisations.currency, so a client whose record said EUR was shown their
// pipeline value in pounds. Two copies of the same wrong thing is how that survived
// unnoticed; one function is what stops it coming back. Any new money on a client screen
// imports this rather than writing a symbol.

/** The three values organisations_currency_check admits. Read live 2026-09-15. */
export type OrganisationCurrency = 'GBP' | 'EUR' | 'USD'

const CURRENCY_SYMBOLS: Record<OrganisationCurrency, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
}

/**
 * What an organisation with no readable currency renders as.
 *
 * USD is the decided currency (2026-09-15) and every organisation is set to it. This
 * constant is the fallback for an unreadable value, NOT an assumption that callers can
 * skip passing one: the column is NOT NULL with a CHECK, so in practice nothing reaches it.
 */
export const DEFAULT_CURRENCY: OrganisationCurrency = 'USD'

/**
 * Narrows whatever the database handed back to a currency we can render.
 *
 * Deliberately total: a client's pipeline must not fail to render because a currency
 * string is unexpected. The database CHECK is the real guard; this is the type boundary.
 */
export function toOrganisationCurrency(value: string | null | undefined): OrganisationCurrency {
  return value === 'GBP' || value === 'EUR' || value === 'USD' ? value : DEFAULT_CURRENCY
}

/**
 * "$45k" at or above a thousand, "$450" below it.
 *
 * The thousands rounding is the shape both cards already used and is kept deliberately:
 * this change is about WHICH symbol, not about how precise the number is.
 */
export function formatCurrency(value: number, currency: OrganisationCurrency): string {
  const symbol = CURRENCY_SYMBOLS[currency]
  if (value >= 1000) return `${symbol}${(value / 1000).toFixed(0)}k`
  return `${symbol}${value}`
}
