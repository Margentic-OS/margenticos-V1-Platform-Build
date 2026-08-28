import { getAppUrl } from './app-url'

// The link an email uses to send someone to one specific strategy document.
//
// EVERY document notification pointed at /dashboard/documents, which does not exist and
// returns 404. Three of them were confirmed doing it on 2026-08-27, across ICP, positioning
// and tone of voice. The route has never existed: the real one is
// /dashboard/strategy/[type], where the (client) route group in the path is invisible in
// the URL. Nobody clicked the button, so the notification loop had never been walked end to
// end, dogfooding included.
//
// So the URL is built HERE, once, with a test, rather than interpolated into each template.
// A string literal in a template is exactly what nobody checks.

export type StrategyDocumentType = 'icp' | 'positioning' | 'tov' | 'messaging'

const VALID: readonly StrategyDocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

export function isStrategyDocumentType(value: string): value is StrategyDocumentType {
  return (VALID as readonly string[]).includes(value)
}

/**
 * @param docType   which document to open
 * @param clientId  the organisation to view, for an OPERATOR recipient only. Pass null for
 *                  a client recipient.
 *
 * The ?client= param is honoured by resolveViewingOrg only when the signed-in user's role
 * is 'operator'. A client user is always pinned to their own organisation and the param is
 * ignored, so adding it to a client's link is noise at best and, on a forwarded email,
 * looks like a link to somebody else's data. It is omitted rather than passed and ignored.
 */
export function strategyDocumentUrl(
  docType: string,
  clientId: string | null = null,
): string {
  const base = `${getAppUrl()}/dashboard/strategy/${docType}`
  return clientId ? `${base}?client=${encodeURIComponent(clientId)}` : base
}
