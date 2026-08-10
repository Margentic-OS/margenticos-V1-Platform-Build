// Normalize URL: ensure it has a protocol and is absolute
export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null

  const trimmed = url.trim()
  if (!trimmed) return null

  // If already has protocol, return as-is
  if (/^https?:\/\//.test(trimmed)) return trimmed

  // Otherwise prepend https://
  return `https://${trimmed}`
}
