import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/nextjs'

// Keys containing any of these patterns are redacted before the event leaves the process.
// MargenticOS routinely handles prospect PII and client strategy documents — none of it
// should reach a third-party observability service in clear form.
const SENSITIVE_PATTERNS = [
  'email',
  'api_key',
  'token',
  'secret',
  'dsn',
  'linkedin',
  'icp',
  'intake',
]

function isKeySensitive(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_PATTERNS.some(p => lower.includes(p))
}

function redactObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactObject)
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = isKeySensitive(k) ? '[REDACTED]' : redactObject(v)
  }
  return result
}

function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  if (!b.data) return b
  return { ...b, data: redactObject(b.data) as Breadcrumb['data'] }
}

export function scrubSensitiveData(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (event.request?.data) {
    event.request.data = redactObject(event.request.data) as typeof event.request.data
  }
  if (event.extra) {
    event.extra = redactObject(event.extra) as typeof event.extra
  }
  if (event.contexts) {
    event.contexts = redactObject(event.contexts) as typeof event.contexts
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)
  }
  return event
}
