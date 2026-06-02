export function appendClientParam(
  href: string,
  clientId: string | null | undefined,
): string {
  if (!clientId) return href
  return href.includes('?') ? `${href}&client=${clientId}` : `${href}?client=${clientId}`
}
