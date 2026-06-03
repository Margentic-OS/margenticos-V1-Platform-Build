export function appendClientParam(
  href: string,
  clientId: string | null | undefined,
): string {
  if (!clientId) return href
  return href.includes('?') ? `${href}&client=${clientId}` : `${href}?client=${clientId}`
}

// Builds a ?-prefixed query string preserving ?client= and setting ?segment=.
// Primary segment (is_default) omits the segment param so the canonical URL
// for the default view has no segment= in it.
export function buildStrategyParams({
  clientParam,
  segmentId,
  isDefaultSegment,
}: {
  clientParam: string | null
  segmentId: string
  isDefaultSegment: boolean
}): string {
  const params = new URLSearchParams()
  if (clientParam) params.set('client', clientParam)
  if (!isDefaultSegment) params.set('segment', segmentId)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}
